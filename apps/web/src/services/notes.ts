import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  where,
  type DocumentData,
  type QueryConstraint,
  type Unsubscribe,
} from "firebase/firestore";
import {
  normalizeTags,
  normalizeTitle,
  type Note,
  type NoteStatus,
} from "@notach/shared";
import { auth, db } from "../firebase.js";
import { LocalizedError, translate } from "../i18n/core.js";

export class NoteRevisionConflict extends Error {
  readonly code = "NOTE_REVISION_CONFLICT";
  constructor() {
    super("NOTE_REVISION_CONFLICT");
  }
}

function toDate(value: unknown): Date {
  return value && typeof (value as { toDate?: unknown }).toDate === "function"
    ? (value as { toDate: () => Date }).toDate()
    : new Date();
}

function toNote(id: string, data: DocumentData): Note {
  return {
    id,
    ownerUid: data.ownerUid as string,
    title: data.title as string,
    titleNormalized: data.titleNormalized as string,
    content: data.content as string,
    tags: data.tags as string[],
    revision: data.revision as number,
    status: data.status as NoteStatus,
    summaryCount: data.summaryCount as number | undefined,
    createdAt: toDate(data.createdAt),
    updatedAt: toDate(data.updatedAt),
    favorite: data.favorite === true,
  } as Note;
}

export async function loadNotes(
  uid: string,
  status: NoteStatus = "active",
  tag?: string,
): Promise<Note[]> {
  const constraints: QueryConstraint[] = [
    where("ownerUid", "==", uid),
    where("status", "==", status),
  ];
  if (tag) constraints.push(where("tags", "array-contains", tag));
  constraints.push(orderBy("updatedAt", "desc"), limit(100));
  const snapshot = await getDocs(
    query(collection(db, "notes"), ...constraints),
  );
  return snapshot.docs.map((item) => toNote(item.id, item.data()));
}

