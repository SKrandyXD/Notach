import { randomUUID } from "node:crypto";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { AppError } from "../domain.js";

export const HOUR_MS = 3_600_000;
export const NANO_USD = 1_000_000_000;

export interface BudgetCharge {
  spentNanoUsd: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  unreportedCalls: number;
}

export interface BudgetTotals extends BudgetCharge {
  reservedNanoUsd: number;
}

export interface BudgetStore {
  get(uid: string, windowStart: number): Promise<BudgetTotals>;
  reserve(
    uid: string,
    windowStart: number,
    reservationId: string,
    amountNanoUsd: number,
    limitNanoUsd: number,
  ): Promise<void>;
  settle(
    uid: string,
    windowStart: number,
    reservationId: string,
    charge: BudgetCharge,
  ): Promise<void>;
}

export interface HourlyBudgetSnapshot {
  currency: "USD";
  limitUsd: number;
  spentUsd: number;
  reservedUsd: number;
  remainingUsd: number;
  windowSeconds: 3600;
  windowStartedAt: string;
  resetsAt: string;
  scope: "user";
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  unreportedCalls: number;
}

function zeroTotals(): BudgetTotals {
  return {
    spentNanoUsd: 0,
    reservedNanoUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    unreportedCalls: 0,
  };
}

function nonnegativeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("INVALID_BUDGET_AMOUNT");
  }
  return value;
}

function validateCharge(charge: BudgetCharge): void {
  for (const value of Object.values(charge)) nonnegativeInteger(value);
}

function checkReservation(
  totals: BudgetTotals,
  amountNanoUsd: number,
  limitNanoUsd: number,
): void {
  nonnegativeInteger(amountNanoUsd);
  nonnegativeInteger(limitNanoUsd);
  if (
    totals.spentNanoUsd + totals.reservedNanoUsd + amountNanoUsd >
    limitNanoUsd
  ) {
    throw new AppError(
      429,
      "AI_BUDGET_EXCEEDED",
      "Годинного бюджету недостатньо для цього узагальнення.",
    );
  }
}

function settleTotals(
  totals: BudgetTotals,
  reserved: number,
  charge: BudgetCharge,
): BudgetTotals {
  validateCharge(charge);
  const result = { ...totals };
  result.reservedNanoUsd -= reserved;
  for (const key of Object.keys(charge) as (keyof BudgetCharge)[]) {
    result[key] += charge[key];
  }
  for (const value of Object.values(result)) nonnegativeInteger(value);
  return result;
}

// The web client never reads or writes these documents. Only authenticated
// API operations may spend a budget. Firestore transactions serialize usage
// across API instances and preserve reservations after a process restart.
export class FirestoreBudgetStore implements BudgetStore {
  constructor(private readonly db: Firestore) {}

  private hour(uid: string, windowStart: number) {
    return this.db
      .collection("aiUsage")
      .doc(encodeURIComponent(uid))
      .collection("hours")
      .doc(String(Math.floor(windowStart / HOUR_MS)));
  }

  async get(uid: string, windowStart: number): Promise<BudgetTotals> {
    const snapshot = await this.hour(uid, windowStart).get();
    return this.readTotals(snapshot.data());
  }

  private readTotals(data?: Record<string, unknown>): BudgetTotals {
    const totals = zeroTotals();
    if (!data) return totals;
    for (const key of Object.keys(totals) as (keyof BudgetTotals)[]) {
      totals[key] = nonnegativeInteger(data[key] as number);
    }
    return totals;
  }

  async reserve(
    uid: string,
    windowStart: number,
    reservationId: string,
    amountNanoUsd: number,
    limitNanoUsd: number,
  ): Promise<void> {
    const hour = this.hour(uid, windowStart);
    const reservation = hour.collection("reservations").doc(reservationId);
    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(hour);
      const existing = await transaction.get(reservation);
      if (existing.exists) {
        if (existing.data()?.amountNanoUsd !== amountNanoUsd) {
          throw new Error("BUDGET_RESERVATION_CONFLICT");
        }
        return;
      }
      const totals = this.readTotals(snapshot.data());
      checkReservation(totals, amountNanoUsd, limitNanoUsd);
      transaction.set(hour, {
        ...totals,
        reservedNanoUsd: totals.reservedNanoUsd + amountNanoUsd,
        windowStartedAt: new Date(windowStart),
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.create(reservation, {
        amountNanoUsd,
        settled: false,
        createdAt: FieldValue.serverTimestamp(),
      });
    });
  }

