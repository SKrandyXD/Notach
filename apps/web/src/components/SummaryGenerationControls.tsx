import { useId, useState, type ReactNode } from "react";
import { useI18n } from "../i18n/useI18n.js";
import { Icon } from "./Icon.js";

export function SummaryGenerationControls({
  children,
}: {
  children: ReactNode;
}) {
  const { t } = useI18n();
  const contentId = useId();
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="summary-generation-controls" data-expanded={expanded}>
      <div className="assistant-header">
        <div className="assistant-title">
          <span className="sparkle" aria-hidden="true">
            ✦
          </span>
          <div>
            <div className="eyebrow">NOTACH AI</div>
            <h2 id="assistant-heading">{t("summary.assistant")}</h2>
          </div>
        </div>
        <button
          type="button"
          className="icon-button disclosure-toggle"
          aria-expanded={expanded}
          aria-controls={contentId}
          aria-label={t(
            expanded ? "summary.collapseSettings" : "summary.expandSettings",
          )}
          title={t(
            expanded ? "summary.collapseSettings" : "summary.expandSettings",
          )}
          onClick={() => setExpanded((value) => !value)}
        >
          <Icon name="chevronDown" />
        </button>
      </div>
      <div id={contentId} hidden={!expanded}>
        {children}
      </div>
    </div>
  );
}
