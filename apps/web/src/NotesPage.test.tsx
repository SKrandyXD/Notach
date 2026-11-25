import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { SharedNote } from "./services/notes.js";
import { I18nProvider } from "./i18n/I18nProvider.js";

const mocks = vi.hoisted(() => ({
  listener: null as null | ((notes: SharedNote[]) => void),
  stop: vi.fn(),
}));
vi.mock("./firebase.js", () => ({ db: {}, auth: {} }));
vi.mock("./auth/useAuth.js", () => ({
  useAuth: () => ({
    user: { uid: "participant", displayName: "Participant" },
    logout: vi.fn(),
    loading: false,
  }),
}));
vi.mock("./i18n/LanguageSwitcher.js", () => ({ LanguageSwitcher: () => null }));
vi.mock("./services/notes.js", () => ({
  watchSharedNotes: (_uid: string, callback: (notes: SharedNote[]) => void) => {
    mocks.listener = callback;
    callback([]);
    return mocks.stop;
  },
}));
import { NotesPage } from "./App.js";

const sharedNote: SharedNote = {
  id: "shared-note",
  ownerUid: "someone-else",
  title: "Meeting notes",
  titleNormalized: "meeting notes",
  content: "Shared content",
  tags: ["work"],
  status: "active",
  revision: 115,
  favorite: false,
  summaryCount: 1,
  sharedRole: "viewer",
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});
afterEach(cleanup);

function openShared(path = "/shared") {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={[path]}>
        <NotesPage shared />
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("shared notes page", () => {
  it("adds grants, changes roles and content, and removes revoked notes without reload", async () => {
    const view = openShared();
    expect(screen.getByRole("link", { name: "Доступні мені" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    act(() => mocks.listener?.([sharedNote]));
    expect(
      screen.getByRole("heading", { name: sharedNote.title }),
    ).toBeInTheDocument();
    expect(screen.getByText("Перегляд")).toBeInTheDocument();
    expect(screen.queryByText(/115/)).not.toBeInTheDocument();
    act(() =>
      mocks.listener?.([
        { ...sharedNote, sharedRole: "editor", title: "Updated meeting" },
      ]),
    );
    expect(screen.getByText("Редактор")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Updated meeting" }),
    ).toBeInTheDocument();
    act(() => mocks.listener?.([]));
    expect(
      screen.queryByRole("heading", { name: "Updated meeting" }),
    ).not.toBeInTheDocument();
    view.unmount();
    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });

  it("preserves search and tag filters while receiving new notes", async () => {
    const user = userEvent.setup();
    openShared();
    act(() => mocks.listener?.([sharedNote]));
    await user.click(screen.getByRole("button", { name: "#work" }));
    await user.type(
      screen.getByRole("textbox", { name: "Пошук за назвою або текстом" }),
      "meeting",
    );
    act(() =>
      mocks.listener?.([
        sharedNote,
        {
          ...sharedNote,
          id: "other",
          title: "Meeting without selected tag",
          titleNormalized: "meeting without selected tag",
          tags: ["study"],
        },
        {
          ...sharedNote,
          id: "different",
          title: "Different topic",
          titleNormalized: "different topic",
        },
      ]),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Meeting without selected tag" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: "Different topic" }),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByRole("textbox", { name: "Пошук за назвою або текстом" }),
    ).toHaveValue("meeting");
  });

  it("ranks title matches before content matches and applies the selected sort within each group", async () => {
    const user = userEvent.setup();
    openShared();
    const items = [
      ["Meeting alpha", "No keyword in body", 1],
      ["Meeting zeta", "No keyword in body", 2],
      ["Aardvark", "MEETING agenda", 3],
      ["Zebra", "Meeting minutes", 4],
      ["Outside", "Unrelated text", 5],
    ].map(([title, content, time]) => ({
      ...sharedNote,
      id: String(title),
      title: String(title),
      titleNormalized: String(title).toLowerCase(),
      content: String(content),
      updatedAt: new Date(Number(time) * 1000),
    }));
    act(() => mocks.listener?.(items));
    const search = screen.getByRole("textbox", {
      name: "Пошук за назвою або текстом",
    });
    const visibleTitles = () =>
      screen
        .getAllByRole("heading", { level: 2 })
        .map((item) => item.textContent);
    await user.type(search, "MEETING");
    await waitFor(() =>
      expect(visibleTitles()).toEqual([
        "Meeting zeta",
        "Meeting alpha",
        "Zebra",
        "Aardvark",
      ]),
    );
    const sort = screen.getByRole("combobox", { name: "Сортування" });
    await user.selectOptions(sort, "title");
    expect(visibleTitles()).toEqual([
      "Meeting alpha",
      "Meeting zeta",
      "Aardvark",
      "Zebra",
    ]);
    await user.selectOptions(sort, "updated");
    await user.clear(search);
    await waitFor(() =>
      expect(visibleTitles()).toEqual([
        "Outside",
        "Zebra",
        "Aardvark",
        "Meeting zeta",
        "Meeting alpha",
      ]),
    );
  });

  it("normalizes content-only matches and keeps favorite and tag restrictions on live updates", async () => {
    const user = userEvent.setup();
    openShared("/shared?favorites=true");
    const match = {
      ...sharedNote,
      title: "Content match",
      titleNormalized: "content match",
      content: "Підготовка: И\u0306 ПЛАН обговорення",
      favorite: true,
    };
    act(() =>
      mocks.listener?.([
        match,
        {
          ...match,
          id: "not-favorite",
          title: "Not favorite",
          favorite: false,
        },
        { ...match, id: "other-tag", title: "Other tag", tags: ["study"] },
        { ...match, id: "unrelated", title: "Unrelated", content: "Інша тема" },
      ]),
    );
    await user.click(screen.getByRole("button", { name: "#work" }));
    await user.type(
      screen.getByRole("textbox", { name: "Пошук за назвою або текстом" }),
      "й план",
    );
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("heading", { level: 2 })
          .map((item) => item.textContent),
      ).toEqual(["Content match"]),
    );
    act(() => mocks.listener?.([{ ...match, content: "Інша тема" }]));
    expect(
      screen.queryByRole("heading", { name: "Content match" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Нічого не знайдено" }),
    ).toBeInTheDocument();
  });
});
