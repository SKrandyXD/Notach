import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "./I18nProvider.js";
import { LANGUAGE_STORAGE_KEY, storedLanguage, translate } from "./core.js";
import { useI18n } from "./useI18n.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.lang = "uk";
});

describe("localization", () => {
  it("uses Ukrainian plural rules and interpolates localized counts", () => {
    expect(translate("uk", "notes.count", { count: 1 })).toBe("1 запис");
    expect(translate("uk", "notes.count", { count: 2 })).toBe("2 записи");
    expect(translate("uk", "notes.count", { count: 5 })).toBe("5 записів");
    expect(translate("uk", "notes.count", { count: 21 })).toBe("21 запис");
    expect(translate("en", "notes.count", { count: 2 })).toBe("2 notes");
    expect(translate("en", "editor.removeTag", { tag: "research" })).toBe(
      "Remove tag research",
    );
  });

  it("falls back to Ukrainian for an unsupported stored language", () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "unsupported");
    expect(storedLanguage()).toBe("uk");
  });

  it("switches the rendered UI, document language, formats, and persisted preference", async () => {
    function Probe() {
      const { t, setLanguage, formatNumber, formatDate } = useI18n();
      return (
        <>
          <p>{t("notes.all")}</p>
          <output>
            {formatNumber(1234.5)} /{" "}
            {formatDate("2026-10-27T12:00:00Z", {
              year: "numeric",
              month: "long",
            })}
          </output>
          <button onClick={() => setLanguage("en")}>switch</button>
        </>
      );
    }
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByText("Усі нотатки")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByText("switch"));
    });
    expect(screen.getByText("All notes")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "1,234.5 / October 2026",
    );
    expect(document.documentElement.lang).toBe("en");
    expect(document.title).toBe("Notach — notes");
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("en");
  });
});
