import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { Note, Summary, SummaryModelCatalog } from "@notach/shared";
import { I18nProvider } from "./i18n/I18nProvider.js";

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  getNote: vi.fn(),
  updateNoteFields: vi.fn(),
  currentNote: null as Note | null,
  summaryUpdate: vi.fn(),
  logout: vi.fn(),
  originalFlush: vi.fn(),
  summaryFlush: vi.fn(),
  summaryDraftListener: null as
    | null
    | import("./services/summary-sync.js").SummarySessionOptions["onDraft"],
  historyListener: null as null | ((items: Summary[]) => void),
  activityListener: null as
    | null
    | ((
        value: import("./services/summary-sync.js").GenerationActivity | null,
      ) => void),
  noteListener: null as null | ((note: Note) => void),
}));
vi.mock("./services/collaboration.js", () => ({
  CollaborativeNoteSession: class {
    constructor(
      _db: unknown,
      _id: string,
      _uid: string,
      _edit: boolean,
      private options: import("./services/collaboration.js").CollaborationOptions,
    ) {}
    async start() {
      mocks.noteListener = this.options.onNote ?? null;
      this.options.onStatus?.("saved");
      return mocks.currentNote!;
    }
    async flush() {
      await mocks.originalFlush();
      return mocks.currentNote!;
    }
    updateText(value: string) {
      mocks.currentNote = {
        ...mocks.currentNote!,
        content: value,
        revision: mocks.currentNote!.revision + 1,
      };
      this.options.onContent?.(value);
      this.options.onNote?.(mocks.currentNote);
      this.options.onStatus?.("saved");
    }
    destroy() {}
  },
}));
vi.mock("./services/summary-sync.js", () => ({
  watchSummaryHistory: vi.fn((_db, id, callback) => {
    let active = true;
    mocks.historyListener = callback;
    void mocks
      .apiRequest(`/api/notes/${id}/summaries`)
      .then((data: { summaries: Summary[] }) => {
        if (active) callback(data.summaries);
      });
    return () => {
      active = false;
      mocks.historyListener = null;
    };
  }),
  watchGenerationActivity: vi.fn((_db, _id, callback) => {
    mocks.activityListener = callback;
    return () => {
      mocks.activityListener = null;
    };
  }),
  CollaborativeSummarySession: class {
    constructor(
      _db: unknown,
      _note: string,
      _summary: string,
      _edit: boolean,
      private options: import("./services/summary-sync.js").SummarySessionOptions,
    ) {}
    async start() {
      this.options.onStatus("saved");
      mocks.summaryDraftListener = this.options.onDraft;
    }
    update(field: string, value: string) {
      mocks.summaryUpdate(field, value);
    }
    async retry() {}
    async flush() {
      await mocks.summaryFlush();
    }
    destroy() {}
  },
}));
vi.mock("./firebase.js", () => ({ db: {}, auth: {} }));
vi.mock("./auth/useAuth.js", () => ({
  useAuth: () => ({
    user: { uid: "owner", displayName: "Owner", email: "owner@example.test" },
    loading: false,
    logout: mocks.logout,
  }),
}));
vi.mock("./i18n/LanguageSwitcher.js", () => ({ LanguageSwitcher: () => null }));
vi.mock("firebase/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("firebase/firestore")>()),
  doc: vi.fn(() => ({})),
  getDoc: vi.fn(async () => ({ exists: () => false })),
}));
vi.mock("./services/api.js", () => ({
  apiRequest: mocks.apiRequest,
  friendlyError: () => "Request failed",
}));
vi.mock("./services/notes.js", () => ({
  getNote: mocks.getNote,
  updateNoteFields: mocks.updateNoteFields,
  createNote: vi.fn(() => new Promise(() => {})),
  loadNotes: vi.fn(),
  loadSharedNotes: vi.fn(),
  setNoteStatus: vi.fn(),
  NoteRevisionConflict: class extends Error {},
}));

import { NoteEditorRoute, ProfilePage } from "./App.js";

