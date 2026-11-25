import { describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import {
  FirestoreBudgetStore,
  HourlyBudget,
  MemoryBudgetStore,
  HOUR_MS,
  NANO_USD,
  type BudgetCharge,
} from "./ai-budget.js";

function transactionalFirestore() {
  interface LedgerReference {
    path: string;
    collection(name: string): { doc(id: string): LedgerReference };
    get(): Promise<{
      exists: boolean;
      data(): Record<string, unknown> | undefined;
    }>;
  }
  const documents = new Map<string, Record<string, unknown>>();
  let tail = Promise.resolve();
  const snapshot = (path: string) => ({
    exists: documents.has(path),
    data: () => documents.get(path),
  });
  const reference = (path: string): LedgerReference => ({
    path,
    collection: (name: string) => ({
      doc: (id: string) => reference(`${path}/${name}/${id}`),
    }),
    get: async () => snapshot(path),
  });
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => reference(`${name}/${id}`),
    }),
    runTransaction: (operation: (transaction: unknown) => Promise<void>) => {
      const work = tail.then(async () => {
        const writes = new Map<string, Record<string, unknown>>();
        const transaction = {
          get: async (ref: { path: string }) => {
            if (writes.size) throw new Error("READ_AFTER_WRITE");
            return snapshot(ref.path);
          },
          set: (ref: { path: string }, value: Record<string, unknown>) => {
            writes.set(ref.path, value);
          },
          create: (ref: { path: string }, value: Record<string, unknown>) => {
            if (documents.has(ref.path)) throw new Error("ALREADY_EXISTS");
            writes.set(ref.path, value);
          },
          update: (ref: { path: string }, value: Record<string, unknown>) => {
            if (!documents.has(ref.path)) throw new Error("NOT_FOUND");
            writes.set(ref.path, { ...documents.get(ref.path), ...value });
          },
        };
        await operation(transaction);
        for (const [path, value] of writes) documents.set(path, value);
      });
      tail = work.catch(() => undefined);
      return work;
    },
  };
  return { db: db as unknown as Firestore, documents };
}

function charge(spentNanoUsd: number): BudgetCharge {
  return {
    spentNanoUsd,
    inputTokens: 100,
    outputTokens: 20,
    thinkingTokens: 10,
    unreportedCalls: 0,
  };
}