  async settle(
    uid: string,
    windowStart: number,
    reservationId: string,
    charge: BudgetCharge,
  ): Promise<void> {
    validateCharge(charge);
    const hour = this.hour(uid, windowStart);
    const reservation = hour.collection("reservations").doc(reservationId);
    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(hour);
      const existing = await transaction.get(reservation);
      if (!existing.exists) throw new Error("BUDGET_RESERVATION_NOT_FOUND");
      const data = existing.data()!;
      if (data.settled === true) return;
      const reserved = nonnegativeInteger(data.amountNanoUsd as number);
      const totals = settleTotals(
        this.readTotals(snapshot.data()),
        reserved,
        charge,
      );
      transaction.set(hour, {
        ...totals,
        windowStartedAt: new Date(windowStart),
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.update(reservation, {
        settled: true,
        charge,
        settledAt: FieldValue.serverTimestamp(),
      });
    });
  }
}

// Tests use this store; production startup explicitly injects Firestore.
export class MemoryBudgetStore implements BudgetStore {
  private readonly totals = new Map<string, BudgetTotals>();
  private readonly reservations = new Map<
    string,
    { amountNanoUsd: number; settled: boolean }
  >();

  private key(uid: string, windowStart: number): string {
    return JSON.stringify([uid, windowStart]);
  }

  async get(uid: string, windowStart: number): Promise<BudgetTotals> {
    return { ...(this.totals.get(this.key(uid, windowStart)) ?? zeroTotals()) };
  }

  async reserve(
    uid: string,
    windowStart: number,
    reservationId: string,
    amountNanoUsd: number,
    limitNanoUsd: number,
  ): Promise<void> {
    const key = this.key(uid, windowStart);
    const reservationKey = JSON.stringify([key, reservationId]);
    const existing = this.reservations.get(reservationKey);
    if (existing) {
      if (existing.amountNanoUsd !== amountNanoUsd) {
        throw new Error("BUDGET_RESERVATION_CONFLICT");
      }
      return;
    }
    const totals = this.totals.get(key) ?? zeroTotals();
    checkReservation(totals, amountNanoUsd, limitNanoUsd);
    this.totals.set(key, {
      ...totals,
      reservedNanoUsd: totals.reservedNanoUsd + amountNanoUsd,
    });
    this.reservations.set(reservationKey, {
      amountNanoUsd,
      settled: false,
    });
  }

  async settle(
    uid: string,
    windowStart: number,
    reservationId: string,
    charge: BudgetCharge,
  ): Promise<void> {
    validateCharge(charge);
    const key = this.key(uid, windowStart);
    const reservation = this.reservations.get(
      JSON.stringify([key, reservationId]),
    );
    if (!reservation) throw new Error("BUDGET_RESERVATION_NOT_FOUND");
    if (reservation.settled) return;
    this.totals.set(
      key,
      settleTotals(
        this.totals.get(key) ?? zeroTotals(),
        reservation.amountNanoUsd,
        charge,
      ),
    );
    reservation.settled = true;
  }
}

export class HourlyBudget {
  private readonly limitNanoUsd: number;

  constructor(
    private readonly store: BudgetStore,
    limitUsd: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(limitUsd) || limitUsd <= 0) {
      throw new Error("INVALID_HOURLY_BUDGET");
    }
    this.limitNanoUsd = nonnegativeInteger(Math.floor(limitUsd * NANO_USD));
    if (this.limitNanoUsd === 0) throw new Error("INVALID_HOURLY_BUDGET");
  }

  private windowStart(): number {
    return Math.floor(this.now() / HOUR_MS) * HOUR_MS;
  }

  async read(uid: string): Promise<HourlyBudgetSnapshot> {
    const windowStart = this.windowStart();
    const totals = await this.store.get(uid, windowStart);
    return {
      currency: "USD",
      limitUsd: this.limitNanoUsd / NANO_USD,
      spentUsd: totals.spentNanoUsd / NANO_USD,
      reservedUsd: totals.reservedNanoUsd / NANO_USD,
      remainingUsd:
        Math.max(
          0,
          this.limitNanoUsd - totals.spentNanoUsd - totals.reservedNanoUsd,
        ) / NANO_USD,
      windowSeconds: 3600,
      windowStartedAt: new Date(windowStart).toISOString(),
      resetsAt: new Date(windowStart + HOUR_MS).toISOString(),
      scope: "user",
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      thinkingTokens: totals.thinkingTokens,
      unreportedCalls: totals.unreportedCalls,
    };
  }

  async reserve(uid: string, amountNanoUsd: number) {
    const windowStart = this.windowStart();
    const reservationId = randomUUID();
    await this.store.reserve(
      uid,
      windowStart,
      reservationId,
      amountNanoUsd,
      this.limitNanoUsd,
    );
    return {
      windowStart,
      reservationId,
      settle: (charge: BudgetCharge) =>
        this.store.settle(uid, windowStart, reservationId, charge),
    };
  }
}
