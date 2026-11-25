import {
  doc,
  getDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  type DocumentData,
  type Firestore,
  type Unsubscribe,
} from "firebase/firestore";
import * as Y from "yjs";
import type { Note } from "@notach/shared";

export const MAX_COLLABORATION_STATE_LENGTH = 700000;
const MAX_CONTENT_LENGTH = 50000;
const LOCAL_ORIGIN = "notach-local";
const REMOTE_ORIGIN = "notach-remote";

export type CollaborationStatus =
  "connecting" | "saved" | "unsaved" | "saving" | "error";
export interface TextSelection {
  start: number;
  end: number;
}
export interface CollaborationOptions {
  onNote?: (note: Note) => void;
  onContent?: (content: string, selection?: TextSelection) => void;
  onStatus?: (status: CollaborationStatus) => void;
  onError?: (error: unknown) => void;
  getSelection?: () => TextSelection | undefined;
  debounceMs?: number;
}

export class CollaborationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "CollaborationError";
  }
}

function date(value: unknown): Date {
  return value && typeof (value as { toDate?: unknown }).toDate === "function"
    ? (value as { toDate: () => Date }).toDate()
    : value instanceof Date
      ? value
      : new Date();
}

function noteFromData(id: string, value: DocumentData): Note {
  return {
    id,
    ownerUid: value.ownerUid as string,
    title: value.title as string,
    titleNormalized: value.titleNormalized as string,
    content: value.content as string,
    tags: value.tags as string[],
    revision: value.revision as number,
    status: value.status as Note["status"],
    favorite: value.favorite === true,
    summaryCount: value.summaryCount as number | undefined,
    createdAt: date(value.createdAt),
    updatedAt: date(value.updatedAt),
  };
}

function encodeState(document: Y.Doc): string {
  const bytes = Y.encodeStateAsUpdate(document);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  const encoded = btoa(binary);
  if (encoded.length > MAX_COLLABORATION_STATE_LENGTH)
    throw new CollaborationError("COLLABORATION_STATE_TOO_LARGE");
  return encoded;
}

function decodeState(value: unknown): Uint8Array {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > MAX_COLLABORATION_STATE_LENGTH
  ) {
    throw new CollaborationError("COLLABORATION_INVALID_STATE");
  }
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new CollaborationError("COLLABORATION_INVALID_STATE");
  }
}

function applyEncodedState(document: Y.Doc, value: unknown) {
  try {
    Y.applyUpdate(document, decodeState(value), REMOTE_ORIGIN);
  } catch (error) {
    if (error instanceof CollaborationError) throw error;
    throw new CollaborationError("COLLABORATION_INVALID_STATE");
  }
}

/** Change only the differing span, so independent edits retain their CRDT positions. */
function replaceText(text: Y.Text, next: string) {
  const previous = text.toString();
  if (previous === next) return;
  let prefix = 0;
  while (
    prefix < previous.length &&
    prefix < next.length &&
    previous[prefix] === next[prefix]
  )
    prefix += 1;
  const splitsSurrogate = (value: string, boundary: number) =>
    boundary > 0 &&
    boundary < value.length &&
    /[\uD800-\uDBFF]/u.test(value[boundary - 1]!) &&
    /[\uDC00-\uDFFF]/u.test(value[boundary]!);
  if (splitsSurrogate(previous, prefix) || splitsSurrogate(next, prefix))
    prefix -= 1;
  let suffix = 0;
  while (
    suffix < previous.length - prefix &&
    suffix < next.length - prefix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  )
    suffix += 1;
  if (
    splitsSurrogate(previous, previous.length - suffix) ||
    splitsSurrogate(next, next.length - suffix)
  )
    suffix -= 1;
  const removed = previous.length - prefix - suffix;
  if (removed) text.delete(prefix, removed);
  const inserted = next.slice(prefix, next.length - suffix);
  if (inserted) text.insert(prefix, inserted);
}

/** One editable note session. Metadata stays canonical; content merges through Y.Text. */
export class CollaborativeNoteSession {
  private readonly document = new Y.Doc();
  private readonly text = this.document.getText("content");
  private readonly noteRef;
  private readonly stateRef;
  private readonly unsubscribers: Unsubscribe[] = [];
  private startPromise?: Promise<Note>;
  private flushPromise?: Promise<Note>;
  private timer?: ReturnType<typeof setTimeout>;
  private ready = false;
  private destroyed = false;
  private hasSharedState = false;
  private localVersion = 0;
  private persistedVersion = 0;
  private latestNote?: Note;

  constructor(
    private readonly db: Firestore,
    private readonly noteId: string,
    private readonly uid: string,
    private readonly canEdit: boolean,
    private readonly options: CollaborationOptions = {},
  ) {
    this.noteRef = doc(db, "notes", noteId);
    this.stateRef = doc(db, "notes", noteId, "collaboration", "current");
  }

  start(): Promise<Note> {
    if (this.destroyed)
      return Promise.reject(new CollaborationError("COLLABORATION_DESTROYED"));
    this.startPromise ??= this.connect().catch((error) => {
      this.fail(error);
      throw error;
    });
    return this.startPromise;
  }

