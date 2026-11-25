import { describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import type { Auth } from "firebase-admin/auth";
import { FirestoreNoteRepository } from "./repository.js";
import * as Y from "yjs";
import { replaceSummaryField, readSummaryDocument } from "@notach/shared";

function setupRepository() {
  const records = new Map<string, Record<string, unknown>>([
    [
      "notes/note-1",
      {
        ownerUid: "owner",
        revision: 5,
        content: "Original note content",
        summaryCount: 1,
      },
    ],
    [
      "notes/note-1/summaries/base",
      {
        noteId: "note-1",
        sourceRevision: 1,
        shortText: "Old summary",
        keyPoints: ["Fact"],
        suggestedTags: ["original"],
        suggestedTitle: "Stored title",
        modelId: "trusted-model",
        promptVersion: "trusted-prompt",
        durationMs: 987,
        generationStatus: "ready",
        isUserEdited: true,
        createdAt: new Date(),
      },
    ],
  ]);
  interface Reference {
    path: string;
    id: string;
    parent: { parent: Reference | null };
    collection: (name: string) => { doc: (id?: string) => Reference };
    get: () => Promise<{
      id: string;
      exists: boolean;
      data: () => Record<string, unknown> | undefined;
    }>;
  }
  const snapshot = (path: string) => ({
    id: path.split("/").at(-1)!,
    exists: records.has(path),
    data: () => records.get(path),
  });
  const reference = (path: string): Reference => ({
    path,
    id: path.split("/").at(-1)!,
    get parent() {
      const parts = path.split("/");
      return {
        parent:
          parts.length > 2 ? reference(parts.slice(0, -2).join("/")) : null,
      };
    },
    collection: (name) => collection(`${path}/${name}`),
    get: async () => snapshot(path),
  });
  const collection = (path: string) => ({
    doc: (id = "new-summary") => reference(`${path}/${id}`),
  });
  const create = vi.fn((ref: Reference, value: Record<string, unknown>) => {
    records.set(ref.path, value);
  });
  const update = vi.fn((ref: Reference, value: Record<string, unknown>) => {
    records.set(ref.path, { ...records.get(ref.path), ...value });
  });
  const set = vi.fn((ref: Reference, value: Record<string, unknown>) => {
    records.set(ref.path, value);
  });
  const transaction = {
    get: async (ref: Reference) => snapshot(ref.path),
    create,
    update,
    set,
  };
  const db = {
    collection,
    runTransaction: async <T>(
      callback: (tx: typeof transaction) => Promise<T>,
    ) => callback(transaction),
  };
  return {
    repo: new FirestoreNoteRepository(db as unknown as Firestore, {} as Auth),
    records,
    create,
    update,
    set,
  };
}

const content = {
  shortText: "Edited historical summary",
  keyPoints: ["Edited fact"],
  tags: ["new-tag"],
  suggestedTitle: "Edited suggested title",
};
const metadata = {
  actorUid: "owner",
  modelId: "forged-model",
  promptVersion: "forged-prompt",
  durationMs: 0,
};

describe("summary repository", () => {
  it("merges concurrent summary edits while preserving original output and provenance", async () => {
    const { repo, records } = setupRepository();
    const initial = await repo.editSummary("note-1", "base", "owner");
    const first = new Y.Doc();
    const second = new Y.Doc();
    for (const document of [first, second])
      Y.applyUpdate(document, Buffer.from(initial.state, "base64"));
    replaceSummaryField(first, "shortText", "Concurrent old summary");
    replaceSummaryField(second, "pointsText", "Fact\nAnother fact ");
    await repo.editSummary(
      "note-1",
      "base",
      "owner",
      Buffer.from(Y.encodeStateAsUpdate(first)).toString("base64"),
    );
    const merged = await repo.editSummary(
      "note-1",
      "base",
      "owner",
      Buffer.from(Y.encodeStateAsUpdate(second)).toString("base64"),
    );
    const final = new Y.Doc();
    Y.applyUpdate(final, Buffer.from(merged.state, "base64"));
    expect(readSummaryDocument(final)).toMatchObject({
      shortText: "Concurrent old summary",
      pointsText: "Fact\nAnother fact ",
    });
    expect(records.get("notes/note-1/summaries/base")).toMatchObject({
      shortText: "Concurrent old summary",
      keyPoints: ["Fact", "Another fact"],
      sourceRevision: 1,
      modelId: "trusted-model",
      originalContent: { shortText: "Old summary" },
    });
    expect(records.get("notes/note-1")?.content).toBe("Original note content");
    first.destroy();
    second.destroy();
    final.destroy();
  });

  it("persists incomplete drafts without replacing the last valid summary", async () => {
    const { repo, records } = setupRepository();
    const initial = await repo.editSummary("note-1", "base", "owner");
    const document = new Y.Doc();
    Y.applyUpdate(document, Buffer.from(initial.state, "base64"));
    replaceSummaryField(document, "shortText", "");
    const draft = await repo.editSummary(
      "note-1",
      "base",
      "owner",
      Buffer.from(Y.encodeStateAsUpdate(document)).toString("base64"),
    );
    expect(draft.valid).toBe(false);
    expect(records.get("notes/note-1/summaries/base")?.shortText).toBe(
      "Old summary",
    );
    expect(
      records.get("notes/note-1/summaries/base/collaboration/current")?.valid,
    ).toBe(false);
    document.destroy();
  });

  it("checks editor permission inside transactions and rejects cancelled generation commits", async () => {
    const { repo, records, create } = setupRepository();
    records.set("noteShares/note-1_viewer", {
      role: "viewer",
      status: "accepted",
    });
    await expect(
      repo.editSummary("note-1", "base", "viewer"),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await repo.beginGeneration("note-1", "job", "owner");
    await expect(
      repo.beginGeneration("note-1", "duplicate", "owner"),
    ).rejects.toMatchObject({
      code: "GENERATION_IN_PROGRESS",
    });
    await expect(
      repo.cancelGeneration("note-1", "job", "viewer"),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await repo.cancelGeneration("note-1", "job", "owner");
    await expect(
      repo.saveSummary("note-1", 5, content, {
        ...metadata,
        generationRequestId: "job",
        isUserEdited: false,
      }),
    ).rejects.toMatchObject({ code: "AI_CANCELLED" });
    expect(create).not.toHaveBeenCalled();
    await repo.beginGeneration("note-1", "new-job", "owner");
    await repo.finishGeneration("note-1", "job", "failed");
    expect(records.get("notes/note-1/summaryActivity/current")).toMatchObject({
      requestId: "new-job",
      status: "generating",
    });
    await repo.cancelGeneration("note-1", "early-cancel", "owner");
    await expect(
      repo.beginGeneration("note-1", "early-cancel", "owner"),
    ).rejects.toMatchObject({
      code: "AI_CANCELLED",
    });
    await repo.finishGeneration("note-1", "new-job", "ready");
    expect(await repo.cancelGeneration("note-1", "new-job", "owner")).toBe(
      false,
    );
  });
  it("loads a stored title and treats an absent summary as missing", async () => {
    const { repo } = setupRepository();
    expect(await repo.getSummary("note-1", "base")).toMatchObject({
      id: "base",
      noteId: "note-1",
      suggestedTitle: "Stored title",
      modelId: "trusted-model",
    });
    expect(await repo.getSummary("note-1", "missing")).toBeUndefined();
  });

  it("permits an old source revision only with a verified base and rederives trusted provenance atomically", async () => {
    const { repo, records } = setupRepository();
    const saved = await repo.saveSummary("note-1", 1, content, {
      ...metadata,
      baseSummaryId: "base",
    });
    expect(saved).toMatchObject({
      sourceRevision: 1,
      modelId: "trusted-model",
      promptVersion: "trusted-prompt",
      durationMs: 987,
      baseSummaryId: "base",
      suggestedTitle: "Edited suggested title",
      isUserEdited: true,
    });
    expect(records.get("notes/note-1/summaries/new-summary")).toMatchObject({
      sourceRevision: 1,
      suggestedTitle: "Edited suggested title",
      baseSummaryId: "base",
    });
    expect(records.get("notes/note-1")?.content).toBe("Original note content");
    expect(records.get("notes/note-1/summaries/base")?.shortText).toBe(
      "Old summary",
    );
  });

  it("rejects stale unsaved content and mismatched or foreign bases before writing", async () => {
    const { repo, records, create } = setupRepository();
    await expect(
      repo.saveSummary("note-1", 1, content, metadata),
    ).rejects.toThrow("NOTE_REVISION_CONFLICT");
    await expect(
      repo.saveSummary("note-1", 2, content, {
        ...metadata,
        baseSummaryId: "base",
      }),
    ).rejects.toThrow("SUMMARY_SOURCE_MISMATCH");
    records.set("notes/note-1/summaries/base", {
      ...records.get("notes/note-1/summaries/base"),
      noteId: "note-2",
    });
    await expect(
      repo.saveSummary("note-1", 1, content, {
        ...metadata,
        baseSummaryId: "base",
      }),
    ).rejects.toThrow("SUMMARY_NOT_FOUND");
    expect(create).not.toHaveBeenCalled();
  });

  it("rechecks a historical copy author's ACL inside the write transaction", async () => {
    const { repo, records, create } = setupRepository();
    const share = {
      noteId: "note-1",
      participantUid: "editor",
      role: "editor",
      status: "accepted",
    };
    records.set("noteShares/note-1_editor", share);
    expect(await repo.getRole("note-1", "editor")).toBe("editor");
    records.set("noteShares/note-1_editor", { ...share, status: "revoked" });
    await expect(
      repo.saveSummary("note-1", 1, content, {
        ...metadata,
        actorUid: "editor",
        baseSummaryId: "base",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(create).not.toHaveBeenCalled();
    records.set("noteShares/note-1_editor", share);
    const saved = await repo.saveSummary("note-1", 1, content, {
      ...metadata,
      actorUid: "editor",
      baseSummaryId: "base",
    });
    expect(saved).toMatchObject({
      modelId: "trusted-model",
      sourceRevision: 1,
    });
    expect(saved).not.toHaveProperty("actorUid");
  });

  it("rechecks feedback access transactionally and permits accepted viewers", async () => {
    const { repo, records, set } = setupRepository();
    const share = {
      noteId: "note-1",
      participantUid: "viewer",
      role: "viewer",
      status: "accepted",
    };
    const feedback = { rating: 4, comment: "Useful", accepted: true };
    records.set("noteShares/note-1_viewer", share);
    expect(await repo.getRole("note-1", "viewer")).toBe("viewer");
    records.set("noteShares/note-1_viewer", { ...share, status: "revoked" });
    await expect(
      repo.saveFeedback("note-1", "base", "viewer", feedback),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(set).not.toHaveBeenCalled();
    records.set("noteShares/note-1_viewer", share);
    await repo.saveFeedback("note-1", "base", "viewer", feedback);
    const saved = records.get("notes/note-1/summaries/base/feedback/viewer")!;
    expect(saved).toMatchObject({ authorUid: "viewer", ...feedback });
    await repo.saveFeedback("note-1", "base", "viewer", {
      ...feedback,
      rating: 5,
    });
    expect(
      records.get("notes/note-1/summaries/base/feedback/viewer"),
    ).toMatchObject({
      authorUid: "viewer",
      rating: 5,
      createdAt: saved.createdAt,
    });
  });

  it("rejects forged share identities and feedback without its real parent", async () => {
    const { repo, records, set } = setupRepository();
    records.set("noteShares/note-1_viewer", {
      noteId: "another-note",
      participantUid: "viewer",
      role: "viewer",
      status: "accepted",
    });
    expect(await repo.getRole("note-1", "viewer")).toBeNull();
    const feedback = { rating: 3, comment: "", accepted: false };
    await expect(
      repo.saveFeedback("note-1", "base", "viewer", feedback),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      repo.saveFeedback("note-1", "missing", "owner", feedback),
    ).rejects.toThrow("SUMMARY_NOT_FOUND");
    records.set("notes/note-1/summaries/base", {
      ...records.get("notes/note-1/summaries/base"),
      noteId: "another-note",
    });
    await expect(
      repo.saveFeedback("note-1", "base", "owner", feedback),
    ).rejects.toThrow("SUMMARY_NOT_FOUND");
    records.delete("notes/note-1");
    await expect(
      repo.saveFeedback("note-1", "base", "owner", feedback),
    ).rejects.toMatchObject({ code: "NOTE_NOT_FOUND" });
    expect(set).not.toHaveBeenCalled();
  });
});
