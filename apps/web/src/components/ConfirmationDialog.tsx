import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/useI18n.js";
import { AsyncButtonLabel } from "./AsyncButtonLabel.js";
import { ErrorAlert } from "./ErrorAlert.js";
import { Icon } from "./Icon.js";

export interface ConfirmationOptions {
  title: string;
  description: string;
  confirmLabel: string;
  pendingLabel: string;
  context?: string;
  notice?: string;
  tone?: "danger" | "primary";
  icon?: "trash" | "logout" | "warning";
  onConfirm: () => void | Promise<void>;
}

export function ConfirmationDialog({
  title,
  description,
  confirmLabel,
  pendingLabel,
  context,
  notice,
  tone = "primary",
  icon = "warning",
  onConfirm,
  onClose,
}: ConfirmationOptions & { onClose: () => void }) {
  const { t } = useI18n();
  const id = useId();
  const overlay = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const running = useRef(false);
  const mounted = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    const background = Array.from(document.body.children)
      .filter(
        (node): node is HTMLElement =>
          node instanceof HTMLElement && node !== overlay.current,
      )
      .map((node) => ({
        node,
        inert: node.inert,
        hidden: node.getAttribute("aria-hidden"),
      }));
    for (const { node } of background) {
      node.inert = true;
      node.setAttribute("aria-hidden", "true");
    }
    document.body.style.overflow = "hidden";
    cancel.current?.focus();
    const keepFocusInside = (event: FocusEvent) => {
      if (
        event.target instanceof Node &&
        !dialog.current?.contains(event.target)
      ) {
        if (running.current) dialog.current?.focus();
        else cancel.current?.focus();
      }
    };
    document.addEventListener("focusin", keepFocusInside);
    return () => {
      mounted.current = false;
      document.removeEventListener("focusin", keepFocusInside);
      for (const { node, inert, hidden } of background) {
        node.inert = inert;
        if (hidden === null) node.removeAttribute("aria-hidden");
        else node.setAttribute("aria-hidden", hidden);
      }
      document.body.style.overflow = overflow;
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);

  function dismiss() {
    if (!running.current) onClose();
  }

  async function confirm() {
    if (running.current) return;
    running.current = true;
    setPending(true);
    setError(null);
    dialog.current?.focus();
    try {
      await onConfirm();
      if (mounted.current) onClose();
    } catch (reason) {
      if (mounted.current) setError(reason);
    } finally {
      running.current = false;
      if (mounted.current) setPending(false);
    }
  }

  return createPortal(
    <div
      ref={overlay}
      className="modal-scrim confirmation-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <section
        ref={dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description${notice ? ` ${id}-notice` : ""}`}
        aria-busy={pending}
        className={`modal confirmation-dialog confirmation-${tone}`}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            dismiss();
          }
          if (event.key !== "Tab") return;
          const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          );
          const first = buttons?.[0];
          const last = buttons?.[buttons.length - 1];
          if (!first) {
            event.preventDefault();
            return;
          }
          if (
            event.shiftKey &&
            (document.activeElement === first ||
              document.activeElement === dialog.current)
          ) {
            event.preventDefault();
            last?.focus();
          } else if (
            !event.shiftKey &&
            (document.activeElement === last ||
              document.activeElement === dialog.current)
          ) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="confirmation-symbol">
          <Icon name={icon} />
        </div>
        <div className="eyebrow">{t("confirmation.eyebrow")}</div>
        <h2 id={`${id}-title`}>{title}</h2>
        <p id={`${id}-description`} className="confirmation-description">
          {description}
        </p>
        {context && (
          <div className="confirmation-context">
            <span>{context}</span>
          </div>
        )}
        {notice && (
          <p id={`${id}-notice`} className="confirmation-notice">
            {notice}
          </p>
        )}
        {error !== null && (
          <ErrorAlert error={error} onDismiss={() => setError(null)} />
        )}
        <div className="confirmation-actions">
          <button
            ref={cancel}
            type="button"
            className="button secondary"
            disabled={pending}
            onClick={dismiss}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className={`button ${tone === "danger" ? "danger" : "primary"}`}
            disabled={pending}
            onClick={() => void confirm()}
          >
            <AsyncButtonLabel
              idle={confirmLabel}
              busy={pendingLabel}
              loading={pending}
            />
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
