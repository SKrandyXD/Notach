import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../i18n/I18nProvider.js";
import { FeedbackForm } from "./FeedbackForm.js";

const submit = vi.fn();

function Harness({ saving = false }: { saving?: boolean }) {
  const [rating, setRating] = useState(3);
  const [comment, setComment] = useState("");
  const [accepted, setAccepted] = useState(true);
  return (
    <I18nProvider>
      <FeedbackForm
        rating={rating}
        onRatingChange={setRating}
        comment={comment}
        onCommentChange={setComment}
        accepted={accepted}
        onAcceptedChange={setAccepted}
        saving={saving}
        onSubmit={() => submit({ rating, comment, accepted })}
      />
    </I18nProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
  submit.mockClear();
});
afterEach(cleanup);

describe("summary feedback form", () => {
  it("lets keyboard users select exactly one rating with native radio navigation", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(
      screen.getByRole("radiogroup", { name: "Оцінка від 1 до 5" }),
    ).toBeInTheDocument();
    const third = screen.getByRole("radio", { name: "3 з 5" });
    expect(third).toBeChecked();
    third.focus();
    await user.keyboard("[ArrowRight]");
    expect(screen.getByRole("radio", { name: "4 з 5" })).toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent("Добрий результат");
    expect(
      screen
        .getAllByRole("radio")
        .filter((radio) => (radio as HTMLInputElement).checked),
    ).toHaveLength(1);
    await user.keyboard("[ArrowRight][ArrowRight]");
    expect(screen.getByRole("radio", { name: "1 з 5" })).toBeChecked();
  });

  it("submits the selected rating, optional comment and acceptance together", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("radio", { name: "5 з 5" }));
    await user.type(
      screen.getByRole("textbox", { name: "Коментар" }),
      "Useful summary",
    );
    await user.click(
      screen.getByRole("checkbox", { name: "Результат мені підходить" }),
    );
    await user.click(screen.getByRole("button", { name: "Зберегти оцінку" }));
    expect(submit).toHaveBeenCalledWith({
      rating: 5,
      comment: "Useful summary",
      accepted: false,
    });
  });

  it("prevents duplicate submissions and field edits while saving", async () => {
    const user = userEvent.setup();
    render(<Harness saving />);
    for (const radio of screen.getAllByRole("radio"))
      expect(radio).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Коментар" })).toBeDisabled();
    expect(screen.getByRole("checkbox")).toBeDisabled();
    const button = screen.getByRole("button", { name: "Збереження…" });
    expect(button).toHaveAttribute("aria-busy", "true");
    await user.click(button);
    expect(submit).not.toHaveBeenCalled();
  });
});
