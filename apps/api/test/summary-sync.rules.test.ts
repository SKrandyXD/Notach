import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { Firestore } from "firebase-admin/firestore";
import type { Auth } from "firebase-admin/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";
import request from "supertest";
import {
  parseServiceAuthority,
  type Summary,
  type SummaryDraftFields,
} from "@notach/shared";
import { FirestoreNoteRepository } from "../src/firebase/repository.js";
import { createApp } from "../src/app.js";
import type { SummarizationPort } from "../src/domain.js";
import {
  FirestoreBudgetStore,
  HourlyBudget,
} from "../src/services/ai-budget.js";

const transport = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../../web/src/services/api.js", () => ({
  apiRequest: transport.send,
}));
import {
  CollaborativeSummarySession,
  watchSummaryHistory,
} from "../../web/src/services/summary-sync.js";

let environment: RulesTestEnvironment;
let admin: Firestore;
let repository: FirestoreNoteRepository;
const sessions: CollaborativeSummarySession[] = [];
const stops: Array<() => void> = [];
let transportUid = "summary-owner";

beforeAll(async () => {
  // Never fall back to a cloud database when this integration test is run alone.
  if (!process.env.FIRESTORE_EMULATOR_HOST)
    throw new Error("Firestore emulator required");
  const endpoint = parseServiceAuthority(process.env.FIRESTORE_EMULATOR_HOST);
  environment = await initializeTestEnvironment({
    projectId: "demo-notach",
    firestore: {
      ...endpoint,
      rules: await readFile(
        resolve(process.cwd(), "../../firestore.rules"),
        "utf8",
      ),
    },
  });
  admin = new Firestore({ projectId: "demo-notach" });
  repository = new FirestoreNoteRepository(admin, {} as Auth);
});

afterAll(async () => {
  sessions.forEach((session) => session.destroy());
  stops.forEach((stop) => stop());
  await environment?.cleanup();
  await admin?.terminate();
});

