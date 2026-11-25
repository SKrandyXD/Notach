import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../i18n/I18nProvider.js";
import { ErrorAlert } from "./ErrorAlert.js";

vi.mock("../services/api.js", () => ({
  friendlyError: () => "Failure message",
}));
beforeEach(() => localStorage.clear());
afterEach(cleanup);

it("dismisses an inline error inside a form without submitting or losing input", async () => {
  const submit = vi.fn();
  function Harness() {
    const [error, setError] = useState<unknown>(new Error("failed"));
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <input aria-label="Draft" defaultValue="Keep my input" />
        {error !== null && (
          <ErrorAlert error={error} onDismiss={() => setError(null)} />
        )}
      </form>
    );
  }
  const user = userEvent.setup();
  render(
    <I18nProvider>
      <Harness />
    </I18nProvider>,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("Failure message");
  await user.click(screen.getByRole("button", { name: "Закрити помилку" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Draft" })).toHaveValue(
    "Keep my input",
  );
  expect(submit).not.toHaveBeenCalled();
});
