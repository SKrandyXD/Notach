import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assertFails,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Firestore,
} from "firebase/firestore";
import { parseServiceAuthority } from "@notach/shared";

const firebase = vi.hoisted(() => ({
  participantDb: undefined as Firestore | undefined,
}));
vi.mock("../../web/src/firebase.js", () => ({
  get db() {
    if (!firebase.participantDb)
      throw new Error("Participant emulator client is not initialized");
    return firebase.participantDb;
  },
  auth: { currentUser: null },
}));
import {
  watchSharedNotes,
  type SharedNote,
} from "../../web/src/services/notes.js";

let environment: RulesTestEnvironment;
let stop: (() => void) | undefined;
const participantUid = "notes-live-participant";
const ownerUid = "notes-live-owner";
const sharedNoteId = "notes-live-shared";
const otherNoteId = "notes-live-private";

beforeAll(async () => {
  // Running this test directly must never connect to a cloud project.
  if (!process.env.FIRESTORE_EMULATOR_HOST)
    throw new Error("Firestore emulator required");
  environment = await initializeTestEnvironment({
    projectId: "demo-notach",
    firestore: {
      ...parseServiceAuthority(process.env.FIRESTORE_EMULATOR_HOST),
      rules: await readFile(
        resolve(process.cwd(), "../../firestore.rules"),
        "utf8",
      ),
    },
  });
  firebase.participantDb = environment
    .authenticatedContext(participantUid)
    .firestore();
  await environment.withSecurityRulesDisabled(async (context) => {
    for (const noteId of [sharedNoteId, otherNoteId]) {
      await setDoc(doc(context.firestore(), "notes", noteId), {
        ownerUid,
        title: "Private note",
        titleNormalized: "private note",
        content: "Private content",
        tags: [],
        revision: 1,
        status: "active",
        favorite: false,
        summaryCount: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  });
});

afterAll(async () => {
  stop?.();
  await environment?.cleanup();
  firebase.participantDb = undefined;
});

describe("live shared-note permissions", () => {
  it("updates grants, roles, and content without reloading and never restores revoked content", async () => {
    const participantDb = firebase.participantDb!;
    const snapshots: SharedNote[][] = [];
    let notes: SharedNote[] | undefined;
    const onError = vi.fn();
    await assertFails(getDoc(doc(participantDb, "notes", sharedNoteId)));
    stop = watchSharedNotes(
      participantUid,
      (items) => {
        notes = items;
        snapshots.push(items);
      },
      onError,
    );
    await vi.waitFor(() => expect(notes).toEqual([]));

    await environment.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(
          context.firestore(),
          "noteShares",
          `${sharedNoteId}_${participantUid}`,
        ),
        {
          noteId: sharedNoteId,
          participantUid,
          role: "viewer",
          status: "accepted",
          createdBy: ownerUid,
          createdAt: serverTimestamp(),
          acceptedAt: serverTimestamp(),
        },
      );
    });
    await vi.waitFor(() =>
      expect(notes).toEqual([
        expect.objectContaining({
          id: sharedNoteId,
          sharedRole: "viewer",
          content: "Private content",
        }),
      ]),
    );

    await environment.withSecurityRulesDisabled(async (context) => {
      await updateDoc(
        doc(
          context.firestore(),
          "noteShares",
          `${sharedNoteId}_${participantUid}`,
        ),
        { role: "editor" },
      );
    });
    await vi.waitFor(() => expect(notes?.[0]?.sharedRole).toBe("editor"));

    await environment.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), "notes", sharedNoteId), {
        title: "Updated note",
        titleNormalized: "updated note",
        content: "Live updated content",
        tags: ["live"],
        revision: 2,
        updatedAt: serverTimestamp(),
      });
    });
    await vi.waitFor(() =>
      expect(notes?.[0]).toMatchObject({
        title: "Updated note",
        content: "Live updated content",
        tags: ["live"],
        revision: 2,
      }),
    );
    expect(notes?.some((note) => note.id === otherNoteId)).toBe(false);

    await environment.withSecurityRulesDisabled(async (context) => {
      await updateDoc(
        doc(
          context.firestore(),
          "noteShares",
          `${sharedNoteId}_${participantUid}`,
        ),
        { status: "revoked" },
      );
    });
    await vi.waitFor(() => expect(notes).toEqual([]));
    const removedAt = snapshots.length;
    await assertFails(getDoc(doc(participantDb, "notes", sharedNoteId)));

    // A new authorized snapshot proves listeners continue operating after revocation,
    // while another change to the now-private note must not resurrect its content.
    await environment.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), "notes", sharedNoteId), {
        content: "Content after revocation",
        revision: 3,
        updatedAt: serverTimestamp(),
      });
      await setDoc(
        doc(
          context.firestore(),
          "noteShares",
          `${otherNoteId}_${participantUid}`,
        ),
        {
          noteId: otherNoteId,
          participantUid,
          role: "viewer",
          status: "accepted",
          createdBy: ownerUid,
          createdAt: serverTimestamp(),
          acceptedAt: serverTimestamp(),
        },
      );
    });
    await vi.waitFor(() =>
      expect(notes).toEqual([
        expect.objectContaining({ id: otherNoteId, sharedRole: "viewer" }),
      ]),
    );
    expect(
      snapshots
        .slice(removedAt)
        .every((items) => items.every((item) => item.id !== sharedNoteId)),
    ).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });
});
