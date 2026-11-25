import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { parseServiceAuthority } from "@notach/shared";

let environment: RulesTestEnvironment;
let noteSequence = 0;
const owner = "validation-owner";

beforeAll(async () => {
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
});

afterAll(async () => {
  await environment?.cleanup();
});

function validNote() {
  return {
    ownerUid: owner,
    title: "Нотатка",
    titleNormalized: "нотатка",
    content: "Original source text.",
    tags: ["навчання", "test"],
    revision: 1,
    status: "active",
    summaryCount: 0,
    favorite: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function ownerDb() {
  return environment.authenticatedContext(owner).firestore();
}

async function createNote() {
  const ref = doc(ownerDb(), "notes", `validation-${++noteSequence}`);
  await assertSucceeds(setDoc(ref, validNote()));
  return ref;
}

describe("Firestore document validation", () => {
  it("accepts the real registration profile and a language-only update", async () => {
    const ref = doc(ownerDb(), "users", owner);
    await assertSucceeds(
      setDoc(ref, {
        displayName: "Користувач",
        preferredLanguage: "uk",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
    );
    await assertSucceeds(
      updateDoc(ref, {
        preferredLanguage: "en",
        updatedAt: serverTimestamp(),
      }),
    );
    await assertFails(updateDoc(ref, { role: "admin" }));
    await assertFails(updateDoc(ref, { displayName: "a".repeat(81) }));
    await assertFails(updateDoc(ref, { preferredLanguage: "invalid" }));
    await assertFails(updateDoc(ref, { createdAt: serverTimestamp() }));
    await assertFails(updateDoc(ref, { updatedAt: new Date(0) }));
    await assertFails(updateDoc(ref, { displayName: deleteField() }));
    await assertFails(deleteDoc(ref));
    await assertFails(
      getDoc(
        doc(environment.authenticatedContext("stranger").firestore(), ref.path),
      ),
    );
    await assertFails(getDocs(collection(ownerDb(), "users")));
  });

  it("rejects a forged profile owner, missing fields and client timestamps", async () => {
    const profile = {
      displayName: "Person",
      preferredLanguage: "uk",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    await assertFails(setDoc(doc(ownerDb(), "users", "someone-else"), profile));
    await assertFails(
      setDoc(doc(ownerDb(), "users", owner), { displayName: "Incomplete" }),
    );
    const another = environment.authenticatedContext("new-person").firestore();
    await assertFails(
      setDoc(doc(another, "users", "new-person"), {
        ...profile,
        createdAt: new Date(0),
      }),
    );
  });

  it.each([
    ["foreign owner", { ownerUid: "another-owner" }],
    ["non-string title", { title: { html: "payload" } }],
    ["empty title", { title: "" }],
    ["oversized title", { title: "a".repeat(121) }],
    ["untrimmed title", { title: " title " }],
    ["missing normalized title", { titleNormalized: null }],
    ["oversized normalized title", { titleNormalized: "a".repeat(121) }],
    ["untrimmed normalized title", { titleNormalized: " title " }],
    ["mixed-case normalized title", { titleNormalized: "TITLE" }],
    ["non-string content", { content: ["payload"] }],
    ["oversized content", { content: "a".repeat(50001) }],
    ["non-list tags", { tags: { tag: "value" } }],
    [
      "too many tags",
      { tags: Array.from({ length: 21 }, (_, i) => `tag${i}`) },
    ],
    ["non-string tag", { tags: ["valid", { nested: "payload" }] }],
    [
      "last-position invalid tag",
      { tags: [...Array.from({ length: 19 }, (_, i) => `tag${i}`), 7] },
    ],
    ["empty tag", { tags: [""] }],
    ["oversized tag", { tags: ["a".repeat(31)] }],
    ["untrimmed tag", { tags: [" tag"] }],
    ["mixed-case tag", { tags: ["TAG"] }],
    ["tag prefix", { tags: ["#tag"] }],
    ["duplicate tags", { tags: ["same", "same"] }],
    ["arbitrary status", { status: "public" }],
    ["initial archive", { status: "archived" }],
    ["initial revision", { revision: 2 }],
    ["fractional revision", { revision: 1.5 }],
    ["forged summary count", { summaryCount: 100 }],
    ["wrong favorite type", { favorite: "true" }],
    ["forged creation time", { createdAt: new Date(0) }],
    ["forged update time", { updatedAt: new Date(0) }],
    ["client permissions", { sharedWith: [owner] }],
    ["unknown field", { admin: true }],
  ])("rejects note creation with %s", async (_name, changes) => {
    await assertFails(
      setDoc(doc(ownerDb(), "notes", `invalid-${++noteSequence}`), {
        ...validNote(),
        ...changes,
      }),
    );
  });

  it("requires every canonical note field", async () => {
    for (const field of Object.keys(validNote())) {
      const data: Record<string, unknown> = { ...validNote() };
      delete data[field];
      await assertFails(
        setDoc(doc(ownerDb(), "notes", `incomplete-${++noteSequence}`), data),
      );
    }
  });

  it("accepts boundary tags, draft content, autosaved metadata and text revisions", async () => {
    const ref = await createNote();
    await assertSucceeds(
      updateDoc(ref, {
        tags: Array.from({ length: 20 }, (_, i) => `тег${i}`),
        title: "Нова назва",
        titleNormalized: "нова назва",
        favorite: true,
        status: "archived",
        updatedAt: serverTimestamp(),
      }),
    );
    await assertSucceeds(
      updateDoc(ref, {
        content: "",
        revision: 2,
        updatedAt: serverTimestamp(),
      }),
    );
  });

  it("revalidates the complete document and protects immutable update fields", async () => {
    const ref = await createNote();
    for (const changes of [
      { ownerUid: "stranger" },
      { summaryCount: 1 },
      { createdAt: new Date(0) },
      { updatedAt: new Date(0) },
      { title: deleteField() },
      { favorite: deleteField() },
      { status: "public" },
      { title: "a".repeat(121) },
      { tags: ["bad", false] },
      { content: "a".repeat(50001), revision: 2 },
      { content: "Changed", revision: 1 },
      { content: "Changed", revision: 3 },
      { content: "Changed", revision: 2.5 },
      { revision: 2 },
      { randomField: "payload" },
    ]) {
      await assertFails(
        updateDoc(ref, { updatedAt: serverTimestamp(), ...changes }),
      );
    }
    await assertFails(deleteDoc(ref));
  });

  it("requires bounded owner queries and denies anonymous access", async () => {
    const ref = await createNote();
    const ownQuery = query(
      collection(ownerDb(), "notes"),
      where("ownerUid", "==", owner),
    );
    await assertSucceeds(getDocs(query(ownQuery, limit(100))));
    await assertFails(getDocs(ownQuery));
    await assertFails(getDocs(query(ownQuery, limit(101))));
    await assertFails(
      getDocs(query(collection(ownerDb(), "notes"), limit(100))),
    );
    await assertFails(
      getDoc(doc(environment.unauthenticatedContext().firestore(), ref.path)),
    );
    await assertFails(
      setDoc(
        doc(
          environment.unauthenticatedContext().firestore(),
          "notes/anonymous",
        ),
        validNote(),
      ),
    );
  });

  it("restricts editor/viewer roles, including immediately revoked access", async () => {
    const ref = await createNote();
    const participant = "validation-participant";
    const sharePath = `noteShares/${ref.id}_${participant}`;
    const participantRef = doc(
      environment.authenticatedContext(participant).firestore(),
      ref.path,
    );
    await environment.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), sharePath), {
        noteId: ref.id,
        participantUid: participant,
        role: "viewer",
        status: "accepted",
      });
    });
    await assertSucceeds(getDoc(participantRef));
    const changes = {
      title: "Changed",
      titleNormalized: "changed",
      tags: Array.from({ length: 20 }, (_, i) => `tag${i}`),
      updatedAt: serverTimestamp(),
    };
    await assertFails(updateDoc(participantRef, changes));
    await environment.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), sharePath), { role: "editor" });
    });
    await assertSucceeds(updateDoc(participantRef, changes));
    const batch = writeBatch(participantRef.firestore);
    batch.update(participantRef, {
      content: "Atomic editor content",
      revision: 2,
      updatedAt: serverTimestamp(),
    });
    batch.set(
      doc(participantRef.firestore, `${ref.path}/collaboration/current`),
      {
        state: "AAAA",
        noteRevision: 2,
        updatedBy: participant,
        updatedAt: serverTimestamp(),
      },
    );
    await assertSucceeds(batch.commit());
    await assertFails(
      updateDoc(participantRef, { ...changes, ownerUid: participant }),
    );
    await environment.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), sharePath), {
        status: "revoked",
      });
    });
    await assertFails(getDoc(participantRef));
    await assertFails(updateDoc(participantRef, changes));
  });

  it("denies direct writes to server-managed and arbitrary nested data", async () => {
    const ref = await createNote();
    for (const path of [
      `noteShares/${ref.id}_${owner}`,
      `${ref.path}/summaries/forged`,
      `${ref.path}/summaries/forged/feedback/${owner}`,
      `${ref.path}/summaries/forged/collaboration/current`,
      `${ref.path}/summaryActivity/current`,
      `${ref.path}/generationCancellations/forged`,
      `${ref.path}/arbitrary/document`,
      `users/${owner}/private/forged`,
      `aiBudgets/${owner}`,
      "unknown/document",
    ]) {
      await assertFails(
        setDoc(doc(ownerDb(), path), {
          authorUid: owner,
          role: "owner",
          spent: 0,
        }),
      );
    }
  });

  it("denies malformed collaboration data and orphaned shares", async () => {
    const ref = await createNote();
    const collaboration = doc(ownerDb(), `${ref.path}/collaboration/current`);
    const data = {
      state: "AAAA",
      noteRevision: 1,
      updatedBy: owner,
      updatedAt: serverTimestamp(),
    };
    await assertSucceeds(setDoc(collaboration, data));
    for (const state of ["", "<script>", "!!!!", "AAA", "A===", "AA=A"]) {
      await assertFails(setDoc(collaboration, { ...data, state }));
    }
    await assertFails(setDoc(collaboration, { ...data, noteRevision: 2 }));
    await assertFails(
      setDoc(collaboration, { ...data, updatedAt: new Date(0) }),
    );
    const orphanId = "validation-orphan";
    await environment.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), "noteShares", `${orphanId}_${owner}`),
        {
          noteId: orphanId,
          participantUid: owner,
          role: "editor",
          status: "accepted",
        },
      );
      await setDoc(
        doc(context.firestore(), "notes", orphanId, "summaries", "orphan"),
        { shortText: "orphan" },
      );
    });
    await assertFails(
      getDoc(doc(ownerDb(), "notes", orphanId, "summaries", "orphan")),
    );
  });

  it("denies every client operation on the server billing ledger", async () => {
    const path = `aiUsage/${owner}`;
    await environment.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), path), { spentMicros: 1000 });
      await setDoc(doc(context.firestore(), `${path}/reservations/job`), {
        reservedMicros: 2000,
      });
    });
    for (const db of [
      ownerDb(),
      environment.authenticatedContext("ledger-stranger").firestore(),
      environment.unauthenticatedContext().firestore(),
    ]) {
      const ref = doc(db, path);
      await assertFails(getDoc(ref));
      await assertFails(getDocs(query(collection(db, "aiUsage"), limit(100))));
      await assertFails(setDoc(ref, { spentMicros: 0 }));
      await assertFails(updateDoc(ref, { spentMicros: 0 }));
      await assertFails(deleteDoc(ref));
      await assertFails(getDoc(doc(db, `${path}/reservations/job`)));
      await assertFails(
        setDoc(doc(db, `${path}/reservations/job`), { reservedMicros: 0 }),
      );
    }
  });
});