const note: Note = {
  id: "note-1",
  ownerUid: "owner",
  title: "Source note",
  titleNormalized: "source note",
  content: "Original source content.",
  tags: ["existing"],
  revision: 2,
  status: "active",
  summaryCount: 2,
  favorite: false,
  createdAt: new Date("2026-10-01T10:00:00Z"),
  updatedAt: new Date("2026-10-02T10:00:00Z"),
};
const latest: Summary = {
  id: "latest",
  noteId: note.id,
  sourceRevision: 2,
  shortText: "Latest saved summary.",
  keyPoints: ["Latest key point."],
  tags: ["study"],
  suggestedTags: ["study"],
  suggestedTitle: "AI note title",
  modelId: "gemini-3.5-flash-lite",
  promptVersion: "v1",
  durationMs: 1500,
  generationStatus: "ready",
  isUserEdited: true,
  createdAt: new Date("2026-10-02T10:00:00Z"),
};
const older: Summary = {
  ...latest,
  id: "older",
  sourceRevision: 1,
  shortText: "Older saved summary.",
  createdAt: new Date("2026-10-01T10:00:00Z"),
};

beforeEach(() => {
  localStorage.clear();
  mocks.currentNote = { ...note, tags: [...note.tags] };
  mocks.logout.mockResolvedValue(undefined);
  mocks.originalFlush.mockResolvedValue(undefined);
  mocks.summaryFlush.mockResolvedValue(undefined);
  mocks.getNote.mockResolvedValue(mocks.currentNote);
  mocks.updateNoteFields.mockImplementation(async (_id, fields) => {
    mocks.currentNote = { ...mocks.currentNote!, ...fields };
    return mocks.currentNote;
  });
  mocks.apiRequest.mockImplementation(
    async (path: string, init?: RequestInit) => {
      if (path === "/api/models")
        return {
          defaultModelId: "gemini-3.5-flash-lite",
          models: [
            { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite" },
            { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
          ],
        };
      if (path === "/api/summarize") {
        const input = JSON.parse(init?.body as string);
        return {
          noteId: note.id,
          sourceRevision: 2,
          requestId: input.requestId,
          modelId: input.modelId,
          promptVersion: "v1",
          durationMs: 100,
          outdated: false,
          saved: false,
          summary: {
            shortText: "Fresh summary.",
            keyPoints: ["Fresh key point."],
            tags: input.options.generateTags ? ["study"] : [],
            ...(input.options.generateTitle
              ? { suggestedTitle: "Fresh title" }
              : {}),
          },
        };
      }
      if (path.endsWith("/feedback")) return { saved: true };
      if (path.endsWith("/shares")) return { shares: [] };
      if (path.startsWith("/api/summarization/limits"))
        return {
          provider: "gemini",
          serverTime: new Date().toISOString(),
          budget: {
            currency: "USD",
            limitUsd: 0.1,
            spentUsd: 0.03,
            reservedUsd: 0,
            remainingUsd: 0.07,
            windowSeconds: 3600,
            windowStartedAt: new Date().toISOString(),
            resetsAt: new Date(Date.now() + 30000).toISOString(),
            scope: "user",
            inputTokens: 1000,
            outputTokens: 100,
            thinkingTokens: 50,
            unreportedCalls: 0,
          },
          pricing: null,
          text: { maxCharacters: 50000 },
          generation: { deadlineSeconds: 600, maxConcurrentPerNote: 1 },
          providerQuota: { available: false },
        };
      if (path.endsWith("/summaries") && init?.method === "POST") {
        const input = JSON.parse(init.body as string);
        return {
          ...latest,
          ...input.summary,
          id: "edited",
          sourceRevision: input.sourceRevision,
          suggestedTags: input.summary.tags,
          baseSummaryId: input.baseSummaryId,
        };
      }
      if (path.endsWith("/summaries")) return { summaries: [latest, older] };
      throw new Error(`Unexpected test path: ${path}`);
    },
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function openEditorPanel() {
  const user = userEvent.setup();
  render(
    <I18nProvider>
      <MemoryRouter initialEntries={["/notes/note-1"]}>
        <Routes>
          <Route path="/notes/new" element={<NoteEditorRoute />} />
          <Route path="/notes/:noteId" element={<NoteEditorRoute />} />
          <Route path="/notes" element={<div>Notes destination</div>} />
          <Route path="/profile" element={<ProfilePage />} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
  await screen.findByDisplayValue(note.title);
  expect(
    screen.queryByRole("heading", { name: "Асистент узагальнення" }),
  ).not.toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "Відкрити узагальнення" }),
  );
  await screen.findByText(latest.shortText);
  return user;
}

describe("note summary workspace", () => {
  it("collapses all generation controls while keeping the saved result and history available", async () => {
    const user = await openEditorPanel();
    const model = screen.getByRole("combobox", { name: "Модель" });
    await user.selectOptions(model, "gemini-3.8-flash");
    await user.click(
      screen.getByRole("button", { name: "Згорнути годинний бюджет" }),
    );
    const collapse = screen.getByRole("button", {
      name: "Згорнути параметри узагальнення",
    });
    await user.click(collapse);
    expect(collapse).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("combobox", { name: "Модель" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Узагальнити" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(latest.shortText)).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: /Історія результатів/ }),
    );
    await user.click(screen.getByText(older.shortText));
    expect(screen.getAllByText(older.shortText)[0]).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Розгорнути параметри узагальнення" }),
    );
    expect(screen.getByRole("combobox", { name: "Модель" })).toHaveValue(
      "gemini-3.8-flash",
    );
    expect(
      screen.getByRole("button", { name: "Розгорнути годинний бюджет" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps generation running while its controls are collapsed and allows cancellation after reopening", async () => {
    const original = mocks.apiRequest.getMockImplementation()!;
    mocks.apiRequest.mockImplementation((path, init) => {
      if (path === "/api/summarize") return new Promise(() => {});
      if (path.endsWith("/cancel")) return Promise.resolve({ cancelled: true });
      return original(path, init);
    });
    const user = await openEditorPanel();
    await user.click(screen.getByRole("button", { name: "Узагальнити" }));
    await user.click(
      screen.getByRole("button", { name: "Згорнути параметри узагальнення" }),
    );
    expect(screen.getByText("Формуємо короткий зміст…")).toBeVisible();
    expect(
      mocks.apiRequest.mock.calls.some(([path]) => path.endsWith("/cancel")),
    ).toBe(false);
    await user.click(
      screen.getByRole("button", { name: "Розгорнути параметри узагальнення" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Скасувати узагальнення" }),
    );
    await waitFor(() =>
      expect(
        mocks.apiRequest.mock.calls.some(([path]) => path.endsWith("/cancel")),
      ).toBe(true),
    );
  });

  it("recovers the model catalog on panel opening and preserves the selection on focus", async () => {
    const original = mocks.apiRequest.getMockImplementation()!;
    const models = vi
      .fn()
      .mockRejectedValueOnce(new Error("API unavailable"))
      .mockImplementation(() => original("/api/models"));
    mocks.apiRequest.mockImplementation((path, init) =>
      path === "/api/models" ? models() : original(path, init),
    );
    const user = await openEditorPanel();
    const select = screen.getByRole("combobox", { name: "Модель" });
    await waitFor(() => expect(select).toBeEnabled());
    expect(models).toHaveBeenCalledTimes(2);
    await user.selectOptions(select, "gemini-3.8-flash");
    const beforeFocus = models.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(models.mock.calls.length).toBe(beforeFocus + 1));
    expect(select).toHaveValue("gemini-3.8-flash");
  });

  it("offers manual model retry and shares requests while a retry is pending", async () => {
    const original = mocks.apiRequest.getMockImplementation()!;
    let finish!: (catalog: SummaryModelCatalog) => void;
    const models = vi
      .fn()
      .mockRejectedValueOnce(new Error("API unavailable"))
      .mockRejectedValueOnce(new Error("API unavailable"))
      .mockImplementationOnce(
        () =>
          new Promise<SummaryModelCatalog>((resolve) => {
            finish = resolve;
          }),
      );
    mocks.apiRequest.mockImplementation((path, init) =>
      path === "/api/models" ? models() : original(path, init),
    );
    const user = await openEditorPanel();
    const select = screen.getByRole("combobox", { name: "Модель" });
    expect(select).toBeDisabled();
    await user.click(
      await screen.findByRole("button", {
        name: "Повторити завантаження моделей",
      }),
    );
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(models).toHaveBeenCalledTimes(3);
    await act(async () => finish(await original("/api/models")));
    await waitFor(() => expect(select).toBeEnabled());
    expect(select).toHaveValue("gemini-3.5-flash-lite");
    expect(
      screen.queryByRole("button", {
        name: "Повторити завантаження моделей",
      }),
    ).not.toBeInTheDocument();
  });

  it("confirms deletion in an app dialog and can cancel without a request", async () => {
    const nativeConfirm = vi.spyOn(window, "confirm");
    const user = await openEditorPanel();
    const trigger = screen.getByRole("button", { name: "Видалити" });
    await user.click(trigger);
    const dialog = screen.getByRole("alertdialog", {
      name: "Видалити нотатку?",
    });
    expect(within(dialog).getByText(note.title)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Скасувати" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(
      mocks.apiRequest.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(false);
    expect(nativeConfirm).not.toHaveBeenCalled();
    nativeConfirm.mockRestore();
  });

  it("keeps deletion errors local and deletes only after explicit confirmation", async () => {
    const original = mocks.apiRequest.getMockImplementation()!;
    const remove = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ deleted: true });
    mocks.apiRequest.mockImplementation((path, init) =>
      path === "/api/notes/note-1" && init?.method === "DELETE"
        ? remove()
        : original(path, init),
    );
    const user = await openEditorPanel();
    await user.click(screen.getByRole("button", { name: "Видалити" }));
    const dialog = screen.getByRole("alertdialog");
    expect(remove).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Видалити" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Request failed",
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    await user.click(within(dialog).getByRole("button", { name: "Видалити" }));
    expect(await screen.findByText("Notes destination")).toBeInTheDocument();
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("warns before sign-out and waits for note/summary writes", async () => {
    const user = await openEditorPanel();
    await user.click(screen.getByRole("button", { name: "Вийти" }));
    let dialog = screen.getByRole("alertdialog", { name: "Вийти з Notach?" });
    await user.click(within(dialog).getByRole("button", { name: "Скасувати" }));
    expect(mocks.logout).not.toHaveBeenCalled();
    let finish!: () => void;
    mocks.originalFlush.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await user.click(screen.getByRole("button", { name: "Вийти" }));
    dialog = screen.getByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Вийти" }));
    expect(mocks.logout).not.toHaveBeenCalled();
    await act(async () => finish());
    await waitFor(() => expect(mocks.logout).toHaveBeenCalledOnce());
    expect(mocks.summaryFlush).toHaveBeenCalledOnce();
  });

  it("stays signed in and retains the dialog if pending edits cannot save", async () => {
    const user = await openEditorPanel();
    mocks.originalFlush.mockRejectedValueOnce(new Error("offline"));
    await user.click(screen.getByRole("button", { name: "Вийти" }));
    const dialog = screen.getByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Вийти" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Request failed",
    );
    expect(mocks.logout).not.toHaveBeenCalled();
    expect(screen.queryByText("Notes destination")).not.toBeInTheDocument();
  });

  it("has a single sign-out entry in the sidebar rather than the profile form", async () => {
    const user = await openEditorPanel();
    await user.click(screen.getByRole("link", { name: "Профіль" }));
    expect(
      await screen.findByRole("button", { name: "Зберегти профіль" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Вийти" })).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "Вийти з облікового запису" }),
    ).not.toBeInTheDocument();
  });

  it("uses a custom navigation warning and saves pending edits before leaving", async () => {
    const user = await openEditorPanel();
    fireEvent.change(screen.getByDisplayValue(note.title), {
      target: { value: "Unsaved title" },
    });
    await user.click(screen.getByRole("link", { name: "Профіль" }));
    let dialog = screen.getByRole("alertdialog", {
      name: "Залишити редактор?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Скасувати" }));
    expect(screen.getByDisplayValue("Unsaved title")).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Профіль" }));
    dialog = screen.getByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Зберегти й перейти" }),
    );
    expect(
      await screen.findByRole("button", { name: "Зберегти профіль" }),
    ).toBeInTheDocument();
    expect(mocks.updateNoteFields).toHaveBeenCalledWith(
      "note-1",
      expect.objectContaining({ title: "Unsaved title" }),
      expect.any(Object),
    );
  });

  it("shows share failures inside the dialog and dismisses them without losing the address", async () => {
    const original = mocks.apiRequest.getMockImplementation()!;
    mocks.apiRequest.mockImplementation((path, init) => {
      if (path.endsWith("/shares") && init?.method === "POST")
        return Promise.reject({ code: "USER_NOT_FOUND" });
      return original(path, init);
    });
    const user = await openEditorPanel();
    const trigger = screen.getByRole("button", { name: "Поділитися" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Надати доступ" });
    await user.type(
      within(dialog).getByRole("textbox", { name: "Пошта" }),
      "missing@example.test",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Надати доступ" }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Request failed",
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    await user.click(
      within(dialog).getByRole("button", { name: "Закрити помилку" }),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: "Пошта" })).toHaveValue(
      "missing@example.test",
    );
    expect(
      within(dialog).getByRole("textbox", { name: "Пошта" }),
    ).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "Закрити" }));
    expect(trigger).toHaveFocus();
  });

  it("uses the same primary button for generation and cancellation and has one panel hide control", async () => {
    const original = mocks.apiRequest.getMockImplementation()!;
    let complete!: (result: unknown) => void;
    mocks.apiRequest.mockImplementation((path, init) => {
      if (path === "/api/summarize")
        return new Promise((resolve) => {
          complete = resolve;
        });
      if (path.endsWith("/cancel")) return Promise.resolve({ cancelled: true });
      return original(path, init);
    });
    const user = await openEditorPanel();
    expect(
      screen.getAllByRole("button", { name: "Приховати узагальнення" }),
    ).toHaveLength(1);
    const primary = screen.getByRole("button", { name: "Узагальнити" });
    await user.click(primary);
    expect(screen.getByRole("button", { name: "Скасувати узагальнення" })).toBe(
      primary,
    );
    await user.type(screen.getByRole("textbox", { name: "Назва" }), " pending");
    expect(primary).toBeEnabled();
    await user.click(primary);
    await act(async () =>
      complete({
        saved: true,
        summaryId: "late",
        summary: { shortText: "Late", keyPoints: ["Fact"], tags: [] },
      }),
    );
    expect(screen.queryByText("Late")).not.toBeInTheDocument();
  });

  it("always shows the hourly budget in the summary panel", async () => {
    await openEditorPanel();
    await screen.findByText(/Залишилося: 0,07/);
    expect(
      screen.getByRole("heading", { name: "Годинний бюджет" }),
    ).toBeInTheDocument();
    expect(
      mocks.apiRequest.mock.calls.some(([path]) => path === "/api/summarize"),
    ).toBe(false);
    expect(
      screen.queryByRole("button", { name: "Приховати ліміти" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("cancels the current shared job while a cancelled local HTTP request remains pending", async () => {
    const original = mocks.apiRequest.getMockImplementation()!;
    let finish!: (value: unknown) => void;
    mocks.apiRequest.mockImplementation((path, init) => {
      if (path === "/api/summarize")
        return new Promise((resolve) => {
          finish = resolve;
        });
      if (path.endsWith("/cancel")) return Promise.resolve({ cancelled: true });
      return original(path, init);
    });
    const user = await openEditorPanel();
    await user.click(screen.getByRole("button", { name: "Узагальнити" }));
    await user.click(
      screen.getByRole("button", { name: "Скасувати узагальнення" }),
    );
    act(() =>
      mocks.activityListener?.({
        requestId: "new-remote-job",
        status: "generating",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Скасувати узагальнення" }),
    );
    expect(mocks.apiRequest).toHaveBeenCalledWith(
      "/api/notes/note-1/generation/new-remote-job/cancel",
      expect.objectContaining({ method: "POST" }),
    );
    await act(async () =>
      finish({
        saved: true,
        summaryId: "late",
        summary: { shortText: "Late", keyPoints: ["Fact"], tags: [] },
      }),
    );
  });

  it("dismisses a generation error and keeps the editor and retry action available", async () => {
    const original = mocks.apiRequest.getMockImplementation()!;
    mocks.apiRequest.mockImplementation((path, init) =>
      path === "/api/summarize"
        ? Promise.reject({ code: "AI_UNAVAILABLE" })
        : original(path, init),
    );
    const user = await openEditorPanel();
    await user.click(screen.getByRole("button", { name: "Узагальнити" }));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Закрити помилку" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Текст нотатки" })).toHaveValue(
      note.content,
    );
    expect(screen.getByRole("button", { name: "Узагальнити" })).toBeEnabled();
  });
  it("keeps the new option cards keyboard accessible with explanatory labels", async () => {
    const user = await openEditorPanel();
    const tags = screen.getByRole("checkbox", { name: "Теги" });
    const title = screen.getByRole("checkbox", { name: "Назва" });
    expect(tags).toHaveAccessibleDescription("Запропонувати тематичні теги");
    expect(title).toHaveAccessibleDescription("Запропонувати назву нотатки");
    tags.focus();
    await user.keyboard("[Space]");
    expect(tags).not.toBeChecked();
    await user.tab();
    expect(title).toHaveFocus();
    await user.keyboard("[Space]");
    expect(title).not.toBeChecked();
  });
  it("autosaves manual title and tag changes and receives remote metadata", async () => {
    const user = await openEditorPanel();
    expect(
      screen.queryByRole("button", { name: /^Зберегти$/ }),
    ).not.toBeInTheDocument();
    const title = screen.getByRole("textbox", { name: "Назва" });
    await user.clear(title);
    await user.type(title, "Changed title");
    await waitFor(() => expect(mocks.currentNote?.title).toBe("Changed title"));
    await user.type(
      screen.getByRole("textbox", { name: "Новий тег" }),
      "manual{Enter}",
    );
    await waitFor(() => expect(mocks.currentNote?.tags).toContain("manual"));
    act(() =>
      mocks.noteListener?.({
        ...mocks.currentNote!,
        title: "Remote title",
        tags: ["remote"],
      }),
    );
    expect(title).toHaveValue("Remote title");
    expect(
      screen.getByRole("button", { name: "Видалити тег remote" }),
    ).toBeInTheDocument();
  });

  it("receives another user's generated summary and live history", async () => {
    const user = await openEditorPanel();
    const remote = {
      ...latest,
      id: "remote",
      shortText: "Remote generated summary.",
    };
    act(() => mocks.historyListener?.([remote, latest, older]));
    await screen.findByText(remote.shortText);
    await user.click(
      screen.getByRole("button", { name: /Історія результатів/ }),
    );
    // The history button opens the existing live collection without an API refresh.
    expect(mocks.historyListener).not.toBeNull();
  });

  it("can cancel another editor's running generation", async () => {
    const original = mocks.apiRequest.getMockImplementation()!;
    mocks.apiRequest.mockImplementation((path, init) =>
      path.endsWith("/cancel")
        ? Promise.resolve({ cancelled: true })
        : original(path, init),
    );
    const user = await openEditorPanel();
    act(() =>
      mocks.activityListener?.({
        requestId: "remote-job",
        status: "generating",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Скасувати узагальнення" }),
    );
    expect(mocks.apiRequest).toHaveBeenCalledWith(
      "/api/notes/note-1/generation/remote-job/cancel",
      expect.objectContaining({ method: "POST" }),
    );
    await screen.findByText("Узагальнення скасовано.");
  });
  it("restores the latest summary and opens history without generating again", async () => {
    const user = await openEditorPanel();
    await user.click(
      screen.getByRole("button", { name: /Історія результатів/ }),
    );
    await user.click(
      await screen.findByRole("button", { name: /Older saved summary/ }),
    );
    expect(screen.getByText(older.shortText)).toBeInTheDocument();
    expect(
      mocks.apiRequest.mock.calls.some(([path]) => path === "/api/summarize"),
    ).toBe(false);
  });

  it("discards a late response after locally cancelling generation", async () => {
    const original = mocks.apiRequest.getMockImplementation()!;
    let finish!: (value: unknown) => void;
    mocks.apiRequest.mockImplementation((path, init) => {
      if (path === "/api/summarize")
        return new Promise((resolve) => {
          finish = resolve;
        });
      if (path.endsWith("/cancel")) return Promise.resolve({ cancelled: true });
      return original(path, init);
    });
    const user = await openEditorPanel();
    await user.click(screen.getByRole("button", { name: "Узагальнити" }));
    await user.click(
      screen.getByRole("button", { name: "Скасувати узагальнення" }),
    );
    await act(async () =>
      finish({
        saved: true,
        summaryId: "late",
        summary: { shortText: "Late result", keyPoints: ["Fact"], tags: [] },
      }),
    );
    expect(screen.queryByText("Late result")).not.toBeInTheDocument();
    expect(screen.getByText(latest.shortText)).toBeInTheDocument();
  });

  it("receives live summary field edits while keeping the active editor open", async () => {
    const user = await openEditorPanel();
    await user.click(screen.getByRole("button", { name: "Редагувати" }));
    act(() =>
      mocks.summaryDraftListener?.({
        shortText: "Remote edit ",
        pointsText: "Remote fact ",
        tagsText: "remote",
        suggestedTitle: "Remote proposal",
      }),
    );
    expect(
      screen.getByRole("textbox", { name: "Редагувати короткий зміст" }),
    ).toHaveValue("Remote edit ");
    expect(
      screen.getByRole("textbox", { name: "Редагувати основні думки" }),
    ).toHaveValue("Remote fact ");
    expect(
      screen.getByRole("button", { name: "Завершити редагування" }),
    ).toBeInTheDocument();
  });

  it("keeps rating fields collapsed and collapses them after saving feedback", async () => {
    const user = await openEditorPanel();
    expect(
      screen.queryByRole("radiogroup", { name: "Оцінка від 1 до 5" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Оцінити результат" }));
    expect(
      screen.getByRole("radiogroup", { name: "Оцінка від 1 до 5" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Зберегти оцінку" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("radiogroup", { name: "Оцінка від 1 до 5" }),
      ).not.toBeInTheDocument(),
    );
    expect(mocks.apiRequest).toHaveBeenCalledWith(
      "/api/notes/note-1/summaries/latest/feedback",
      expect.any(Object),
    );
  });

  it("keeps failed feedback in its form and dismisses the error without losing the rating or comment", async () => {
    const original = mocks.apiRequest.getMockImplementation()!;
    mocks.apiRequest.mockImplementation((path, init) =>
      path.endsWith("/feedback")
        ? Promise.reject({ code: "API_UNAVAILABLE" })
        : original(path, init),
    );
    const user = await openEditorPanel();
    await user.click(screen.getByRole("button", { name: "Оцінити результат" }));
    await user.click(screen.getByRole("radio", { name: "2 з 5" }));
    await user.type(
      screen.getByRole("textbox", { name: "Коментар" }),
      "Keep this comment",
    );
    await user.click(screen.getByRole("button", { name: "Зберегти оцінку" }));
    const error = await screen.findByRole("alert");
    expect(document.getElementById("summary-feedback")).toContainElement(error);
    await user.click(
      within(error).getByRole("button", { name: "Закрити помилку" }),
    );
    expect(screen.getByRole("radio", { name: "2 з 5" })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "Коментар" })).toHaveValue(
      "Keep this comment",
    );
  });

  it("merges suggested tags into the editable note and preserves original content", async () => {
    const user = await openEditorPanel();
    await user.click(screen.getByRole("button", { name: "Застосувати теги" }));
    expect(
      screen.getByRole("button", { name: "Видалити тег existing" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Видалити тег study" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "Це узагальнення створено для попередньої версії нотатки.",
      ),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.updateNoteFields).toHaveBeenCalledWith(
        note.id,
        { tags: ["existing", "study"] },
        { mergeTags: true },
      ),
    );
    expect(mocks.currentNote?.content).toBe(note.content);
  });

  it("sends the selected model and hides suggested tags when tag generation is disabled", async () => {
    const user = await openEditorPanel();
    expect(
      screen.getByRole("heading", { name: "Запропоновані теги" }),
    ).toBeInTheDocument();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Модель" }),
      "gemini-3.8-flash",
    );
    await user.click(screen.getByRole("checkbox", { name: "Теги" }));
    expect(
      screen.queryByRole("heading", { name: "Запропоновані теги" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Узагальнити" }));
    await screen.findByText("Fresh summary.");
    const request = mocks.apiRequest.mock.calls.find(
      ([path]) => path === "/api/summarize",
    );
    expect(JSON.parse(request![1].body)).toMatchObject({
      modelId: "gemini-3.8-flash",
      options: { generateTags: false },
    });
    expect(
      screen.queryByRole("heading", { name: "Запропоновані теги" }),
    ).not.toBeInTheDocument();
  });

  it("automatically saves a suggested title and favorite without replacing text", async () => {
    const user = await openEditorPanel();
    await user.click(screen.getByRole("button", { name: "Застосувати назву" }));
    await waitFor(() =>
      expect(mocks.updateNoteFields).toHaveBeenCalledWith(
        note.id,
        { title: "AI note title" },
        { mergeTags: false },
      ),
    );
    expect(screen.getByRole("textbox", { name: "Назва" })).toHaveValue(
      "AI note title",
    );
    await user.click(
      screen.getByRole("button", { name: "Додати до вибраного" }),
    );
    await waitFor(() =>
      expect(mocks.updateNoteFields).toHaveBeenCalledWith(
        note.id,
        { favorite: true },
        { mergeTags: false },
      ),
    );
    expect(mocks.currentNote?.content).toBe(note.content);
  });

  it("synchronizes raw edits to a historical summary without a Save button", async () => {
    const user = await openEditorPanel();
    await user.click(
      screen.getByRole("button", { name: /Історія результатів/ }),
    );
    await user.click(
      await screen.findByRole("button", { name: /Older saved summary/ }),
    );
    await user.click(screen.getByRole("button", { name: "Редагувати" }));
    const points = screen.getByRole("textbox", {
      name: "Редагувати основні думки",
    });
    await user.clear(points);
    await user.type(points, "First point \nSecond point ");
    expect(points).toHaveValue("First point \nSecond point ");
    expect(mocks.summaryUpdate).toHaveBeenLastCalledWith(
      "pointsText",
      "First point \nSecond point ",
    );
    expect(
      screen.queryByRole("button", { name: "Зберегти результат" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Завершити редагування" }),
    );
  });

  it("starts a new note with empty state and a collapsed summary panel", async () => {
    const user = await openEditorPanel();
    await user.click(screen.getByRole("link", { name: /Нова нотатка/ }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Назва" })).toHaveValue(""),
    );
    expect(screen.getByRole("textbox", { name: "Текст нотатки" })).toHaveValue(
      "",
    );
    expect(screen.queryByText(latest.shortText)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Відкрити узагальнення" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("hides and restores the left sidebar and remembers the choice", async () => {
    const user = await openEditorPanel();
    await user.click(
      screen.getByRole("button", { name: "Приховати ліву панель" }),
    );
    expect(document.getElementById("notach-sidebar")).toHaveAttribute("inert");
    expect(localStorage.getItem("notach.sidebarCollapsed")).toBe("true");
    await user.click(
      screen.getByRole("button", { name: "Показати ліву панель" }),
    );
    expect(document.getElementById("notach-sidebar")).not.toHaveAttribute(
      "inert",
    );
  });

  it("shows readable metadata for an older user-authored result without zero latency", async () => {
    const originalRequest = mocks.apiRequest.getMockImplementation()!;
    mocks.apiRequest.mockImplementation((path: string, init?: RequestInit) => {
      if (path.endsWith("/summaries") && !init?.method)
        return Promise.resolve({
          summaries: [
            latest,
            { ...older, modelId: "user-authored", durationMs: 0 },
          ],
        });
      return originalRequest(path, init);
    });
    const user = await openEditorPanel();
    await user.click(
      screen.getByRole("button", { name: /Історія результатів/ }),
    );
    await user.click(
      await screen.findByRole("button", { name: /Older saved summary/ }),
    );
    expect(screen.getByText("Відредаговано користувачем")).toBeInTheDocument();
    expect(screen.queryByText(/user-authored/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Генерація: 0/)).not.toBeInTheDocument();
  });
});
