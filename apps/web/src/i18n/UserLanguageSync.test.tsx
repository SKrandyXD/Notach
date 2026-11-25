import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "./I18nProvider.js";
import { UserLanguageSync } from "./UserLanguageSync.js";
import { LANGUAGE_STORAGE_KEY } from "./core.js";
import { useI18n } from "./useI18n.js";

const mocks = vi.hoisted(() => ({ getDoc: vi.fn(), user: { uid: "user-a" } }));
vi.mock("firebase/firestore", () => ({
  doc: vi.fn(() => ({})),
  getDoc: mocks.getDoc,
}));
vi.mock("../firebase.js", () => ({ db: {} }));
vi.mock("../auth/useAuth.js", () => ({
  useAuth: () => ({ user: mocks.user, loading: false }),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  mocks.getDoc.mockReset();
});

describe("saved language hydration", () => {
  it("keeps a newer user choice when an older profile read completes later", async () => {
    let resolveRead!: (snapshot: {
      data: () => { preferredLanguage: string };
    }) => void;
    mocks.getDoc.mockReturnValue(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );
    function Probe() {
      const { t, setLanguage } = useI18n();
      return (
        <>
          <p>{t("notes.all")}</p>
          <button onClick={() => setLanguage("en")}>switch</button>
        </>
      );
    }
    render(
      <I18nProvider>
        <UserLanguageSync />
        <Probe />
      </I18nProvider>,
    );
    expect(mocks.getDoc).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("switch"));
    expect(screen.getByText("All notes")).toBeInTheDocument();

    await act(async () => {
      resolveRead({ data: () => ({ preferredLanguage: "uk" }) });
    });

    expect(screen.getByText("All notes")).toBeInTheDocument();
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("en");
    expect(mocks.getDoc).toHaveBeenCalledTimes(1);
  });
});
