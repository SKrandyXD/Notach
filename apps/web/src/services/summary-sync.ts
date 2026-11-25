import * as Y from "yjs";
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  type Firestore,
} from "firebase/firestore";
import {
  readSummaryDocument,
  replaceSummaryField,
  type Summary,
  type SummaryDraftFields,
  type SummaryField,
} from "@notach/shared";
import { apiRequest } from "./api.js";

const encode = (value: Uint8Array) =>
  btoa(Array.from(value, (byte) => String.fromCharCode(byte)).join(""));
const decode = (value: string) =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

export interface GenerationActivity {
  requestId: string;
  status: "generating" | "cancelled" | "ready" | "failed";
  expiresAt?: { toMillis(): number };
}

export function watchSummaryHistory(
  db: Firestore,
  noteId: string,
  onHistory: (items: Summary[]) => void,
  onError: (reason: unknown) => void,
) {
  return onSnapshot(
    query(
      collection(db, "notes", noteId, "summaries"),
      orderBy("createdAt", "desc"),
      limit(50),
    ),
    (snapshot) => {
      onHistory(
        snapshot.docs.map((item) => {
          const data = item.data();
          return {
            ...data,
            id: item.id,
            tags: data.suggestedTags,
            createdAt: data.createdAt.toDate(),
          } as Summary;
        }),
      );
    },
    onError,
  );
}

export function watchGenerationActivity(
  db: Firestore,
  noteId: string,
  onActivity: (activity: GenerationActivity | null) => void,
  onError: (reason: unknown) => void,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = onSnapshot(
    doc(db, "notes", noteId, "summaryActivity", "current"),
    (snapshot) => {
      clearTimeout(timer);
      const activity = snapshot.exists()
        ? (snapshot.data() as GenerationActivity)
        : null;
      onActivity(activity);
      if (activity?.status === "generating" && activity.expiresAt) {
        timer = setTimeout(
          () => onActivity({ ...activity, status: "failed" }),
          Math.max(0, activity.expiresAt.toMillis() - Date.now()),
        );
      }
    },
    onError,
  );
  return () => {
    clearTimeout(timer);
    stop();
  };
}

export interface SummarySelection {
  field: SummaryField;
  start: number;
  end: number;
}
export interface SummarySessionOptions {
  onDraft: (fields: SummaryDraftFields, selection?: SummarySelection) => void;
  onStatus: (
    status: "connecting" | "saving" | "saved" | "invalid" | "error",
  ) => void;
  onError: (reason: unknown) => void;
  getSelection?: () => SummarySelection | undefined;
}

export class CollaborativeSummarySession {
  private document = new Y.Doc();
  private stop?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private pending = 0;
  private persisted = 0;
  private ready = false;
  private destroyed = false;
  private running?: Promise<void>;
  private readonly path: string;

  constructor(
    private db: Firestore,
    private noteId: string,
    private summaryId: string,
    private canEdit: boolean,
    private options: SummarySessionOptions,
  ) {
    this.path = `/api/notes/${noteId}/summaries/${summaryId}/collaboration`;
  }

  async start() {
    this.stop?.();
    this.options.onStatus("connecting");
    if (this.canEdit) {
      const data = await apiRequest<{ state: string; valid: boolean }>(
        this.path,
        {
          method: "POST",
          body: "{}",
        },
      );
      if (this.destroyed) return;
      this.apply(data.state);
      this.ready = true;
      this.options.onStatus(
        this.pending > this.persisted
          ? "saving"
          : data.valid
            ? "saved"
            : "invalid",
      );
    }
    if (this.destroyed) return;
    this.stop = onSnapshot(
      doc(
        this.db,
        "notes",
        this.noteId,
        "summaries",
        this.summaryId,
        "collaboration",
        "current",
      ),
      (snapshot) => {
        if (this.destroyed || !snapshot.exists()) return;
        this.apply(snapshot.data().state as string);
      },
      (reason) => this.fail(reason),
    );
  }

  async retry() {
    try {
      if (this.ready) await this.flush();
      await this.start();
    } catch (reason) {
      this.fail(reason);
      throw reason;
    }
  }

  private apply(state: string) {
    const selection = this.options.getSelection?.();
    const text = selection ? this.document.getText(selection.field) : undefined;
    const start =
      text && selection
        ? Y.createRelativePositionFromTypeIndex(text, selection.start)
        : undefined;
    const end =
      text && selection
        ? Y.createRelativePositionFromTypeIndex(text, selection.end)
        : undefined;
    Y.applyUpdate(this.document, decode(state));
    const restoredStart =
      start &&
      Y.createAbsolutePositionFromRelativePosition(start, this.document);
    const restoredEnd =
      end && Y.createAbsolutePositionFromRelativePosition(end, this.document);
    this.options.onDraft(
      readSummaryDocument(this.document),
      selection && restoredStart && restoredEnd
        ? {
            field: selection.field,
            start: restoredStart.index,
            end: restoredEnd.index,
          }
        : undefined,
    );
  }

  update(field: SummaryField, value: string) {
    if (!this.canEdit || !this.ready || this.destroyed)
      throw new Error("SUMMARY_NOT_READY");
    replaceSummaryField(this.document, field, value);
    this.pending++;
    this.options.onStatus("saving");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush().catch((reason) => this.fail(reason));
    }, 300);
  }

  flush(): Promise<void> {
    if (this.running) return this.running;
    clearTimeout(this.timer);
    this.running = (async () => {
      while (this.persisted < this.pending) {
        const version = this.pending;
        const data = await apiRequest<{ state: string; valid: boolean }>(
          this.path,
          {
            method: "POST",
            body: JSON.stringify({
              state: encode(Y.encodeStateAsUpdate(this.document)),
            }),
          },
        );
        this.persisted = version;
        if (!this.destroyed) {
          this.apply(data.state);
          this.options.onStatus(data.valid ? "saved" : "invalid");
        }
      }
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private fail(reason: unknown) {
    if (this.destroyed) return;
    this.options.onStatus("error");
    this.options.onError(reason);
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.timer);
    this.stop?.();
    // Persist captured pending edits when navigating away; callbacks remain suppressed.
    void this.flush()
      .catch(() => undefined)
      .finally(() => this.document.destroy());
  }
}
