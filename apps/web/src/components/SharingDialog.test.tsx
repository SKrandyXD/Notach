import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../i18n/I18nProvider.js";
import { SharingDialog } from "./SharingDialog.js";

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../services/api.js", () => ({
  apiRequest: api.request,
  friendlyError: () => "Access request failed",
}));
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("sharing dialog", () => {
  it("keeps keyboard focus inside the dialog when form controls are disabled", async () => {
    let complete!: (result: unknown) => void;
    api.request.mockResolvedValue({ shares: [] });
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <SharingDialog noteId="note" onClose={() => {}} />
      </I18nProvider>,
    );
    const submit = screen.getByRole("button", { name: "Надати доступ" });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.type(
      screen.getByRole("textbox", { name: "Пошта" }),
      "person@example.test",
    );
    api.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    await user.click(submit);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await user.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    complete({ participantUid: "person" });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Надати доступ" }),
      ).toBeEnabled(),
    );
  });
  it("validates malformed addresses inside the dialog without sending them to the server", async () => {
    api.request.mockResolvedValue({ shares: [] });
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <SharingDialog noteId="note" onClose={() => {}} />
      </I18nProvider>,
    );
    const submit = screen.getByRole("button", { name: "Надати доступ" });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.type(
      screen.getByRole("textbox", { name: "Пошта" }),
      "invalid-address",
    );
    await user.click(submit);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Access request failed",
    );
    expect(api.request).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Закрити помилку" }));
    expect(screen.getByRole("textbox", { name: "Пошта" })).toHaveValue(
      "invalid-address",
    );
  });

  it("keeps failed revocations visible in the dialog and clears errors on the next attempt", async () => {
    api.request.mockResolvedValue({
      shares: [
        {
          participantUid: "other",
          email: "other@example.test",
          role: "viewer",
        },
      ],
    });
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <SharingDialog noteId="note" onClose={() => {}} />
      </I18nProvider>,
    );
    const revoke = await screen.findByRole("button", { name: "Відкликати" });
    api.request.mockRejectedValueOnce(new Error("offline"));
    await user.click(revoke);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Access request failed",
    );
    expect(screen.getByText("other@example.test")).toBeInTheDocument();
    api.request.mockResolvedValueOnce({ revoked: true });
    await user.click(revoke);
    await waitFor(() =>
      expect(screen.queryByText("other@example.test")).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
