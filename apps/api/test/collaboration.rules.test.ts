import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import * as Y from "yjs";
import { parseServiceAuthority, resolveLocalServices } from "@notach/shared";
import {
  CollaborativeNoteSession,
  MAX_COLLABORATION_STATE_LENGTH,
  type TextSelection,
} from "../../web/src/services/collaboration.js";

let testEnv: RulesTestEnvironment;
const sessions: CollaborativeNoteSession[] = [];
const sourceContent = "alpha beta gamma";

async function atStage<T>(label: string, operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? "unknown";
    throw new Error(`${label} failed (${code})`, { cause: error });
  }
}

beforeAll(async () => {
  const endpoint = parseServiceAuthority(
    process.env.FIRESTORE_EMULATOR_HOST ??
      resolveLocalServices(process.env).firestoreEmulatorAuthority,
  );
  testEnv = await initializeTestEnvironment({
    projectId: "demo-notach",
    firestore: {
      ...endpoint,
      rules: await readFile(
        resolve(process.cwd(), "../../firestore.rules"),
        "utf8",
      ),
    },
  });
}, 20000);

afterEach(() => {
  sessions.splice(0).forEach((session) => session.destroy());
});
afterAll(async () => {
  await testEnv?.cleanup();
}, 20000);

async function seedNote(noteId: string, withState = false, shared = true) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "notes", noteId), {
      ownerUid: "collab-owner",
      title: "Original title",
      titleNormalized: "original title",
      content: sourceContent,
      tags: ["original"],
      revision: 1,
      status: "active",
      favorite: false,
      summaryCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    if (shared) {
      for (const [participantUid, role] of [
        ["collab-editor", "editor"],
        ["collab-viewer", "viewer"],
      ]) {
        await setDoc(doc(db, "noteShares", `${noteId}_${participantUid}`), {
          noteId,
          participantUid,
          role,
          status: "accepted",
          createdBy: "collab-owner",
          createdAt: new Date(),
          acceptedAt: new Date(),
        });
      }
    }
    if (withState) {
      const document = new Y.Doc();
      document.getText("content").insert(0, sourceContent);
      await setDoc(doc(db, "notes", noteId, "collaboration", "current"), {
        state: Buffer.from(Y.encodeStateAsUpdate(document)).toString("base64"),
        noteRevision: 1,
        updatedBy: "collab-owner",
        updatedAt: new Date(),
      });
      document.destroy();
    }
  });
}