async function seed(noteId: string) {
  await admin.doc(`notes/${noteId}`).set({
    ownerUid: "summary-owner",
    title: "Source",
    titleNormalized: "source",
    content: "Original source.",
    tags: [],
    revision: 1,
    status: "active",
    favorite: false,
    summaryCount: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await Promise.all(
    ["editor", "viewer"].map((role) =>
      admin.doc(`noteShares/${noteId}_summary-${role}`).set({
        noteId,
        participantUid: `summary-${role}`,
        role,
        status: "accepted",
        createdBy: "summary-owner",
        createdAt: new Date(),
        acceptedAt: new Date(),
      }),
    ),
  );
  await admin.doc(`notes/${noteId}/summaries/base`).set({
    noteId,
    sourceRevision: 1,
    shortText: "Alpha summary",
    keyPoints: ["Fact A"],
    suggestedTags: [],
    modelId: "trusted-model",
    promptVersion: "v1",
    durationMs: 100,
    generationStatus: "ready",
    isUserEdited: false,
    createdAt: new Date(),
  });
}

function application(
  summarizer: SummarizationPort = {
    summarize: async () => ({
      shortText: "Generated result",
      keyPoints: ["Fact"],
      tags: [],
    }),
  },
) {
  const app = createApp({
    repository,
    summarizer,
    budget: new HourlyBudget(new FirestoreBudgetStore(admin), 0.1),
    verifyToken: async (token) => ({ uid: token }),
    config: {
      corsOrigins: [],
      maxNoteChars: 50000,
      modelId: "notach-mock-v1",
      promptVersion: "v1",
      provider: "mock",
    },
  });
  transport.send.mockImplementation(
    async (path: string, init?: RequestInit) => {
      const uid = transportUid;
      const response = await request(app)
        .post(path)
        .set("Authorization", `Bearer ${uid}`)
        .send(JSON.parse((init?.body as string) ?? "{}"));
      if (!response.body.ok)
        throw Object.assign(new Error(response.body.error.code), {
          code: response.body.error.code,
        });
      return response.body.data;
    },
  );
  return app;
}

describe("shared summary synchronization", () => {
  it("serializes persistent cost reservations across API instances and restart", async () => {
    let time = Date.UTC(2026, 9, 28, 8);
    const uid = `budget-${randomUUID()}`;
    const first = new HourlyBudget(
      new FirestoreBudgetStore(admin),
      0.1,
      () => time,
    );
    const second = new HourlyBudget(
      new FirestoreBudgetStore(admin),
      0.1,
      () => time,
    );
    const results = await Promise.allSettled([
      first.reserve(uid, 70_000_000),
      second.reserve(uid, 70_000_000),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const reservation = results.find((result) => result.status === "fulfilled");
    if (reservation?.status !== "fulfilled")
      throw new Error("Reservation missing");
    const restarted = new HourlyBudget(
      new FirestoreBudgetStore(admin),
      0.1,
      () => time,
    );
    expect((await restarted.read(uid)).reservedUsd).toBe(0.07);
    const charge = {
      spentNanoUsd: 20_000_000,
      inputTokens: 100,
      outputTokens: 20,
      thinkingTokens: 30,
      unreportedCalls: 0,
    };
    await reservation.value.settle(charge);
    await reservation.value.settle(charge);
    expect(await restarted.read(uid)).toMatchObject({
      spentUsd: 0.02,
      reservedUsd: 0,
      remainingUsd: 0.08,
      inputTokens: 100,
    });
    time += 3_600_000;
    expect(await restarted.read(uid)).toMatchObject({
      spentUsd: 0,
      reservedUsd: 0,
      remainingUsd: 0.1,
    });
  });

  it("merges two authenticated editors, updates a viewer and history, and retains raw whitespace", async () => {
    const noteId = "summary-concurrent";
    await seed(noteId);
    application();
    const ownerDb = environment
      .authenticatedContext("summary-owner")
      .firestore();
    const editorDb = environment
      .authenticatedContext("summary-editor")
      .firestore();
    const viewerDb = environment
      .authenticatedContext("summary-viewer")
      .firestore();
    let ownerDraft: SummaryDraftFields | undefined;
    let editorDraft: SummaryDraftFields | undefined;
    let viewerDraft: SummaryDraftFields | undefined;
    let history: Summary[] = [];
    const errors: unknown[] = [];
    stops.push(
      watchSummaryHistory(
        viewerDb,
        noteId,
        (items) => {
          history = items;
        },
        (error) => errors.push(error),
      ),
    );
    const owner = new CollaborativeSummarySession(
      ownerDb,
      noteId,
      "base",
      true,
      {
        onDraft: (draft) => {
          ownerDraft = draft;
        },
        onStatus: () => {},
        onError: (error) => errors.push(error),
      },
    );
    const editor = new CollaborativeSummarySession(
      editorDb,
      noteId,
      "base",
      true,
      {
        onDraft: (draft) => {
          editorDraft = draft;
        },
        onStatus: () => {},
        onError: (error) => errors.push(error),
      },
    );
    const viewer = new CollaborativeSummarySession(
      viewerDb,
      noteId,
      "base",
      false,
      {
        onDraft: (draft) => {
          viewerDraft = draft;
        },
        onStatus: () => {},
        onError: (error) => errors.push(error),
      },
    );
    sessions.push(owner, editor, viewer);
    transportUid = "summary-owner";
    await owner.start();
    transportUid = "summary-editor";
    await editor.start();
    await viewer.start();
    await vi.waitFor(() =>
      expect(viewerDraft?.shortText).toBe("Alpha summary"),
    );
    owner.update("shortText", "First Alpha summary");
    editor.update("shortText", "Alpha summary last");
    editor.update("pointsText", "Fact A\nFact B ");
    transportUid = "summary-owner";
    const first = owner.flush();
    transportUid = "summary-editor";
    const second = editor.flush();
    await Promise.all([first, second]);
    await vi.waitFor(() => {
      for (const draft of [ownerDraft, editorDraft, viewerDraft]) {
        expect(draft?.shortText).toBe("First Alpha summary last");
        expect(draft?.pointsText).toBe("Fact A\nFact B ");
      }
      expect(history[0]?.shortText).toBe("First Alpha summary last");
    });
    const saved = (
      await admin.doc(`notes/${noteId}/summaries/base`).get()
    ).data()!;
    expect(saved.originalContent.shortText).toBe("Alpha summary");
    expect(saved.modelId).toBe("trusted-model");
    expect(saved.isUserEdited).toBe(true);
    expect((await admin.doc(`notes/${noteId}`).get()).data()?.content).toBe(
      "Original source.",
    );
    expect(errors).toEqual([]);
  });

  it("protects server-owned activity and draft state with the note ACL", async () => {
    const noteId = "summary-permissions";
    await seed(noteId);
    await repository.beginGeneration(noteId, "job", "summary-owner");
    await repository.editSummary(noteId, "base", "summary-owner");
    for (const path of [
      `notes/${noteId}/summaryActivity/current`,
      `notes/${noteId}/summaries/base/collaboration/current`,
    ]) {
      const viewer = environment
        .authenticatedContext("summary-viewer")
        .firestore();
      const outsider = environment
        .authenticatedContext("summary-outsider")
        .firestore();
      const editor = environment
        .authenticatedContext("summary-editor")
        .firestore();
      await assertSucceeds(getDoc(doc(viewer, path)));
      await assertFails(getDoc(doc(outsider, path)));
      await assertFails(
        setDoc(doc(editor, path), { status: "ready", state: "forged" }),
      );
    }
    await repository.cancelGeneration(noteId, "job", "summary-owner");
  });

  it("synchronizes persisted generation and cancels provider work without adding history", async () => {
    const noteId = "summary-generation";
    await seed(noteId);
    let complete!: (value: {
      shortText: string;
      keyPoints: string[];
      tags: string[];
    }) => void;
    let signal: AbortSignal | undefined;
    const app = application({
      summarize: async (_text, _options, context) => {
        signal = context.signal;
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    });
    const requestId = randomUUID();
    const pending = request(app)
      .post("/api/summarize")
      .set("Authorization", "Bearer summary-owner")
      .send({ noteId, revision: 1, requestId, options: {} })
      .then((response) => response);
    await vi.waitFor(() => expect(signal).toBeDefined());
    const otherInstance = application();
    const duplicate = await request(otherInstance)
      .post("/api/summarize")
      .set("Authorization", "Bearer summary-editor")
      .send({ noteId, revision: 1, requestId: randomUUID(), options: {} });
    expect(duplicate.body.error.code).toBe("GENERATION_IN_PROGRESS");
    const response = await request(otherInstance)
      .post(`/api/notes/${noteId}/generation/${requestId}/cancel`)
      .set("Authorization", "Bearer summary-editor")
      .send({});
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    complete({ shortText: "Late result", keyPoints: ["Fact"], tags: [] });
    expect((await pending).body.error.code).toBe("AI_CANCELLED");
    expect(await repository.listSummaries(noteId, 50)).toHaveLength(1);
    expect(
      (await admin.doc(`notes/${noteId}/summaryActivity/current`).get()).data()
        ?.status,
    ).toBe("cancelled");
    const generated = await request(application())
      .post("/api/summarize")
      .set("Authorization", "Bearer summary-editor")
      .send({ noteId, revision: 1, requestId: randomUUID(), options: {} });
    expect(generated.status).toBe(200);
    expect(await repository.listSummaries(noteId, 50)).toHaveLength(2);
    expect(
      (await admin.doc(`notes/${noteId}/summaryActivity/current`).get()).data(),
    ).toMatchObject({
      status: "ready",
      summaryId: generated.body.data.summaryId,
    });
  });
});
