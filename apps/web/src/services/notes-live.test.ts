import { beforeEach, describe, expect, it, vi } from "vitest";

interface Constraint {
  kind: string;
  field?: string;
  operator?: string;
  value?: unknown;
}
interface Source {
  kind: string;
  path: string;
  constraints?: Constraint[];
}
interface Subscription {
  source: Source;
  next: (snapshot: unknown) => void;
  error: (reason: unknown) => void;
  stop: ReturnType<typeof vi.fn>;
}

const firestore = vi.hoisted(() => ({ subscriptions: [] as Subscription[] }));
vi.mock("firebase/firestore", () => ({
  addDoc: vi.fn(),
  getDoc: vi.fn(),
  getDocs: vi.fn(),
  runTransaction: vi.fn(),
  serverTimestamp: vi.fn(),
  collection: (_db: unknown, path: string) => ({ kind: "collection", path }),
  doc: (_db: unknown, ...parts: string[]) => ({
    kind: "document",
    path: parts.join("/"),
  }),
  query: (source: Source, ...constraints: Constraint[]) => ({
    ...source,
    kind: "query",
    constraints,
  }),
  where: (field: string, operator: string, value: unknown) => ({
    kind: "where",
    field,
    operator,
    value,
  }),
  orderBy: (field: string, value: string) => ({
    kind: "orderBy",
    field,
    value,
  }),
  limit: (value: number) => ({ kind: "limit", value }),
  onSnapshot: (
    source: Source,
    next: Subscription["next"],
    error: Subscription["error"],
  ) => {
    const stop = vi.fn();
    firestore.subscriptions.push({ source, next, error, stop });
    return stop;
  },
}));
vi.mock("../firebase.js", () => ({ db: {}, auth: {} }));

import { watchOwnNotes, watchSharedNotes } from "./notes.js";

function subscription(path: string): Subscription {
  const found = firestore.subscriptions
    .filter((item) => item.source.path === path)
    .at(-1);
  if (!found) throw new Error(`Missing subscription: ${path}`);
  return found;
}

function note(
  id: string,
  overrides: Record<string, unknown> = {},
  exists = true,
) {
  return {
    id,
    exists: () => exists,
    data: () => ({
      ownerUid: "owner",
      title: id,
      titleNormalized: id,
      content: "Original content",
      tags: [],
      revision: 1,
      status: "active",
      favorite: false,
      summaryCount: 0,
      createdAt: { toDate: () => new Date(1000) },
      updatedAt: { toDate: () => new Date(1000) },
      ...overrides,
    }),
  };
}

function shares(...items: Array<[string, "viewer" | "editor"]>) {
  return {
    docs: items.map(([noteId, role]) => ({ data: () => ({ noteId, role }) })),
  };
}

beforeEach(() => {
  firestore.subscriptions = [];
});