describe("collaborative note editing and rules", () => {
  it("seeds once and merges concurrent non-overlapping edits from two authenticated sessions", async () => {
    const noteId = "collaboration-concurrent";
    await seedNote(noteId);
    const ownerDb = testEnv.authenticatedContext("collab-owner").firestore();
    const editorDb = testEnv.authenticatedContext("collab-editor").firestore();
    let ownerContent = "";
    let editorContent = "";
    let ownerSelection: TextSelection | undefined;
    const owner = new CollaborativeNoteSession(
      ownerDb,
      noteId,
      "collab-owner",
      true,
      {
        debounceMs: 60000,
        getSelection: () => ({
          start: ownerContent.length,
          end: ownerContent.length,
        }),
        onContent: (content, selection) => {
          ownerContent = content;
          if (selection) ownerSelection = selection;
        },
      },
    );
    const editor = new CollaborativeNoteSession(
      editorDb,
      noteId,
      "collab-editor",
      true,
      {
        debounceMs: 60000,
        onContent: (content) => {
          editorContent = content;
        },
      },
    );
    sessions.push(owner, editor);
    await Promise.all([
      atStage("owner initial seed/read", owner.start()),
      atStage("editor initial seed/read", editor.start()),
    ]);
    expect(ownerContent).toBe(sourceContent);
    expect(editorContent).toBe(sourceContent);
    owner.updateText("ALPHA beta gamma");
    editor.updateText("alpha beta GAMMA");
    await Promise.all([
      atStage("owner merged content/state commit", owner.flush()),
      atStage("editor merged content/state commit", editor.flush()),
    ]);
    await vi.waitFor(
      () => {
        expect(ownerContent).toBe("ALPHA beta GAMMA");
        expect(editorContent).toBe("ALPHA beta GAMMA");
      },
      { timeout: 10000 },
    );
    const canonical = (await getDoc(doc(ownerDb, "notes", noteId))).data()!;
    const shared = (
      await getDoc(doc(ownerDb, "notes", noteId, "collaboration", "current"))
    ).data()!;
    expect(canonical).toMatchObject({
      content: "ALPHA beta GAMMA",
      title: "Original title",
      tags: ["original"],
      revision: 3,
    });
    expect(shared.noteRevision).toBe(canonical.revision);
    expect(ownerSelection).toEqual({
      start: ownerContent.length,
      end: ownerContent.length,
    });
  }, 30000);

  it("allows viewer subscriptions but denies viewer edits and private-note access", async () => {
    const sharedId = "collaboration-viewer";
    const privateId = "collaboration-private";
    await seedNote(sharedId, true);
    await seedNote(privateId, true, false);
    const viewerDb = testEnv.authenticatedContext("collab-viewer").firestore();
    let content = "";
    const viewer = new CollaborativeNoteSession(
      viewerDb,
      sharedId,
      "collab-viewer",
      false,
      {
        onContent: (value) => {
          content = value;
        },
      },
    );
    sessions.push(viewer);
    await viewer.start();
    expect(content).toBe(sourceContent);
    expect(() => viewer.updateText("Unauthorized change")).toThrow(
      "COLLABORATION_READ_ONLY",
    );
    const sharedRef = doc(
      viewerDb,
      "notes",
      sharedId,
      "collaboration",
      "current",
    );
    const state = (await getDoc(sharedRef)).data()!;
    await expect(
      setDoc(sharedRef, {
        ...state,
        updatedBy: "collab-viewer",
        updatedAt: serverTimestamp(),
      }),
    ).rejects.toThrow();
    await expect(
      updateDoc(doc(viewerDb, "notes", sharedId), {
        content: "Unauthorized change",
        revision: 2,
      }),
    ).rejects.toThrow();
    const strangerDb = testEnv.authenticatedContext("stranger").firestore();
    await expect(
      getDoc(doc(strangerDb, "notes", privateId, "collaboration", "current")),
    ).rejects.toThrow();
    await expect(
      getDoc(
        doc(
          testEnv.unauthenticatedContext().firestore(),
          "notes",
          privateId,
          "collaboration",
          "current",
        ),
      ),
    ).rejects.toThrow();
  }, 20000);

  it("retains a pending editor change across ACL revocation and flushes it after access is restored", async () => {
    const noteId = "collaboration-revoked-pending";
    await seedNote(noteId, true);
    const ownerDb = testEnv.authenticatedContext("collab-owner").firestore();
    const editorDb = testEnv.authenticatedContext("collab-editor").firestore();
    let localContent = "";
    const editor = new CollaborativeNoteSession(
      editorDb,
      noteId,
      "collab-editor",
      true,
      {
        debounceMs: 60000,
        onContent: (content) => {
          localContent = content;
        },
      },
    );
    sessions.push(editor);
    await editor.start();
    editor.updateText("alpha pending editor change gamma");
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(
        doc(context.firestore(), "noteShares", `${noteId}_collab-editor`),
        {
          status: "revoked",
        },
      );
    });

    await expect(editor.flush()).rejects.toMatchObject({
      code: "permission-denied",
    });
    expect(localContent).toBe("alpha pending editor change gamma");
    expect((await getDoc(doc(ownerDb, "notes", noteId))).data()).toMatchObject({
      content: sourceContent,
      revision: 1,
    });

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(
        doc(context.firestore(), "noteShares", `${noteId}_collab-editor`),
        {
          status: "accepted",
        },
      );
    });
    const saved = await editor.flush();
    expect(saved).toMatchObject({
      content: "alpha pending editor change gamma",
      revision: 2,
    });
    expect(localContent).toBe("alpha pending editor change gamma");
    expect((await getDoc(doc(ownerDb, "notes", noteId))).data()).toMatchObject({
      content: "alpha pending editor change gamma",
      revision: 2,
      tags: ["original"],
      title: "Original title",
    });
  }, 20000);

  it("rejects oversized state, wrong revisions, forged authors, and arbitrary collaboration documents", async () => {
    const noteId = "collaboration-shape";
    await seedNote(noteId, true);
    const db = testEnv.authenticatedContext("collab-editor").firestore();
    const ref = doc(db, "notes", noteId, "collaboration", "current");
    const state = (await getDoc(ref)).data()!;
    const valid = {
      ...state,
      updatedBy: "collab-editor",
      updatedAt: serverTimestamp(),
    };
    await expect(
      setDoc(ref, {
        ...valid,
        state: "x".repeat(MAX_COLLABORATION_STATE_LENGTH + 1),
      }),
    ).rejects.toThrow();
    await expect(setDoc(ref, { ...valid, noteRevision: 2 })).rejects.toThrow();
    await expect(
      setDoc(ref, { ...valid, updatedBy: "collab-owner" }),
    ).rejects.toThrow();
    await expect(
      setDoc(doc(db, "notes", noteId, "collaboration", "other"), valid),
    ).rejects.toThrow();
  }, 20000);
});
