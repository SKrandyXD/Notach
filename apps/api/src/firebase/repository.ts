import {
  FieldValue,
  Timestamp,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import * as Y from "yjs";
import {
  seedSummaryDocument,
  readSummaryDocument,
  validateSummaryDraft,
} from "@notach/shared";
import { AppError } from "../domain.js";
import { getAuth, type Auth } from "firebase-admin/auth";
import type {
  NoteRepository,
  NoteDocument,
  SavedSummary,
  ShareRecord,
  SummarySaveMetadata,
} from "../domain.js";
import type { SummaryContent } from "@notach/shared";

function asDate(value: unknown): Date {
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  return new Date();
}

function asSummary(id: string, value: Record<string, unknown>): SavedSummary {
  return {
    id,
    noteId: value.noteId as string,
    sourceRevision: value.sourceRevision as number,
    shortText: value.shortText as string,
    keyPoints: value.keyPoints as string[],
    tags: value.suggestedTags as string[],
    suggestedTags: value.suggestedTags as string[],
    modelId: value.modelId as string,
    promptVersion: value.promptVersion as string,
    durationMs: value.durationMs as number,
    generationStatus: "ready",
    isUserEdited: value.isUserEdited as boolean,
    createdAt: asDate(value.createdAt),
    ...(typeof value.suggestedTitle === "string"
      ? { suggestedTitle: value.suggestedTitle }
      : {}),
    ...(typeof value.baseSummaryId === "string"
      ? { baseSummaryId: value.baseSummaryId }
      : {}),
  };
}

export class FirestoreNoteRepository implements NoteRepository {
  constructor(
    private readonly db: Firestore,
    private readonly auth: Auth = getAuth(),
  ) {}

  private async assertEditor(
    transaction: Transaction,
    noteId: string,
    uid: string,
  ) {
    return this.assertAccess(transaction, noteId, uid, false);
  }

  private async assertAccess(
    transaction: Transaction,
    noteId: string,
    uid: string,
    allowViewer: boolean,
  ) {
    const note = await transaction.get(this.db.collection("notes").doc(noteId));
    if (!note.exists)
      throw new AppError(404, "NOTE_NOT_FOUND", "Нотатку не знайдено.");
    if (note.data()?.ownerUid === uid) return note;
    const share = await transaction.get(
      this.db.collection("noteShares").doc(`${noteId}_${uid}`),
    );
    if (
      share.data()?.noteId !== noteId ||
      share.data()?.participantUid !== uid ||
      share.data()?.status !== "accepted" ||
      (share.data()?.role !== "editor" &&
        !(allowViewer && share.data()?.role === "viewer"))
    ) {
      throw new AppError(403, "FORBIDDEN", "Недостатньо прав.");
    }
    return note;
  }

  async beginGeneration(noteId: string, requestId: string, uid: string) {
    const ref = this.db
      .collection("notes")
      .doc(noteId)
      .collection("summaryActivity")
      .doc("current");
    await this.db.runTransaction(async (tx) => {
      await this.assertEditor(tx, noteId, uid);
      const cancelled = await tx.get(
        this.db
          .collection("notes")
          .doc(noteId)
          .collection("generationCancellations")
          .doc(requestId),
      );
      if (cancelled.exists)
        throw new AppError(409, "AI_CANCELLED", "Генерацію скасовано.");
      const current = await tx.get(ref);
      if (
        current.data()?.status === "generating" &&
        (current.data()?.expiresAt as Timestamp).toMillis() > Date.now()
      ) {
        throw new AppError(
          409,
          "GENERATION_IN_PROGRESS",
          "Узагальнення вже виконується.",
        );
      }
      tx.set(ref, {
        requestId,
        status: "generating",
        startedBy: uid,
        updatedAt: Timestamp.now(),
        expiresAt: Timestamp.fromMillis(Date.now() + 600_000),
      });
    });
  }

  async finishGeneration(
    noteId: string,
    requestId: string,
    status: "ready" | "failed" | "cancelled",
    summaryId?: string,
  ) {
    const ref = this.db
      .collection("notes")
      .doc(noteId)
      .collection("summaryActivity")
      .doc("current");
    await this.db.runTransaction(async (tx) => {
      const current = await tx.get(ref);
      if (
        current.data()?.requestId !== requestId ||
        current.data()?.status !== "generating"
      )
        return;
      tx.update(ref, {
        status,
        updatedAt: Timestamp.now(),
        ...(summaryId ? { summaryId } : {}),
      });
    });
  }

  async cancelGeneration(noteId: string, requestId: string, uid: string) {
    const ref = this.db
      .collection("notes")
      .doc(noteId)
      .collection("summaryActivity")
      .doc("current");
    return this.db.runTransaction(async (tx) => {
      await this.assertEditor(tx, noteId, uid);
      const current = await tx.get(ref);
      if (
        current.data()?.requestId === requestId &&
        current.data()?.status === "ready"
      )
        return false;
      // A cancellation can arrive before the generation finishes its access checks.
      tx.set(
        this.db
          .collection("notes")
          .doc(noteId)
          .collection("generationCancellations")
          .doc(requestId),
        { cancelledBy: uid, createdAt: Timestamp.now() },
      );
      if (
        current.data()?.requestId === requestId ||
        current.data()?.status !== "generating"
      )
        tx.set(ref, {
          requestId,
          status: "cancelled",
          updatedAt: Timestamp.now(),
        });
      return true;
    });
  }

  watchGeneration(noteId: string, requestId: string, onCancel: () => void) {
    return this.db
      .collection("notes")
      .doc(noteId)
      .collection("summaryActivity")
      .doc("current")
      .onSnapshot((snapshot) => {
        if (
          snapshot.data()?.requestId !== requestId ||
          snapshot.data()?.status === "cancelled"
        )
          onCancel();
      }, onCancel);
  }

  async editSummary(
    noteId: string,
    summaryId: string,
    uid: string,
    state?: string,
  ) {
    const summaryRef = this.db
      .collection("notes")
      .doc(noteId)
      .collection("summaries")
      .doc(summaryId);
    const ref = summaryRef.collection("collaboration").doc("current");
    return this.db.runTransaction(async (tx) => {
      await this.assertEditor(tx, noteId, uid);
      const [summary, current] = await Promise.all([
        tx.get(summaryRef),
        tx.get(ref),
      ]);
      if (!summary.exists)
        throw new AppError(
          404,
          "SUMMARY_NOT_FOUND",
          "Узагальнення не знайдено.",
        );
      const value = asSummary(summary.id, summary.data()!);
      const document = current.exists
        ? new Y.Doc()
        : seedSummaryDocument(value);
      try {
        if (current.exists)
          Y.applyUpdate(
            document,
            Buffer.from(current.data()!.state as string, "base64"),
          );
        if (state) Y.applyUpdate(document, Buffer.from(state, "base64"));
        const draft = readSummaryDocument(document);
        if (Object.values(draft).some((text) => text.length > 16000))
          throw new Error("SUMMARY_DRAFT_TOO_LARGE");
        const encoded = Buffer.from(Y.encodeStateAsUpdate(document)).toString(
          "base64",
        );
        if (encoded.length > 500000) throw new Error("SUMMARY_DRAFT_TOO_LARGE");
        const parsed = validateSummaryDraft(draft);
        tx.set(ref, {
          state: encoded,
          valid: parsed.success,
          updatedAt: Timestamp.now(),
        });
        if (state && parsed.success) {
          tx.update(summaryRef, {
            originalContent: summary.data()!.originalContent ?? {
              shortText: value.shortText,
              keyPoints: value.keyPoints,
              tags: value.tags,
              ...(value.suggestedTitle
                ? { suggestedTitle: value.suggestedTitle }
                : {}),
            },
            shortText: parsed.data.shortText,
            keyPoints: parsed.data.keyPoints,
            suggestedTags: parsed.data.tags,
            suggestedTitle: parsed.data.suggestedTitle ?? FieldValue.delete(),
            isUserEdited: true,
            updatedAt: Timestamp.now(),
          });
        }
        return { state: encoded, valid: parsed.success };
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "Некоректний стан узагальнення.",
        );
      } finally {
        document.destroy();
      }
    });
  }

  async getNote(noteId: string): Promise<NoteDocument | undefined> {
    const snapshot = await this.db.collection("notes").doc(noteId).get();
    return snapshot.exists ? (snapshot.data() as NoteDocument) : undefined;
  }

  async getRole(noteId: string, uid: string) {
    const note = await this.db.collection("notes").doc(noteId).get();
    if (!note.exists) return null;
    if (note.data()?.ownerUid === uid) return "owner" as const;
    const share = await this.db
      .collection("noteShares")
      .doc(`${noteId}_${uid}`)
      .get();
    if (
      !share.exists ||
      share.data()?.noteId !== noteId ||
      share.data()?.participantUid !== uid ||
      share.data()?.status !== "accepted"
    )
      return null;
    const role = share.data()?.role;
    return role === "editor" || role === "viewer" ? role : null;
  }

  async getSummary(
    noteId: string,
    summaryId: string,
  ): Promise<SavedSummary | undefined> {
    const snapshot = await this.db
      .collection("notes")
      .doc(noteId)
      .collection("summaries")
      .doc(summaryId)
      .get();
    return snapshot.exists
      ? asSummary(snapshot.id, snapshot.data()!)
      : undefined;
  }

  async saveSummary(
    noteId: string,
    sourceRevision: number,
    content: SummaryContent,
    metadata: SummarySaveMetadata,
  ): Promise<SavedSummary> {
    const noteRef = this.db.collection("notes").doc(noteId);
    const summaryRef = noteRef.collection("summaries").doc();
    const createdAt = new Date();
    const saved = await this.db.runTransaction(async (transaction) => {
      const note = await this.assertEditor(
        transaction,
        noteId,
        metadata.actorUid,
      );
      const activityRef = noteRef.collection("summaryActivity").doc("current");
      if (metadata.generationRequestId) {
        const activity = await transaction.get(activityRef);
        if (
          activity.data()?.requestId !== metadata.generationRequestId ||
          activity.data()?.startedBy !== metadata.actorUid ||
          activity.data()?.status !== "generating"
        )
          throw new AppError(409, "AI_CANCELLED", "Генерацію скасовано.");
      }
      let trustedMetadata = metadata;
      if (metadata.baseSummaryId) {
        const base = await transaction.get(
          noteRef.collection("summaries").doc(metadata.baseSummaryId),
        );
        if (!base.exists || base.data()?.noteId !== noteId)
          throw new Error("SUMMARY_NOT_FOUND");
        if (base.data()?.sourceRevision !== sourceRevision)
          throw new Error("SUMMARY_SOURCE_MISMATCH");
        trustedMetadata = {
          ...metadata,
          modelId: base.data()!.modelId as string,
          promptVersion: base.data()!.promptVersion as string,
          durationMs: base.data()!.durationMs as number,
          baseSummaryId: metadata.baseSummaryId,
        };
      } else if (note.data()?.revision !== sourceRevision) {
        throw new AppError(
          409,
          "NOTE_REVISION_CONFLICT",
          "NOTE_REVISION_CONFLICT",
        );
      }
      const doc = {
        noteId,
        sourceRevision,
        shortText: content.shortText,
        keyPoints: content.keyPoints,
        suggestedTags: content.tags,
        ...(content.suggestedTitle !== undefined
          ? { suggestedTitle: content.suggestedTitle }
          : {}),
        modelId: trustedMetadata.modelId,
        promptVersion: trustedMetadata.promptVersion,
        durationMs: trustedMetadata.durationMs,
        ...(trustedMetadata.baseSummaryId
          ? { baseSummaryId: trustedMetadata.baseSummaryId }
          : {}),
        generationStatus: "ready" as const,
        isUserEdited: metadata.isUserEdited ?? true,
        createdAt: Timestamp.fromDate(createdAt),
      };
      transaction.create(summaryRef, doc);
      if (metadata.generationRequestId) {
        transaction.update(activityRef, {
          status: "ready",
          summaryId: summaryRef.id,
          updatedAt: Timestamp.now(),
        });
      }
      transaction.update(noteRef, { summaryCount: FieldValue.increment(1) });
      return { id: summaryRef.id, ...doc, tags: doc.suggestedTags, createdAt };
    });
    return saved;
  }

  async listSummaries(noteId: string, limit: number): Promise<SavedSummary[]> {
    const snapshot = await this.db
      .collection("notes")
      .doc(noteId)
      .collection("summaries")
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();
    return snapshot.docs.map((item) => asSummary(item.id, item.data()));
  }

  async saveFeedback(
    noteId: string,
    summaryId: string,
    uid: string,
    feedback: { rating: number; comment: string; accepted: boolean },
  ): Promise<void> {
    const ref = this.db
      .collection("notes")
      .doc(noteId)
      .collection("summaries")
      .doc(summaryId)
      .collection("feedback")
      .doc(uid);
    await this.db.runTransaction(async (transaction) => {
      await this.assertAccess(transaction, noteId, uid, true);
      const [summary, current] = await Promise.all([
        transaction.get(ref.parent.parent!),
        transaction.get(ref),
      ]);
      if (!summary.exists || summary.data()?.noteId !== noteId)
        throw new Error("SUMMARY_NOT_FOUND");
      const now = Timestamp.now();
      transaction.set(
        ref,
        {
          authorUid: uid,
          rating: feedback.rating,
          comment: feedback.comment,
          accepted: feedback.accepted,
          createdAt: current.exists ? current.data()?.createdAt : now,
          updatedAt: now,
        },
        { merge: true },
      );
    });
  }

  async findUserByEmail(
    email: string,
  ): Promise<{ uid: string; email: string } | undefined> {
    try {
      const user = await this.auth.getUserByEmail(email);
      return user.email ? { uid: user.uid, email: user.email } : undefined;
    } catch (error) {
      if ((error as { code?: string }).code === "auth/user-not-found")
        return undefined;
      throw error;
    }
  }

  async upsertShare(
    noteId: string,
    participantUid: string,
    share: Omit<ShareRecord, "createdAt" | "acceptedAt">,
  ): Promise<void> {
    const ref = this.db
      .collection("noteShares")
      .doc(`${noteId}_${participantUid}`);
    await this.db.runTransaction(async (transaction) => {
      const existing = await transaction.get(ref);
      const now = Timestamp.now();
      transaction.set(ref, {
        ...share,
        createdAt: existing.data()?.createdAt ?? now,
        acceptedAt: now,
        status: "accepted",
      });
    });
  }

  async deleteShare(noteId: string, participantUid: string): Promise<void> {
    await this.db
      .collection("noteShares")
      .doc(`${noteId}_${participantUid}`)
      .delete();
  }

  async listShares(noteId: string): Promise<ShareRecord[]> {
    const snapshot = await this.db
      .collection("noteShares")
      .where("noteId", "==", noteId)
      .where("status", "==", "accepted")
      .limit(50)
      .get();
    return snapshot.docs.map(
      (doc) =>
        ({
          ...doc.data(),
          createdAt: asDate(doc.data().createdAt),
          acceptedAt: doc.data().acceptedAt
            ? asDate(doc.data().acceptedAt)
            : null,
        }) as ShareRecord,
    );
  }

  async deleteNoteCascade(noteId: string): Promise<void> {
    const shares = this.db
      .collection("noteShares")
      .where("noteId", "==", noteId);
    let page = await shares.limit(450).get();
    while (!page.empty) {
      const batch = this.db.batch();
      page.docs.forEach((document) => batch.delete(document.ref));
      await batch.commit();
      if (page.size < 450) break;
      page = await shares
        .startAfter(page.docs[page.docs.length - 1]!)
        .limit(450)
        .get();
    }
    await this.db.recursiveDelete(this.db.collection("notes").doc(noteId));
  }
}
