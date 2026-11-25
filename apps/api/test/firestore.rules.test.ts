import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc } from "firebase/firestore";
import { parseServiceAuthority, resolveLocalServices } from "@notach/shared";

let testEnv: RulesTestEnvironment;

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
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "notes/private-note"), {
      ownerUid: "owner-a",
      title: "Private",
      titleNormalized: "private",
      content: "secret",
      tags: [],
      revision: 1,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

describe("Firestore security rules", () => {
  it("blocks an unrelated authenticated user from reading a private note", async () => {
    const db = testEnv.authenticatedContext("owner-b").firestore();
    await expect(getDoc(doc(db, "notes/private-note"))).rejects.toThrow();
  });

  it("prevents owners from transferring ownership", async () => {
    const db = testEnv.authenticatedContext("owner-a").firestore();
    await expect(
      updateDoc(doc(db, "notes/private-note"), { ownerUid: "owner-b" }),
    ).rejects.toThrow();
  });

  it("allows the owner to read the note", async () => {
    const db = testEnv.authenticatedContext("owner-a").firestore();
    expect((await getDoc(doc(db, "notes/private-note"))).data()?.content).toBe(
      "secret",
    );
  });
});