  private async connect(): Promise<Note> {
    this.status("connecting");
    const initial = await runTransaction(this.db, async (transaction) => {
      const [noteSnapshot, stateSnapshot] = await Promise.all([
        transaction.get(this.noteRef),
        transaction.get(this.stateRef),
      ]);
      if (!noteSnapshot.exists())
        throw new CollaborationError("COLLABORATION_NOTE_NOT_FOUND");
      const note = noteFromData(noteSnapshot.id, noteSnapshot.data());
      let state = stateSnapshot.exists()
        ? (stateSnapshot.data().state as unknown)
        : undefined;
      const shared = new Y.Doc();
      try {
        if (state !== undefined) applyEncodedState(shared, state);
        const text = shared.getText("content");
        const needsRepair =
          !stateSnapshot.exists() ||
          stateSnapshot.data().noteRevision !== note.revision ||
          text.toString() !== note.content;
        if (this.canEdit && needsRepair) {
          shared.transact(() => replaceText(text, note.content), REMOTE_ORIGIN);
          state = encodeState(shared);
          if (this.destroyed)
            throw new CollaborationError("COLLABORATION_DESTROYED");
          transaction.set(this.stateRef, {
            state,
            noteRevision: note.revision,
            updatedBy: this.uid,
            updatedAt: serverTimestamp(),
          });
        }
        return {
          note,
          state: this.canEdit || !needsRepair ? state : undefined,
        };
      } finally {
        shared.destroy();
      }
    });
    if (this.destroyed) throw new CollaborationError("COLLABORATION_DESTROYED");
    this.latestNote = initial.note;
    if (initial.state !== undefined) this.applyRemote(initial.state);
    else this.emitContent(initial.note.content);
    this.ready = true;
    this.emitNote(initial.note);
    this.unsubscribers.push(
      onSnapshot(
        this.noteRef,
        (snapshot) => {
          if (this.destroyed) return;
          if (!snapshot.exists()) {
            this.fail(new CollaborationError("COLLABORATION_NOTE_NOT_FOUND"));
            return;
          }
          const note = noteFromData(snapshot.id, snapshot.data());
          this.emitNote(note);
          if (!this.hasSharedState) this.emitContent(note.content);
        },
        (error) => this.fail(error),
      ),
    );
    this.unsubscribers.push(
      onSnapshot(
        this.stateRef,
        (snapshot) => {
          if (this.destroyed || !snapshot.exists()) return;
          const state = snapshot.data();
          // A legacy content save may precede its CRDT repair; show canonical text until repaired.
          if (
            typeof state.noteRevision !== "number" ||
            state.noteRevision < (this.latestNote?.revision ?? 0)
          )
            return;
          try {
            this.applyRemote(state.state);
          } catch (error) {
            this.fail(error);
          }
        },
        (error) => this.fail(error),
      ),
    );
    this.status("saved");
    return initial.note;
  }

