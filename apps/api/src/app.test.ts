import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";
import { HourlyBudget, MemoryBudgetStore } from "./services/ai-budget.js";
import type {
  NoteRepository,
  NoteDocument,
  SavedSummary,
  ShareRecord,
  SummarizationPort,
} from "./domain.js";
import { resolveLocalServices, type SummaryContent } from "@notach/shared";
import { SummarizationError } from "./domain.js";

function setup(
  options: {
    revision?: number;
    budgetUsd?: number;
    provider?: "mock" | "gemini";
    now?: () => number;
    summarize?: SummarizationPort["summarize"];
  } = {},
) {
  const note: NoteDocument = {
    ownerUid: "user-a",
    title: "Test",
    titleNormalized: "test",
    content: "Перший факт. Другий факт.",
    tags: [],
    revision: options.revision ?? 1,
    status: "active",
  };
  const summaries: SavedSummary[] = [];
  const repo: NoteRepository = {
    beginGeneration: vi.fn(async () => undefined),
    finishGeneration: vi.fn(async () => undefined),
    cancelGeneration: vi.fn(async () => true),
    watchGeneration: vi.fn(() => () => undefined),
    editSummary: vi.fn(async () => ({ state: "AAA=", valid: true })),
    getNote: vi.fn(async (id) => (id === "note-1" ? note : undefined)),
    getRole: vi.fn(async (id, uid) =>
      id === "note-1" && uid === "user-a" ? "owner" : null,
    ),
    getSummary: vi.fn(async (noteId, summaryId) =>
      summaries.find((item) => item.noteId === noteId && item.id === summaryId),
    ),
    saveSummary: vi.fn(async (noteId, sourceRevision, content, meta) => {
      const saved: SavedSummary = {
        ...content,
        id: `sum-${summaries.length + 1}`,
        noteId,
        sourceRevision,
        suggestedTags: content.tags,
        ...meta,
        generationStatus: "ready",
        isUserEdited: meta.isUserEdited ?? true,
        createdAt: new Date(),
      };
      summaries.push(saved);
      return saved;
    }),
    listSummaries: vi.fn(async () => summaries),
    saveFeedback: vi.fn(async () => undefined),
    findUserByEmail: vi.fn(async (email) =>
      email === "b@example.com" ? { uid: "user-b", email } : undefined,
    ),
    upsertShare: vi.fn(async () => undefined),
    deleteShare: vi.fn(async () => undefined),
    listShares: vi.fn(async () => [] as ShareRecord[]),
    deleteNoteCascade: vi.fn(async () => undefined),
  };
  const summary: SummaryContent = {
    shortText: "Стислий зміст.",
    keyPoints: ["Перший факт."],
    tags: ["нотатки"],
  };
  const summarize = vi.fn(options.summarize ?? (async () => summary));
  const summarizer: SummarizationPort = { summarize };
  const budget = new HourlyBudget(
    new MemoryBudgetStore(),
    options.budgetUsd ?? 0.1,
    options.now,
  );
  const app = createApp({
    verifyToken: async (token) =>
      token === "valid-a"
        ? { uid: "user-a" }
        : token === "valid-b"
          ? { uid: "user-b" }
          : Promise.reject(new Error("invalid")),
    repository: repo,
    summarizer,
    budget,
    now: options.now,
    config: {
      corsOrigins: [resolveLocalServices().webOrigin],
      maxNoteChars: 50000,
      modelId: "gemini-3.5-flash-lite",
      promptVersion: "notach-summary-v1",
      provider: options.provider ?? "mock",
    },
  });
  return { app, repo, note, summary, summarize, summaries, budget };
}

const auth = (token = "valid-a") => ({ Authorization: `Bearer ${token}` });