export async function loadSharedNotes(uid: string): Promise<Note[]> {
  const shares = await getDocs(
    query(
      collection(db, "noteShares"),
      where("participantUid", "==", uid),
      where("status", "==", "accepted"),
      limit(100),
    ),
  );
  const notes = await Promise.all(
    shares.docs.map(async (share) => {
      const noteId = share.data().noteId as string;
      const note = await getDoc(doc(db, "notes", noteId));
      return note.exists() && note.data().status === "active"
        ? toNote(note.id, note.data())
        : null;
    }),
  );
  return notes
    .filter((note): note is Note => note !== null)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

export interface SharedNote extends Note {
  sharedRole: "viewer" | "editor";
}

export function watchOwnNotes(
  uid: string,
  onNotes: (notes: Note[]) => void,
  onError: (reason: unknown) => void,
  status: NoteStatus = "active",
  tag?: string,
): Unsubscribe {
  const constraints: QueryConstraint[] = [
    where("ownerUid", "==", uid),
    where("status", "==", status),
  ];
  if (tag) constraints.push(where("tags", "array-contains", tag));
  constraints.push(orderBy("updatedAt", "desc"), limit(100));
  let active = true;
  const stop = onSnapshot(
    query(collection(db, "notes"), ...constraints),
    (snapshot) => {
      if (active)
        onNotes(snapshot.docs.map((item) => toNote(item.id, item.data())));
    },
    (reason) => {
      if (!active) return;
      active = false;
      onNotes([]);
      onError(reason);
    },
  );
  return () => {
    active = false;
    stop();
  };
}

export function watchSharedNotes(
  uid: string,
  onNotes: (notes: SharedNote[]) => void,
  onError: (reason: unknown) => void,
): Unsubscribe {
  interface Entry {
    role: SharedNote["sharedRole"];
    note?: Note;
    ready: boolean;
    failed: boolean;
    stop: Unsubscribe;
  }
  const entries = new Map<string, Entry>();
  let active = true;
  let hasEmitted = false;
  const emit = () => {
    if (!active) return;
    // Keep the initial loading state until every permitted document has answered.
    if (!hasEmitted && [...entries.values()].some((entry) => !entry.ready))
      return;
    hasEmitted = true;
    const notes = [...entries.values()].flatMap((entry) =>
      entry.note ? [{ ...entry.note, sharedRole: entry.role }] : [],
    );
    notes.sort(
      (a, b) =>
        b.updatedAt.getTime() - a.updatedAt.getTime() ||
        a.id.localeCompare(b.id),
    );
    onNotes(notes);
  };
  const remove = (noteId: string) => {
    const entry = entries.get(noteId);
    entries.delete(noteId);
    entry?.stop();
  };
  const stopShares = onSnapshot(
    query(
      collection(db, "noteShares"),
      where("participantUid", "==", uid),
      where("status", "==", "accepted"),
      limit(100),
    ),
    (snapshot) => {
      if (!active) return;
      const allowed = new Map<string, SharedNote["sharedRole"]>();
      for (const share of snapshot.docs) {
        const data = share.data();
        if (
          typeof data.noteId === "string" &&
          data.noteId.length > 0 &&
          !data.noteId.includes("/") &&
          (data.role === "viewer" || data.role === "editor")
        ) {
          allowed.set(data.noteId, data.role);
        }
      }
      for (const noteId of entries.keys()) {
        if (!allowed.has(noteId)) remove(noteId);
      }
      for (const [noteId, role] of allowed) {
        const current = entries.get(noteId);
        if (current && !current.failed) {
          current.role = role;
          continue;
        }
        if (current) remove(noteId);
        const entry: Entry = {
          role,
          ready: false,
          failed: false,
          stop: () => {},
        };
        entries.set(noteId, entry);
        entry.stop = onSnapshot(
          doc(db, "notes", noteId),
          (note) => {
            if (!active || entry.failed || entries.get(noteId) !== entry)
              return;
            entry.ready = true;
            entry.note =
              note.exists() && note.data().status === "active"
                ? toNote(note.id, note.data())
                : undefined;
            emit();
          },
          (reason) => {
            if (!active || entries.get(noteId) !== entry) return;
            entry.ready = true;
            entry.failed = true;
            entry.note = undefined;
            emit();
            // Revocation may reach the document listener before the share query.
            // Remove its content immediately without presenting an expected ACL change as an error.
            if ((reason as { code?: string }).code !== "permission-denied")
              onError(reason);
          },
        );
      }
      emit();
    },
    (reason) => {
      if (!active) return;
      for (const noteId of entries.keys()) remove(noteId);
      active = false;
      onNotes([]);
      onError(reason);
    },
  );
  return () => {
    active = false;
    stopShares();
    for (const noteId of entries.keys()) remove(noteId);
  };
}

export async function getNote(noteId: string): Promise<Note | null> {
  const snapshot = await getDoc(doc(db, "notes", noteId));
  return snapshot.exists() ? toNote(snapshot.id, snapshot.data()) : null;
}

export async function createNote(
  uid: string,
  input: { title: string; content: string; tags: string[] },
): Promise<Note> {
  const title = input.title.trim() || translate("uk", "notes.untitled");
  const reference = await addDoc(collection(db, "notes"), {
    ownerUid: uid,
    title,
    titleNormalized: normalizeTitle(title),
    content: input.content,
    tags: normalizeTags(input.tags),
    revision: 1,
    status: "active",
    summaryCount: 0,
    favorite: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  const created = await getDoc(reference);
  return toNote(created.id, created.data()!);
}

export async function saveNote(
  note: Note,
  expectedRevision: number,
  input: { title: string; content: string; tags: string[]; favorite?: boolean },
): Promise<Note> {
  const ref = doc(db, "notes", note.id);
  await runTransaction(db, async (transaction) => {
    const current = await transaction.get(ref);
    if (!current.exists() || current.data().revision !== expectedRevision)
      throw new NoteRevisionConflict();
    const currentData = current.data();
    const contentChanged = input.content !== currentData.content;
    const title = input.title.trim() || translate("uk", "notes.untitled");
    transaction.update(ref, {
      title,
      titleNormalized: normalizeTitle(title),
      content: input.content,
      tags: normalizeTags(input.tags),
      revision: contentChanged ? expectedRevision + 1 : expectedRevision,
      favorite: input.favorite ?? currentData.favorite ?? false,
      updatedAt: serverTimestamp(),
    });
  });
  const result = await getDoc(ref);
  if (!result.exists()) throw new LocalizedError("errors.noteNotFound");
  return toNote(result.id, result.data());
}

export async function setNoteStatus(
  note: Note,
  status: NoteStatus,
): Promise<void> {
  await runTransaction(db, async (transaction) => {
    const ref = doc(db, "notes", note.id);
    const current = await transaction.get(ref);
    if (!current.exists() || current.data().revision !== note.revision)
      throw new NoteRevisionConflict();
    transaction.update(ref, { status, updatedAt: serverTimestamp() });
  });
}

export async function updateNoteFields(
  noteId: string,
  fields: { title?: string; tags?: string[]; favorite?: boolean },
  options: { mergeTags?: boolean; baseTags?: string[] } = {},
): Promise<Note> {
  const reference = doc(db, "notes", noteId);
  await runTransaction(db, async (transaction) => {
    const current = await transaction.get(reference);
    if (!current.exists()) throw new LocalizedError("errors.noteNotFound");
    const changes: DocumentData = { updatedAt: serverTimestamp() };
    if (fields.title !== undefined) {
      const title = fields.title.trim() || translate("uk", "notes.untitled");
      changes.title = title;
      changes.titleNormalized = normalizeTitle(title);
    }
    if (fields.tags !== undefined) {
      const removed = new Set(
        options.baseTags?.filter((tag) => !fields.tags!.includes(tag)),
      );
      const added = options.baseTags
        ? fields.tags.filter((tag) => !options.baseTags!.includes(tag))
        : fields.tags;
      changes.tags = normalizeTags([
        ...(options.baseTags
          ? (current.data().tags as string[]).filter((tag) => !removed.has(tag))
          : options.mergeTags
            ? (current.data().tags as string[])
            : []),
        ...added.map((tag) => tag.slice(0, 30)),
      ]);
    }
    if (fields.favorite !== undefined) changes.favorite = fields.favorite;
    transaction.update(reference, changes);
  });
  const saved = await getDoc(reference);
  if (!saved.exists()) throw new LocalizedError("errors.noteNotFound");
  return toNote(saved.id, saved.data());
}

export function currentUid(): string | undefined {
  return auth.currentUser?.uid;
}