describe("hourly AI spending budget", () => {
  it("shows an untouched budget without spending or reserving money", async () => {
    const budget = new HourlyBudget(new MemoryBudgetStore(), 0.1, () => 1234);
    const expected = {
      currency: "USD",
      limitUsd: 0.1,
      spentUsd: 0,
      reservedUsd: 0,
      remainingUsd: 0.1,
      windowSeconds: 3600,
      windowStartedAt: new Date(0).toISOString(),
      resetsAt: new Date(HOUR_MS).toISOString(),
      scope: "user",
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      unreportedCalls: 0,
    };
    expect(await budget.read("user-a")).toEqual(expected);
    expect(await budget.read("user-a")).toEqual(expected);
  });

  it("releases the unused reservation after measured usage arrives", async () => {
    const budget = new HourlyBudget(new MemoryBudgetStore(), 0.1, () => 0);
    const reservation = await budget.reserve("user-a", 80_000_000);
    expect(await budget.read("user-a")).toMatchObject({
      spentUsd: 0,
      reservedUsd: 0.08,
      remainingUsd: 0.02,
    });
    await reservation.settle(charge(1_000_000));
    expect(await budget.read("user-a")).toMatchObject({
      spentUsd: 0.001,
      reservedUsd: 0,
      remainingUsd: 0.099,
      inputTokens: 100,
      outputTokens: 20,
      thinkingTokens: 10,
    });
  });

  it("reserves atomically when simultaneous requests compete", async () => {
    const budget = new HourlyBudget(new MemoryBudgetStore(), 0.1, () => 0);
    const results = await Promise.allSettled([
      budget.reserve("user-a", 60_000_000),
      budget.reserve("user-a", 60_000_000),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected");
    expect(failure).toMatchObject({
      reason: { status: 429, code: "AI_BUDGET_EXCEEDED" },
    });
    expect(await budget.read("user-a")).toMatchObject({ reservedUsd: 0.06 });
  });

  it("shares reservations and charges between service instances", async () => {
    const store = new MemoryBudgetStore();
    const first = new HourlyBudget(store, 0.1, () => 0);
    const second = new HourlyBudget(store, 0.1, () => 0);
    const reservation = await first.reserve("user-a", 80_000_000);
    await expect(second.reserve("user-a", 30_000_000)).rejects.toMatchObject({
      code: "AI_BUDGET_EXCEEDED",
    });
    await reservation.settle(charge(50_000_000));
    expect(await second.read("user-a")).toMatchObject({ spentUsd: 0.05 });
    await expect(second.reserve("user-a", 60_000_000)).rejects.toMatchObject({
      code: "AI_BUDGET_EXCEEDED",
    });
  });

  it("keeps different users' budgets independent", async () => {
    const budget = new HourlyBudget(new MemoryBudgetStore(), 0.1, () => 0);
    await budget.reserve("user-a", 100_000_000);
    await expect(budget.reserve("user-b", 100_000_000)).resolves.toBeDefined();
  });

  it("resets at a fixed UTC hour and settles old work into its old window", async () => {
    let now = HOUR_MS - 1;
    const budget = new HourlyBudget(new MemoryBudgetStore(), 0.1, () => now);
    const old = await budget.reserve("user-a", 100_000_000);
    now++;
    await old.settle(charge(90_000_000));
    expect(await budget.read("user-a")).toMatchObject({
      spentUsd: 0,
      reservedUsd: 0,
      remainingUsd: 0.1,
      windowStartedAt: new Date(HOUR_MS).toISOString(),
    });
    await expect(budget.reserve("user-a", 100_000_000)).resolves.toBeDefined();
  });

  it("does not double charge a retried settlement", async () => {
    const budget = new HourlyBudget(new MemoryBudgetStore(), 0.1, () => 0);
    const reservation = await budget.reserve("user-a", 50_000_000);
    await reservation.settle(charge(20_000_000));
    await reservation.settle(charge(20_000_000));
    expect(await budget.read("user-a")).toMatchObject({
      spentUsd: 0.02,
      reservedUsd: 0,
      inputTokens: 100,
    });
  });

  it("counts unknown usage conservatively without inventing token counts", async () => {
    const budget = new HourlyBudget(new MemoryBudgetStore(), 0.1, () => 0);
    const reservation = await budget.reserve("user-a", 80_000_000);
    await reservation.settle({
      spentNanoUsd: 80_000_000,
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      unreportedCalls: 1,
    });
    expect(await budget.read("user-a")).toMatchObject({
      spentUsd: 0.08,
      reservedUsd: 0,
      unreportedCalls: 1,
      inputTokens: 0,
    });
  });

  it("allows zero-cost work when no money remains", async () => {
    const budget = new HourlyBudget(new MemoryBudgetStore(), 0.1, () => 0);
    await budget.reserve("user-a", 100_000_000);
    const mock = await budget.reserve("user-a", 0);
    await mock.settle(charge(0));
    expect(await budget.read("user-a")).toMatchObject({ remainingUsd: 0 });
  });

  it("makes store reservation retries idempotent", async () => {
    const store = new MemoryBudgetStore();
    await store.reserve("user-a", 0, "call-1", 10, 100);
    await store.reserve("user-a", 0, "call-1", 10, 100);
    expect((await store.get("user-a", 0)).reservedNanoUsd).toBe(10);
    await expect(store.reserve("user-a", 0, "call-1", 20, 100)).rejects.toThrow(
      "BUDGET_RESERVATION_CONFLICT",
    );
  });

  it("blocks malformed amounts without changing existing usage", async () => {
    const budget = new HourlyBudget(new MemoryBudgetStore(), 0.1, () => 0);
    await expect(budget.reserve("user-a", -1)).rejects.toThrow(
      "INVALID_BUDGET_AMOUNT",
    );
    await expect(budget.reserve("user-a", 1.1)).rejects.toThrow(
      "INVALID_BUDGET_AMOUNT",
    );
    expect(await budget.read("user-a")).toMatchObject({ remainingUsd: 0.1 });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1 / NANO_USD / 2])(
    "rejects unusable configured hourly limit %s",
    (limit) => {
      expect(() => new HourlyBudget(new MemoryBudgetStore(), limit)).toThrow(
        "INVALID_HOURLY_BUDGET",
      );
    },
  );
});

describe("Firestore spending ledger transactions", () => {
  it("keeps persisted reservations across new store instances", async () => {
    const { db, documents } = transactionalFirestore();
    const first = new HourlyBudget(new FirestoreBudgetStore(db), 0.1, () => 0);
    const reservation = await first.reserve("user-a", 90_000_000);
    const afterRestart = new HourlyBudget(
      new FirestoreBudgetStore(db),
      0.1,
      () => 0,
    );
    await expect(
      afterRestart.reserve("user-a", 20_000_000),
    ).rejects.toMatchObject({
      code: "AI_BUDGET_EXCEEDED",
    });
    await reservation.settle(charge(10_000_000));
    await reservation.settle(charge(10_000_000));
    expect(await afterRestart.read("user-a")).toMatchObject({
      spentUsd: 0.01,
      reservedUsd: 0,
      remainingUsd: 0.09,
      inputTokens: 100,
    });
    expect(documents.has("aiUsage/user-a/hours/0")).toBe(true);
  });

  it("rejects competing server instances without leaving partial writes", async () => {
    const { db, documents } = transactionalFirestore();
    const first = new HourlyBudget(new FirestoreBudgetStore(db), 0.1, () => 0);
    const second = new HourlyBudget(new FirestoreBudgetStore(db), 0.1, () => 0);
    const requests = await Promise.allSettled([
      first.reserve("user-a", 60_000_000),
      second.reserve("user-a", 60_000_000),
    ]);
    expect(
      requests.filter((value) => value.status === "fulfilled"),
    ).toHaveLength(1);
    expect(await first.read("user-a")).toMatchObject({ reservedUsd: 0.06 });
    expect(documents.size).toBe(2);
  });

  it("does not let unusual UID characters change the ledger path", async () => {
    const { db, documents } = transactionalFirestore();
    const store = new FirestoreBudgetStore(db);
    await store.reserve("user/a", 0, "call-1", 10, 100);
    await store.reserve("user/a", 0, "call-1", 10, 100);
    expect(documents.has("aiUsage/user%2Fa/hours/0")).toBe(true);
    expect((await store.get("user/a", 0)).reservedNanoUsd).toBe(10);
  });
});