describe("Notach API", () => {
  it("requires authentication and reports persistent hourly budget without spending", async () => {
    let time = 1000;
    const { app, budget, summarize } = setup({ now: () => time });
    expect((await request(app).get("/api/summarization/limits")).status).toBe(
      401,
    );
    const reservation = await budget.reserve("user-a", 20_000_000);
    await reservation.settle({
      spentNanoUsd: 10_000_000,
      inputTokens: 100,
      outputTokens: 20,
      thinkingTokens: 5,
      unreportedCalls: 0,
    });
    const response = await request(app)
      .get("/api/summarization/limits")
      .set(auth());
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.data.budget).toMatchObject({
      limitUsd: 0.1,
      spentUsd: 0.01,
      reservedUsd: 0,
      remainingUsd: 0.09,
      inputTokens: 100,
      outputTokens: 20,
      thinkingTokens: 5,
      resetsAt: new Date(3_600_000).toISOString(),
      scope: "user",
    });
    expect(response.body.data.pricing).toBeNull();
    const other = await request(app)
      .get("/api/summarization/limits")
      .set(auth("valid-b"));
    expect(other.body.data.budget.spentUsd).toBe(0);
    time = 3_600_000;
    const reset = await request(app)
      .get("/api/summarization/limits")
      .set(auth());
    expect(reset.body.data.budget.spentUsd).toBe(0);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("rejects unpriced selections and reports the chosen model's token prices", async () => {
    const { app } = setup({ provider: "gemini" });
    const response = await request(app)
      .get("/api/summarization/limits?modelId=gemini-3.1-flash-lite")
      .set(auth());
    expect(response.body.data.pricing).toMatchObject({
      modelId: "gemini-3.1-flash-lite",
      inputUsdPerMillionTokens: 0.25,
      outputUsdPerMillionTokens: 1.5,
    });
    expect(
      (
        await request(app)
          .get("/api/summarization/limits?modelId=unknown")
          .set(auth())
      ).status,
    ).toBe(400);
  });
  it("automatically persists each successful generation with trusted AI provenance", async () => {
    const { app, summaries } = setup();
    const response = await request(app)
      .post("/api/summarize")
      .set(auth())
      .send({
        noteId: "note-1",
        revision: 1,
        requestId: randomUUID(),
        options: {},
      });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      saved: true,
      summaryId: "sum-1",
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.isUserEdited).toBe(false);
  });

  it("aborts generation when an authorized collaborator cancels and discards a late provider result", async () => {
    let complete!: (content: SummaryContent) => void;
    let signal: AbortSignal | undefined;
    const { app, repo, summary, summarize } = setup({
      summarize: async (_text, _options, context) => {
        signal = context.signal;
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    });
    vi.mocked(repo.getRole).mockImplementation(async (_id, uid) =>
      uid === "user-a" ? "owner" : "editor",
    );
    const requestId = randomUUID();
    const pending = request(app)
      .post("/api/summarize")
      .set(auth())
      .send({ noteId: "note-1", revision: 1, requestId, options: {} })
      .then((response) => response);
    await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(1));
    const cancelled = await request(app)
      .post(`/api/notes/note-1/generation/${requestId}/cancel`)
      .set(auth("valid-b"))
      .send({});
    expect(cancelled.status).toBe(200);
    expect(signal?.aborted).toBe(true);
    complete(summary);
    expect((await pending).body.error.code).toBe("AI_CANCELLED");
    expect(repo.saveSummary).not.toHaveBeenCalled();
    const limits = await request(app)
      .get("/api/summarization/limits")
      .set(auth());
    expect(limits.body.data.budget.spentUsd).toBe(0);
  });

  it("denies viewers and outsiders generation, cancellation, and summary editing", async () => {
    const { app, repo } = setup();
    const paths = [
      "/api/summarize",
      "/api/notes/note-1/generation/job/cancel",
      "/api/notes/note-1/summaries/summary/collaboration",
    ];
    for (const role of [null, "viewer"] as const) {
      vi.mocked(repo.getRole).mockResolvedValue(role);
      for (const path of paths) {
        const response = await request(app).post(path).set(auth()).send({
          noteId: "note-1",
          revision: 1,
          requestId: randomUUID(),
          options: {},
        });
        expect(response.status).toBe(role ? 403 : 404);
      }
    }
    expect(repo.cancelGeneration).not.toHaveBeenCalled();
    expect(repo.editSummary).not.toHaveBeenCalled();
  });
  it("persists an optional generated title separately from the original note title", async () => {
    const { app, note, repo } = setup({
      summarize: async () => ({
        shortText: "Summary",
        keyPoints: ["Fact"],
        tags: [],
        suggestedTitle: "Suggested source title",
      }),
    });
    const requestId = randomUUID();
    const generated = await request(app)
      .post("/api/summarize")
      .set(auth())
      .send({
        noteId: "note-1",
        revision: 1,
        requestId,
        options: {
          language: "en",
          length: "short",
          generateTags: false,
          generateTitle: true,
        },
      });
    expect(generated.status).toBe(200);
    expect(generated.body.data.summary.suggestedTitle).toBe(
      "Suggested source title",
    );
    const saved = await request(app)
      .post("/api/notes/note-1/summaries")
      .set(auth())
      .send({
        sourceRevision: 1,
        requestId,
        summary: generated.body.data.summary,
      });
    expect(saved.status).toBe(201);
    expect(saved.body.data.suggestedTitle).toBe("Suggested source title");
    expect(repo.saveSummary).toHaveBeenCalledWith(
      "note-1",
      1,
      expect.objectContaining({ suggestedTitle: "Suggested source title" }),
      expect.any(Object),
    );
    expect(note.title).toBe("Test");
  });

  it("edits a verified historical summary without assigning it to the current note revision", async () => {
    const { app, repo, summary, summaries } = setup({ revision: 4 });
    summaries.push({
      ...summary,
      id: "base",
      noteId: "note-1",
      sourceRevision: 1,
      suggestedTags: summary.tags,
      modelId: "gemini-3.6-flash",
      promptVersion: "old-prompt",
      durationMs: 4321,
      generationStatus: "ready",
      isUserEdited: true,
      createdAt: new Date(),
    });
    const response = await request(app)
      .post("/api/notes/note-1/summaries")
      .set(auth())
      .send({
        sourceRevision: 1,
        baseSummaryId: "base",
        requestId: randomUUID(),
        modelId: "forged",
        summary: { ...summary, shortText: "Edited historical summary" },
      });
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      sourceRevision: 1,
      modelId: "gemini-3.6-flash",
      promptVersion: "old-prompt",
      durationMs: 4321,
      baseSummaryId: "base",
      isUserEdited: true,
    });
    expect(repo.getSummary).toHaveBeenCalledWith("note-1", "base");
  });

  it("rejects stale unsaved summaries and forged historical bases", async () => {
    const { app, repo, summary } = setup({ revision: 4 });
    const send = (extra = {}) =>
      request(app)
        .post("/api/notes/note-1/summaries")
        .set(auth())
        .send({
          sourceRevision: 1,
          requestId: randomUUID(),
          summary,
          ...extra,
        });
    expect((await send()).status).toBe(409);
    expect((await send({ baseSummaryId: "missing" })).status).toBe(404);
    vi.mocked(repo.getSummary).mockResolvedValue({
      ...summary,
      id: "foreign",
      noteId: "note-2",
      sourceRevision: 1,
      suggestedTags: summary.tags,
      modelId: "trusted-model",
      promptVersion: "v1",
      durationMs: 1,
      generationStatus: "ready",
      isUserEdited: true,
      createdAt: new Date(),
    });
    expect((await send({ baseSummaryId: "foreign" })).status).toBe(404);
    vi.mocked(repo.getSummary).mockResolvedValue({
      ...summary,
      id: "wrong-revision",
      noteId: "note-1",
      sourceRevision: 2,
      suggestedTags: summary.tags,
      modelId: "trusted-model",
      promptVersion: "v1",
      durationMs: 1,
      generationStatus: "ready",
      isUserEdited: true,
      createdAt: new Date(),
    });
    expect((await send({ baseSummaryId: "wrong-revision" })).status).toBe(400);
    expect(repo.saveSummary).not.toHaveBeenCalled();
  });

  it("shares identical in-flight work but rejects changed request parameters", async () => {
    let finish!: (summary: SummaryContent) => void;
    const pending = new Promise<SummaryContent>((resolve) => {
      finish = resolve;
    });
    const { app, summary, summarize, repo } = setup({
      summarize: async () => pending,
    });
    const body = {
      noteId: "note-1",
      revision: 1,
      requestId: randomUUID(),
      options: { language: "uk", length: "short", generateTags: true },
    };
    const first = request(app)
      .post("/api/summarize")
      .set(auth())
      .send(body)
      .then((response) => response);
    await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(1));
    const mismatch = await request(app)
      .post("/api/summarize")
      .set(auth())
      .send({ ...body, options: { ...body.options, generateTitle: true } });
    expect(mismatch.status).toBe(409);
    const duplicate = request(app)
      .post("/api/summarize")
      .set(auth())
      .send(body)
      .then((response) => response);
    await vi.waitFor(() => expect(repo.getRole).toHaveBeenCalledTimes(2));
    finish(summary);
    const responses = await Promise.all([first, duplicate]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 202,
    ]);
    expect(summarize).toHaveBeenCalledTimes(1);
    const limits = await request(app)
      .get("/api/summarization/limits")
      .set(auth());
    expect(limits.body.data.budget.spentUsd).toBe(0);
  });

  it("rechecks revoked access for both original and duplicate in-flight requests", async () => {
    let finish!: (summary: SummaryContent) => void;
    const pending = new Promise<SummaryContent>((resolve) => {
      finish = resolve;
    });
    const { app, summary, summarize, repo } = setup({
      summarize: async () => pending,
    });
    const body = {
      noteId: "note-1",
      revision: 1,
      requestId: randomUUID(),
      options: { language: "uk", length: "short", generateTags: true },
    };
    const first = request(app)
      .post("/api/summarize")
      .set(auth())
      .send(body)
      .then((response) => response);
    await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(1));
    const duplicate = request(app)
      .post("/api/summarize")
      .set(auth())
      .send(body)
      .then((response) => response);
    await vi.waitFor(() => expect(repo.getRole).toHaveBeenCalledTimes(2));
    vi.mocked(repo.getRole).mockResolvedValue(null);
    finish(summary);
    const responses = await Promise.all([first, duplicate]);
    expect(
      responses.every(
        (response) =>
          response.status === 404 && response.body.data === undefined,
      ),
    ).toBe(true);
  });

  it("does not regenerate if the first request completes during a duplicate access check", async () => {
    let finish!: (summary: SummaryContent) => void;
    let allowDuplicate!: () => void;
    const pending = new Promise<SummaryContent>((resolve) => {
      finish = resolve;
    });
    const access = new Promise<void>((resolve) => {
      allowDuplicate = resolve;
    });
    const { app, summary, summarize, repo } = setup({
      summarize: async () => pending,
    });
    let accessCalls = 0;
    vi.mocked(repo.getRole).mockImplementation(async () => {
      accessCalls += 1;
      if (accessCalls === 2) await access;
      return "owner";
    });
    const body = {
      noteId: "note-1",
      revision: 1,
      requestId: randomUUID(),
      options: { language: "uk", length: "short", generateTags: true },
    };
    const first = request(app)
      .post("/api/summarize")
      .set(auth())
      .send(body)
      .then((response) => response);
    await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(1));
    const duplicate = request(app)
      .post("/api/summarize")
      .set(auth())
      .send(body)
      .then((response) => response);
    await vi.waitFor(() => expect(accessCalls).toBe(2));
    finish(summary);
    expect((await first).status).toBe(200);
    allowDuplicate();
    expect((await duplicate).status).toBe(409);
    expect(summarize).toHaveBeenCalledTimes(1);
  });
  it("requires a verified Firebase token for private endpoints", async () => {
    const { app } = setup();
    const response = await request(app).post("/api/summarize").send({});
    expect(response.status).toBe(401);
    expect((await request(app).get("/api/models")).status).toBe(401);
  });

  it("lists server-approved models and the configured default", async () => {
    const { app } = setup({ provider: "gemini" });
    const response = await request(app).get("/api/models").set(auth());

    expect(response.status).toBe(200);
    expect(response.body.data.defaultModelId).toBe("gemini-3.5-flash-lite");
    expect(response.body.data.models).toContainEqual({
      id: "gemini-3.8-flash",
      label: "Gemini 3.8 Flash",
    });
  });

  it("uses the server default when a generation omits its model", async () => {
    const { app, summarize } = setup({ provider: "gemini" });
    const response = await request(app)
      .post("/api/summarize")
      .set(auth())
      .send({
        noteId: "note-1",
        revision: 1,
        requestId: randomUUID(),
        options: { language: "uk", length: "short", generateTags: true },
      });

    expect(response.status).toBe(200);
    expect(response.body.data.modelId).toBe("gemini-3.5-flash-lite");
    expect(summarize).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ modelId: "gemini-3.5-flash-lite" }),
    );
  });

  it("generates with the chosen model and preserves its server provenance on save", async () => {
    const { app, summarize, repo } = setup({ provider: "gemini" });
    const requestId = randomUUID();
    const response = await request(app)
      .post("/api/summarize")
      .set(auth())
      .send({
        noteId: "note-1",
        revision: 1,
        requestId,
        modelId: "gemini-3.6-flash",
        options: { language: "uk", length: "short", generateTags: true },
      });

    expect(response.status).toBe(200);
    expect(response.body.data.modelId).toBe("gemini-3.6-flash");
    expect(summarize).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      {
        requestId,
        modelId: "gemini-3.6-flash",
        signal: expect.any(AbortSignal),
        reserveUsage: expect.any(Function),
      },
    );

    const saved = await request(app)
      .post("/api/notes/note-1/summaries")
      .set(auth())
      .send({
        sourceRevision: 1,
        requestId,
        modelId: "forged-model",
        summary: response.body.data.summary,
      });

    expect(saved.status).toBe(201);
    expect(repo.saveSummary).toHaveBeenCalledWith(
      "note-1",
      1,
      response.body.data.summary,
      expect.objectContaining({ modelId: "gemini-3.6-flash" }),
    );
  });

  it("rejects models outside the server allowlist before calling the adapter", async () => {
    const { app, summarize } = setup({ provider: "gemini" });
    const response = await request(app)
      .post("/api/summarize")
      .set(auth())
      .send({
        noteId: "note-1",
        revision: 1,
        requestId: randomUUID(),
        modelId: "models/unapproved-provider-model",
        options: { language: "uk", length: "short", generateTags: true },
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_MODEL");
    expect(summarize).not.toHaveBeenCalled();
  });

  it("does not reuse model provenance for a different note", async () => {
    const { app, repo } = setup({ provider: "gemini" });
    const requestId = randomUUID();
    const generated = await request(app)
      .post("/api/summarize")
      .set(auth())
      .send({
        noteId: "note-1",
        revision: 1,
        requestId,
        modelId: "gemini-3.6-flash",
        options: { language: "uk", length: "short", generateTags: true },
      });
    const sourceNote = await repo.getNote("note-1");
    vi.mocked(repo.getNote).mockResolvedValue(sourceNote);
    vi.mocked(repo.getRole).mockResolvedValue("owner");

    const response = await request(app)
      .post("/api/notes/note-2/summaries")
      .set(auth())
      .send({
        sourceRevision: 1,
        requestId,
        summary: generated.body.data.summary,
      });

    expect(response.status).toBe(201);
    expect(response.body.data.modelId).toBe("user-authored");
  });

  it("does not claim model provenance after its generation record expires", async () => {
    let time = 1000;
    const { app } = setup({ provider: "gemini", now: () => time });
    const requestId = randomUUID();
    const generated = await request(app)
      .post("/api/summarize")
      .set(auth())
      .send({
        noteId: "note-1",
        revision: 1,
        requestId,
        options: { language: "uk", length: "short", generateTags: true },
      });
    time += 10 * 60_000;

    const response = await request(app)
      .post("/api/notes/note-1/summaries")
      .set(auth())
      .send({
        sourceRevision: 1,
        requestId,
        summary: generated.body.data.summary,
      });

    expect(response.status).toBe(201);
    expect(response.body.data.modelId).toBe("user-authored");
  });

  it("exposes only the mock model when the mock provider is configured", async () => {
    const { app } = setup();
    const response = await request(app).get("/api/models").set(auth());

    expect(response.body.data).toEqual({
      defaultModelId: "notach-mock-v1",
      models: [{ id: "notach-mock-v1", label: "Notach Mock" }],
    });
  });

  it("rejects a private note when the requester has no share", async () => {
    const { app } = setup();
    const response = await request(app)
      .post("/api/summarize")
      .set(auth("valid-b"))
      .send({
        noteId: "note-1",
        revision: 1,
        requestId: randomUUID(),
        options: { language: "uk", length: "short", generateTags: true },
      });
    expect(response.status).toBe(404);
  });

  it("returns a mock summary and never changes source content", async () => {
    const { app, note } = setup();
    const response = await request(app)
      .post("/api/summarize")
      .set(auth())
      .send({
        noteId: "note-1",
        revision: 1,
        requestId: randomUUID(),
        options: { language: "uk", length: "short", generateTags: true },
      });
    expect(response.status).toBe(200);
    expect(response.body.data.summary.shortText).toBe("Стислий зміст.");
    expect(note.content).toBe("Перший факт. Другий факт.");
  });

  it("rejects stale revisions", async () => {
    const { app } = setup({ revision: 4 });
    const response = await request(app)
      .post("/api/summarize")
      .set(auth())
      .send({
        noteId: "note-1",
        revision: 3,
        requestId: randomUUID(),
        options: { language: "uk", length: "short", generateTags: true },
      });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("NOTE_REVISION_CONFLICT");
  });

  it("stores edited output separately and treats its provenance as user confirmed", async () => {
    const { app, repo } = setup();
    const requestId = randomUUID();
    await request(app)
      .post("/api/summarize")
      .set(auth())
      .send({
        noteId: "note-1",
        revision: 1,
        requestId,
        options: { language: "uk", length: "short", generateTags: true },
      });
    const response = await request(app)
      .post("/api/notes/note-1/summaries")
      .set(auth())
      .send({
        sourceRevision: 1,
        requestId,
        summary: { shortText: "Виправлено.", keyPoints: ["Пункт."], tags: [] },
      });
    expect(response.status).toBe(201);
    expect(repo.saveSummary).toHaveBeenCalledWith(
      "note-1",
      1,
      expect.objectContaining({ shortText: "Виправлено." }),
      expect.objectContaining({ modelId: "notach-mock-v1" }),
    );
  });

  it("combines model-specific token costs in the verified user's budget", async () => {
    const { app } = setup({
      provider: "gemini",
      budgetUsd: 0.01,
      summarize: async (_text, _options, context) => {
        const reserved = await context.reserveUsage!(1000, 100);
        await reserved.settle({
          inputTokens: 200,
          cachedInputTokens: 50,
          outputTokens: 20,
          thinkingTokens: 10,
        });
        return { shortText: "Summary", keyPoints: ["Fact"], tags: [] };
      },
    });
    for (const modelId of ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]) {
      const response = await request(app)
        .post("/api/summarize")
        .set(auth())
        .send({
          noteId: "note-1",
          revision: 1,
          requestId: randomUUID(),
          options: {},
          modelId,
          uid: "user-b",
          cost: 0,
          usage: { inputTokens: 0 },
        });
      expect(response.status).toBe(200);
    }
    const response = await request(app)
      .get("/api/summarization/limits")
      .set(auth());
    expect(response.body.data.budget).toMatchObject({
      spentUsd: 0.00020525,
      reservedUsd: 0,
      inputTokens: 400,
      outputTokens: 40,
      thinkingTokens: 20,
    });
    const other = await request(app)
      .get("/api/summarization/limits")
      .set(auth("valid-b"));
    expect(other.body.data.budget.spentUsd).toBe(0);
  });

  it("enforces the budget before provider work and returns Retry-After", async () => {
    const { app, summarize } = setup({
      provider: "gemini",
      budgetUsd: 0.01,
      now: () => 1000,
      summarize: async (_text, _options, context) => {
        await context.reserveUsage!(1000, 8192);
        throw new Error("unreachable");
      },
    });
    const response = await request(app)
      .post("/api/summarize")
      .set(auth())
      .send({
        noteId: "note-1",
        revision: 1,
        requestId: randomUUID(),
        options: {},
      });
    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe("AI_BUDGET_EXCEEDED");
    expect(response.headers["retry-after"]).toBe("3599");
    expect(summarize).toHaveBeenCalledOnce();
  });
  it("reports a provider quota failure without changing the original or returning provider secrets", async () => {
    const logger = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const { app, note } = setup({
        summarize: async () => {
          throw new SummarizationError(
            "AI_RATE_LIMITED",
            429,
            "RESOURCE_EXHAUSTED",
          );
        },
      });
      const original = note.content;
      const response = await request(app)
        .post("/api/summarize")
        .set(auth())
        .send({
          noteId: "note-1",
          revision: 1,
          requestId: randomUUID(),
          options: { language: "uk", length: "short", generateTags: true },
        });
      expect(response.status).toBe(429);
      expect(response.body.error.code).toBe("AI_RATE_LIMITED");
      expect(note.content).toBe(original);
      expect(JSON.stringify(response.body)).not.toContain(original);
      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining('"upstreamStatus":429'),
      );
      expect(JSON.stringify(logger.mock.calls)).not.toContain(original);
    } finally {
      logger.mockRestore();
    }
  });
});