  updateText(next: string): void {
    this.assertReady();
    if (!this.canEdit) throw new CollaborationError("COLLABORATION_READ_ONLY");
    if (next.length > MAX_CONTENT_LENGTH)
      throw new CollaborationError("COLLABORATION_CONTENT_TOO_LARGE");
    if (next === this.text.toString()) return;
    this.document.transact(() => replaceText(this.text, next), LOCAL_ORIGIN);
    this.localVersion += 1;
    this.emitContent(this.text.toString());
    this.status("unsaved");
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => undefined);
    }, this.options.debounceMs ?? 300);
  }

  flush(): Promise<Note> {
    try {
      this.assertReady();
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.flushPromise) {
      this.flushPromise = this.flushPending()
        .catch((error) => {
          this.fail(error);
          throw error;
        })
        .finally(() => {
          this.flushPromise = undefined;
        });
    }
    return this.flushPromise;
  }

  private async flushPending(): Promise<Note> {
    for (;;) {
      while (this.persistedVersion < this.localVersion) {
        this.status("saving");
        const capturedVersion = this.localVersion;
        const capturedState = Y.encodeStateAsUpdate(this.document);
        const merged = await this.retryStaleRevision((recordRevision) =>
          runTransaction(this.db, async (transaction) => {
            const [noteSnapshot, stateSnapshot] = await Promise.all([
              transaction.get(this.noteRef),
              transaction.get(this.stateRef),
            ]);
            if (!noteSnapshot.exists())
              throw new CollaborationError("COLLABORATION_NOTE_NOT_FOUND");
            const note = noteFromData(noteSnapshot.id, noteSnapshot.data());
            recordRevision(note.revision);
            const remote = new Y.Doc();
            try {
              if (stateSnapshot.exists())
                applyEncodedState(remote, stateSnapshot.data().state);
              const text = remote.getText("content");
              if (
                !stateSnapshot.exists() ||
                stateSnapshot.data().noteRevision !== note.revision ||
                text.toString() !== note.content
              ) {
                remote.transact(
                  () => replaceText(text, note.content),
                  REMOTE_ORIGIN,
                );
              }
              Y.applyUpdate(remote, capturedState, LOCAL_ORIGIN);
              const content = text.toString();
              if (content.length > MAX_CONTENT_LENGTH)
                throw new CollaborationError("COLLABORATION_CONTENT_TOO_LARGE");
              const state = encodeState(remote);
              const changed = content !== note.content;
              const revision = changed ? note.revision + 1 : note.revision;
              if (this.destroyed)
                throw new CollaborationError("COLLABORATION_DESTROYED");
              if (changed)
                transaction.update(this.noteRef, {
                  content,
                  revision,
                  updatedAt: serverTimestamp(),
                });
              transaction.set(this.stateRef, {
                state,
                noteRevision: revision,
                updatedBy: this.uid,
                updatedAt: serverTimestamp(),
              });
              return state;
            } finally {
              remote.destroy();
            }
          }),
        );
        if (this.destroyed)
          throw new CollaborationError("COLLABORATION_DESTROYED");
        this.applyRemote(merged);
        this.persistedVersion = capturedVersion;
      }
      const snapshot = await getDoc(this.noteRef);
      if (!snapshot.exists())
        throw new CollaborationError("COLLABORATION_NOTE_NOT_FOUND");
      if (this.destroyed)
        throw new CollaborationError("COLLABORATION_DESTROYED");
      const note = noteFromData(snapshot.id, snapshot.data());
      this.emitNote(note);
      // Edits typed while the final read was pending also belong to this flush.
      if (this.persistedVersion === this.localVersion) {
        this.status("saved");
        return note;
      }
    }
  }

  private applyRemote(state: unknown) {
    // Validate in isolation before touching local edits; a malformed update must not partially mutate this document.
    const validation = new Y.Doc();
    try {
      applyEncodedState(validation, state);
      if (validation.getText("content").length > MAX_CONTENT_LENGTH)
        throw new CollaborationError("COLLABORATION_CONTENT_TOO_LARGE");
    } finally {
      validation.destroy();
    }
    const selection = this.options.getSelection?.();
    const relative = selection
      ? {
          start: Y.createRelativePositionFromTypeIndex(
            this.text,
            Math.min(this.text.length, Math.max(0, selection.start)),
          ),
          end: Y.createRelativePositionFromTypeIndex(
            this.text,
            Math.min(this.text.length, Math.max(0, selection.end)),
          ),
        }
      : undefined;
    applyEncodedState(this.document, state);
    this.hasSharedState = true;
    const start =
      relative &&
      Y.createAbsolutePositionFromRelativePosition(
        relative.start,
        this.document,
      );
    const end =
      relative &&
      Y.createAbsolutePositionFromRelativePosition(relative.end, this.document);
    const restored =
      start && end ? { start: start.index, end: end.index } : undefined;
    this.emitContent(this.text.toString(), restored);
  }

  private async retryStaleRevision<T>(
    operation: (recordRevision: (revision: number) => void) => Promise<T>,
  ): Promise<T> {
    let conflictRetries = 0;
    for (;;) {
      let attemptedRevision: number | undefined;
      try {
        return await operation((revision) => {
          attemptedRevision = revision;
        });
      } catch (error) {
        if (this.destroyed)
          throw new CollaborationError("COLLABORATION_DESTROYED");
        if (
          (error as { code?: string } | null)?.code !== "permission-denied" ||
          attemptedRevision === undefined ||
          conflictRetries >= 3
        )
          throw error;
        // Rules can reject a stale revision before the backend reports a retryable transaction precondition.
        // Retry only after a fresh authorized read proves another complete collaboration commit advanced it.
        let advanced = false;
        try {
          advanced = await runTransaction(this.db, async (transaction) => {
            const [note, state] = await Promise.all([
              transaction.get(this.noteRef),
              transaction.get(this.stateRef),
            ]);
            const revision: unknown = note.data()?.revision;
            return (
              note.exists() &&
              state.exists() &&
              typeof revision === "number" &&
              revision > attemptedRevision! &&
              state.data().noteRevision === revision
            );
          });
        } catch {
          throw error;
        }
        if (!advanced) throw error;
        conflictRetries += 1;
      }
    }
  }

  private assertReady() {
    if (this.destroyed) throw new CollaborationError("COLLABORATION_DESTROYED");
    if (!this.ready) throw new CollaborationError("COLLABORATION_NOT_READY");
  }

  private status(status: CollaborationStatus) {
    if (!this.destroyed) this.options.onStatus?.(status);
  }
  private emitContent(content: string, selection?: TextSelection) {
    if (!this.destroyed) this.options.onContent?.(content, selection);
  }
  private emitNote(note: Note) {
    this.latestNote = note;
    if (!this.destroyed) this.options.onNote?.(note);
  }
  private fail(error: unknown) {
    if (!this.destroyed) {
      this.status("error");
      this.options.onError?.(error);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
    this.document.destroy();
  }
}
