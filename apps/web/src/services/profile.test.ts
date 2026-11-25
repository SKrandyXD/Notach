import { describe, expect, it, vi } from "vitest";
import { saveUserProfile } from "./profile.js";

const mocks = vi.hoisted(() => ({ updateDoc: vi.fn() }));
vi.mock("firebase/firestore", () => ({
  doc: vi.fn(() => ({})),
  serverTimestamp: () => "timestamp",
  updateDoc: mocks.updateDoc,
}));
vi.mock("../firebase.js", () => ({ db: {} }));

describe("profile write ordering", () => {
  it("waits for an earlier language write before committing the latest selection", async () => {
    let resolveFirst!: () => void;
    let resolveLast!: () => void;
    mocks.updateDoc
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveLast = resolve;
        }),
      );
    const first = saveUserProfile("user-a", { preferredLanguage: "en" });
    const last = saveUserProfile("user-a", { preferredLanguage: "uk" });
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.updateDoc).toHaveBeenCalledTimes(1);
    expect(mocks.updateDoc.mock.calls[0]![1]).toMatchObject({
      preferredLanguage: "en",
    });

    resolveFirst();
    await first;
    await Promise.resolve();
    expect(mocks.updateDoc).toHaveBeenCalledTimes(2);
    expect(mocks.updateDoc.mock.calls[1]![1]).toMatchObject({
      preferredLanguage: "uk",
    });
    resolveLast();
    await last;
  });
});
