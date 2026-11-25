import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { SummarizationLimits } from "@notach/shared";
import { apiRequest } from "../services/api.js";
import { useI18n } from "../i18n/useI18n.js";
import { ErrorAlert } from "./ErrorAlert.js";
import { Icon } from "./Icon.js";

export function SummaryLimitsPanel({
  refreshKey,
  modelId,
}: {
  refreshKey: string;
  modelId?: string;
}) {
  const { t, locale, formatNumber } = useI18n();
  const titleId = useId();
  const contentId = useId();
  const [expanded, setExpanded] = useState(true);
  const [snapshot, setSnapshot] = useState<{
    limits: SummarizationLimits;
    receivedAt: number;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [now, setNow] = useState(Date.now);
  const requestVersion = useRef(0);
  const invalidateRequests = useCallback(() => {
    requestVersion.current++;
  }, []);
  const refreshedWindow = useRef<string | null>(null);
  const load = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true);
    try {
      const query = modelId ? `?modelId=${encodeURIComponent(modelId)}` : "";
      const limits = await apiRequest<SummarizationLimits>(
        `/api/summarization/limits${query}`,
      );
      if (version !== requestVersion.current) return;
      setSnapshot({ limits, receivedAt: Date.now() });
      setNow(Date.now());
      setError(null);
    } catch (reason) {
      if (version === requestVersion.current) setError(reason);
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [modelId]);

  useEffect(() => {
    void load();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    const refresh = setInterval(() => void load(), 15000);
    const focus = () => void load();
    window.addEventListener("focus", focus);
    return () => {
      invalidateRequests();
      clearInterval(clock);
      clearInterval(refresh);
      window.removeEventListener("focus", focus);
    };
  }, [load, refreshKey, invalidateRequests]);

  const limits = snapshot?.limits;
  const budget = limits?.budget;
  const seconds =
    budget && snapshot
      ? Math.max(
          0,
          Math.ceil(
            (Date.parse(budget.resetsAt) -
              Date.parse(snapshot.limits.serverTime) -
              (now - snapshot.receivedAt)) /
              1000,
          ),
        )
      : 0;

  useEffect(() => {
    if (!budget || seconds > 0 || refreshedWindow.current === budget.resetsAt)
      return;
    refreshedWindow.current = budget.resetsAt;
    // Only the server can confirm a new budget window or release reservations.
    void load();
  }, [budget, seconds, load]);

  const money = (value: number) =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: value > 0 && value < 0.000001 ? 9 : 6,
    }).format(value);
  const countdown = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <section
      className="summary-limits"
      aria-labelledby={titleId}
      data-expanded={expanded}
    >
      <div className="summary-limits-heading">
        <h3 id={titleId} aria-label={t("summary.limits.title")}>
          <button
            type="button"
            className="limits-toggle disclosure-toggle"
            aria-expanded={expanded}
            aria-controls={contentId}
            aria-label={t(
              expanded ? "summary.limits.collapse" : "summary.limits.expand",
            )}
            onClick={() => setExpanded((value) => !value)}
          >
            {t("summary.limits.title")}
            <Icon name="chevronDown" />
          </button>
        </h3>
        {expanded && (
          <button
            type="button"
            className="text-button"
            disabled={loading}
            onClick={() => void load()}
            aria-busy={loading}
          >
            {t("summary.limits.refresh")}
          </button>
        )}
      </div>
      <div id={contentId} hidden={!expanded}>
        {error !== null && (
          <ErrorAlert error={error} onDismiss={() => setError(null)} />
        )}
        {loading && !limits && (
          <p className="muted" role="status">
            {t("summary.limits.loading")}
          </p>
        )}
        {limits && budget && (
          <>
            <p className="limits-usage">
              <strong>{money(budget.spentUsd)}</strong>
              {" / "}
              {t("summary.limits.hourlyAmount", {
                limit: money(budget.limitUsd),
              })}
            </p>
            <progress
              value={Math.min(
                budget.limitUsd,
                budget.spentUsd + budget.reservedUsd,
              )}
              max={budget.limitUsd}
              aria-label={t("summary.limits.app")}
            />
            <div className="limits-remaining">
              <strong>
                {t("summary.limits.remaining", {
                  count: money(budget.remainingUsd),
                })}
              </strong>
              <span>
                {seconds > 0
                  ? t("summary.limits.reset", { time: countdown })
                  : t("summary.limits.refreshingWindow")}
              </span>
            </div>
            {budget.reservedUsd > 0 && (
              <p className="limits-reservation">
                {t("summary.limits.reserved", {
                  amount: money(budget.reservedUsd),
                })}
              </p>
            )}
            <p className="limits-caption">{t("summary.limits.scope")}</p>
            {limits.provider === "mock" && (
              <p className="limits-caption">{t("summary.limits.mock")}</p>
            )}
            <details className="limits-more">
              <summary>{t("summary.limits.details")}</summary>
              {limits.pricing && (
                <>
                  <p className="limits-caption limits-model">
                    {limits.pricing.modelId}
                  </p>
                  <p className="limits-caption">
                    {t("summary.limits.pricing", {
                      input: money(limits.pricing.inputUsdPerMillionTokens),
                      output: money(limits.pricing.outputUsdPerMillionTokens),
                    })}
                  </p>
                </>
              )}
              <dl className="limits-details">
                <div>
                  <dt>{t("summary.limits.inputTokens")}</dt>
                  <dd>{formatNumber(budget.inputTokens)}</dd>
                </div>
                <div>
                  <dt>{t("summary.limits.outputTokens")}</dt>
                  <dd>{formatNumber(budget.outputTokens)}</dd>
                </div>
                <div>
                  <dt>{t("summary.limits.thinkingTokens")}</dt>
                  <dd>{formatNumber(budget.thinkingTokens)}</dd>
                </div>
                <div>
                  <dt>{t("summary.limits.text")}</dt>
                  <dd>
                    {t("summary.limits.characters", {
                      count: formatNumber(limits.text.maxCharacters),
                    })}
                  </dd>
                </div>
                <div>
                  <dt>{t("summary.limits.duration")}</dt>
                  <dd>
                    {t("summary.limits.seconds", {
                      count: formatNumber(limits.generation.deadlineSeconds),
                    })}
                  </dd>
                </div>
                <div>
                  <dt>{t("summary.limits.concurrent")}</dt>
                  <dd>
                    {t("summary.limits.oneGeneration", {
                      count: formatNumber(
                        limits.generation.maxConcurrentPerNote,
                      ),
                    })}
                  </dd>
                </div>
              </dl>
              <p className="limits-caption">{t("summary.limits.estimate")}</p>
              {budget.unreportedCalls > 0 && (
                <p className="limits-caption">
                  {t("summary.limits.unreported", {
                    count: formatNumber(budget.unreportedCalls),
                  })}
                </p>
              )}
            </details>
          </>
        )}
      </div>
    </section>
  );
}
