import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { SummarizationLimits } from "@notach/shared";
import { I18nProvider } from "../i18n/I18nProvider.js";
import { SummaryLimitsPanel } from "./SummaryLimitsPanel.js";

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../services/api.js", () => ({
  apiRequest: api.request,
  friendlyError: () => "Limits unavailable",
}));

const limits: SummarizationLimits = {
  provider: "gemini",
  serverTime: "2026-10-28T10:59:50Z",
  budget: {
    currency: "USD",
    limitUsd: 0.1,
    spentUsd: 0.03,
    reservedUsd: 0.01,
    remainingUsd: 0.06,
    windowSeconds: 3600,
    windowStartedAt: "2026-10-28T10:00:00Z",
    resetsAt: "2026-10-28T11:00:00Z",
    scope: "user",
    inputTokens: 1500,
    outputTokens: 900,
    thinkingTokens: 300,
    unreportedCalls: 1,
  },
  pricing: {
    modelId: "gemini-3.5-flash-lite",
    inputUsdPerMillionTokens: 0.3,
    outputUsdPerMillionTokens: 2.5,
    cachedInputUsdPerMillionTokens: 0.03,
  },
  text: { maxCharacters: 50000 },
  generation: { deadlineSeconds: 600, maxConcurrentPerNote: 1 },
  providerQuota: { available: false },
};
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.useFakeTimers();
  // Deliberately different from the server clock.
  vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
  api.request.mockResolvedValue(limits);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("summary limits", () => {
  it("collapses independently while keeping the budget fresh", async () => {
    await act(async () => {
      render(
        <I18nProvider>
          <SummaryLimitsPanel refreshKey="idle" />
        </I18nProvider>,
      );
    });
    const collapse = screen.getByRole("button", {
      name: "Згорнути годинний бюджет",
    });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(collapse);
    expect(collapse).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Оновити ліміти" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Залишилося: 0,06/)).not.toBeVisible();
    api.request.mockResolvedValue({
      ...limits,
      serverTime: "2026-10-28T11:00:05Z",
      budget: {
        ...limits.budget,
        resetsAt: "2026-10-28T12:00:00Z",
        remainingUsd: 0.04,
      },
    });
    await act(async () => {
      vi.advanceTimersByTime(15000);
    });
    expect(api.request.mock.calls.length).toBeGreaterThan(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Розгорнути годинний бюджет" }),
    );
    expect(screen.getByText(/Залишилося: 0,04/)).toBeVisible();
    expect(screen.getByRole("progressbar")).toBeVisible();
  });

  it("shows the monetary budget, reservation and token costs immediately", async () => {
    await act(async () => {
      render(
        <I18nProvider>
          <SummaryLimitsPanel
            refreshKey="idle"
            modelId="gemini-3.5-flash-lite"
          />
        </I18nProvider>,
      );
    });
    expect(screen.getByText(/Залишилося: 0,06/)).toBeInTheDocument();
    expect(
      screen.getByText(/Зарезервовано для генерації: 0,01/),
    ).toBeInTheDocument();
    expect(screen.getByText("Оновиться через 0:10")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "0.04");
    expect(screen.getByRole("progressbar")).toHaveAttribute("max", "0.1");
    fireEvent.click(screen.getByText("Токени та розрахунок вартості"));
    expect(screen.getByText("gemini-3.5-flash-lite")).toBeInTheDocument();
    expect(
      screen.getByText(/Викликів без звіту про токени: 1/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Квота Gemini")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /Переглянути квоту/ }),
    ).not.toBeInTheDocument();
    expect(api.request).toHaveBeenCalledTimes(1);
    expect(api.request).toHaveBeenCalledWith(
      "/api/summarization/limits?modelId=gemini-3.5-flash-lite",
    );
  });

  it("refreshes at the server hour boundary without inventing released funds", async () => {
    await act(async () => {
      render(
        <I18nProvider>
          <SummaryLimitsPanel refreshKey="idle" />
        </I18nProvider>,
      );
    });
    api.request.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      vi.advanceTimersByTime(10000);
    });
    expect(api.request).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Залишилося: 0,06/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "0.04");
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("refreshes on generation state changes and stops polling after unmount", async () => {
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(
        <I18nProvider>
          <SummaryLimitsPanel refreshKey="idle" />
        </I18nProvider>,
      );
    });
    api.request.mockResolvedValue({
      ...limits,
      budget: { ...limits.budget, spentUsd: 0.05, remainingUsd: 0.04 },
    });
    await act(async () => {
      view.rerender(
        <I18nProvider>
          <SummaryLimitsPanel refreshKey="generating" />
        </I18nProvider>,
      );
    });
    expect(screen.getByText(/Залишилося: 0,04/)).toBeInTheDocument();
    expect(api.request).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(async () => {
      vi.advanceTimersByTime(30000);
    });
    expect(api.request).toHaveBeenCalledTimes(2);
  });

  it("can dismiss a fetch error and retry without starting a summary", async () => {
    api.request.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      render(
        <I18nProvider>
          <SummaryLimitsPanel refreshKey="idle" />
        </I18nProvider>,
      );
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Limits unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Закрити помилку" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Оновити ліміти" }));
    });
    expect(screen.getByText(/Залишилося: 0,06/)).toBeInTheDocument();
    expect(
      api.request.mock.calls.every(
        ([path]) => path === "/api/summarization/limits",
      ),
    ).toBe(true);
  });
});