describe("live note lists", () => {
  it("receives new grants, role changes, edits, archival, and deletion without reloading", () => {
    const onNotes = vi.fn();
    const onError = vi.fn();
    const stop = watchSharedNotes("participant", onNotes, onError);
    const shareListener = subscription("noteShares");
    expect(shareListener.source.constraints).toEqual([
      {
        kind: "where",
        field: "participantUid",
        operator: "==",
        value: "participant",
      },
      { kind: "where", field: "status", operator: "==", value: "accepted" },
      { kind: "limit", value: 100 },
    ]);
    shareListener.next(shares(["note-a", "viewer"]));
    expect(onNotes).not.toHaveBeenCalled();
    const noteListener = subscription("notes/note-a");
    noteListener.next(note("note-a"));
    expect(onNotes).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "note-a", sharedRole: "viewer" }),
    ]);
    shareListener.next(shares(["note-a", "editor"]));
    expect(onNotes).toHaveBeenLastCalledWith([
      expect.objectContaining({ sharedRole: "editor" }),
    ]);
    expect(
      firestore.subscriptions.filter(
        (item) => item.source.path === "notes/note-a",
      ),
    ).toHaveLength(1);
    noteListener.next(
      note("note-a", {
        title: "Edited title",
        content: "Edited content",
        tags: ["new"],
      }),
    );
    expect(onNotes).toHaveBeenLastCalledWith([
      expect.objectContaining({
        title: "Edited title",
        content: "Edited content",
        tags: ["new"],
      }),
    ]);
    noteListener.next(note("note-a", { status: "archived" }));
    expect(onNotes).toHaveBeenLastCalledWith([]);
    noteListener.next(note("note-a"));
    expect(onNotes).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "note-a" }),
    ]);
    noteListener.next(note("note-a", {}, false));
    expect(onNotes).toHaveBeenLastCalledWith([]);
    expect(onError).not.toHaveBeenCalled();
    stop();
  });

  it("removes revoked access immediately and ignores stale callbacks after regrant and cleanup", () => {
    const onNotes = vi.fn();
    const stop = watchSharedNotes("participant", onNotes, vi.fn());
    const shareListener = subscription("noteShares");
    shareListener.next(shares(["note-a", "editor"]));
    const original = subscription("notes/note-a");
    original.next(note("note-a"));
    shareListener.next(shares());
    expect(original.stop).toHaveBeenCalledOnce();
    expect(onNotes).toHaveBeenLastCalledWith([]);
    original.next(note("note-a", { title: "Stale private content" }));
    expect(onNotes).toHaveBeenLastCalledWith([]);
    shareListener.next(shares(["note-a", "viewer"]));
    const regranted = subscription("notes/note-a");
    expect(regranted).not.toBe(original);
    regranted.next(note("note-a", { title: "Regranted" }));
    expect(onNotes).toHaveBeenLastCalledWith([
      expect.objectContaining({ title: "Regranted", sharedRole: "viewer" }),
    ]);
    const calls = onNotes.mock.calls.length;
    original.next(note("note-a", { title: "Old queued snapshot" }));
    expect(onNotes).toHaveBeenCalledTimes(calls);
    stop();
    expect(shareListener.stop).toHaveBeenCalledOnce();
    expect(regranted.stop).toHaveBeenCalledOnce();
    regranted.next(note("note-a"));
    shareListener.next(shares(["late-note", "viewer"]));
    expect(onNotes).toHaveBeenCalledTimes(calls);
    expect(
      firestore.subscriptions.some(
        (item) => item.source.path === "notes/late-note",
      ),
    ).toBe(false);
  });

  it("drops denied documents before the share query catches up and closes on query failure", () => {
    const onNotes = vi.fn();
    const onError = vi.fn();
    const stop = watchSharedNotes("participant", onNotes, onError);
    const shareListener = subscription("noteShares");
    shareListener.next(shares(["note-a", "editor"], ["note-b", "viewer"]));
    const first = subscription("notes/note-a");
    const second = subscription("notes/note-b");
    first.next(note("note-a"));
    expect(onNotes).not.toHaveBeenCalled();
    second.next(
      note("note-b", { updatedAt: { toDate: () => new Date(2000) } }),
    );
    expect(onNotes).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "note-b" }),
      expect.objectContaining({ id: "note-a" }),
    ]);
    first.error({ code: "permission-denied" });
    expect(onNotes).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "note-b" }),
    ]);
    expect(onError).not.toHaveBeenCalled();
    first.next(note("note-a"));
    expect(onNotes).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "note-b" }),
    ]);
    const failure = { code: "unavailable" };
    shareListener.error(failure);
    expect(onNotes).toHaveBeenLastCalledWith([]);
    expect(onError).toHaveBeenLastCalledWith(failure);
    const calls = onNotes.mock.calls.length;
    second.next(note("note-b"));
    shareListener.next(shares(["note-a", "viewer"]));
    expect(onNotes).toHaveBeenCalledTimes(calls);
    stop();
  });

  it("subscribes to bounded own-note queries and ignores emissions after stopping", () => {
    const onNotes = vi.fn();
    const onError = vi.fn();
    const stop = watchOwnNotes("owner", onNotes, onError, "archived", "study");
    const listener = subscription("notes");
    expect(listener.source.constraints).toEqual([
      { kind: "where", field: "ownerUid", operator: "==", value: "owner" },
      { kind: "where", field: "status", operator: "==", value: "archived" },
      {
        kind: "where",
        field: "tags",
        operator: "array-contains",
        value: "study",
      },
      { kind: "orderBy", field: "updatedAt", value: "desc" },
      { kind: "limit", value: 100 },
    ]);
    listener.next({ docs: [note("own", { status: "archived" })] });
    expect(onNotes).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "own", status: "archived" }),
    ]);
    stop();
    listener.next({ docs: [] });
    listener.error({ code: "permission-denied" });
    expect(onNotes).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });
});
