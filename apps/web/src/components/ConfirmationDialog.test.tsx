import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../i18n/I18nProvider.js";
import { ConfirmationDialog } from "./ConfirmationDialog.js";

afterEach(cleanup);

function mount(onConfirm = vi.fn(async () => undefined), onClose = vi.fn()) {
  const view = render(
    <I18nProvider>
      <ConfirmationDialog
        title="Видалити нотатку?"
        description="Нотатку буде видалено."
        confirmLabel="Видалити"
        pendingLabel="Видаляємо…"
        tone="danger"
        onConfirm={onConfirm}
        onClose={onClose}
      />
    </I18nProvider>,
  );
  return { ...view, onConfirm, onClose };
}

describe("confirmation dialog", () => {
  it("focuses cancellation, traps keyboard focus and cancels with Escape", async () => {
    const user = userEvent.setup();
    const { onConfirm, onClose } = mount();
    const dialog = screen.getByRole("alertdialog", {
      name: "Видалити нотатку?",
    });
    const cancel = within(dialog).getByRole("button", { name: "Скасувати" });
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(
      within(dialog).getByRole("button", { name: "Видалити" }),
    ).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("makes the background inert and restores focus and scrolling on close", () => {
    const background = document.createElement("button");
    background.textContent = "Trigger";
    document.body.append(background);
    background.focus();
    const { unmount } = mount();
    expect(background.inert).toBe(true);
    expect(background).toHaveAttribute("aria-hidden", "true");
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(background.inert).toBeFalsy();
    expect(background).not.toHaveAttribute("aria-hidden");
    expect(background).toHaveFocus();
    expect(document.body.style.overflow).toBe("");
    background.remove();
  });

  it("blocks duplicate actions and dismissal while the action is pending", async () => {
    const user = userEvent.setup();
    let finish!: () => void;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { onClose } = mount(onConfirm);
    await user.dblClick(screen.getByRole("button", { name: "Видалити" }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Скасувати" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("retains a failed action in the dialog for retry", async () => {
    const user = userEvent.setup();
    const onConfirm = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    const { onClose } = mount(onConfirm);
    await user.click(screen.getByRole("button", { name: "Видалити" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByRole("alert")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Видалити" }));
    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
