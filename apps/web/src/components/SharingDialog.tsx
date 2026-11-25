import { useEffect, useRef, useState, type FormEvent } from "react";
import { ShareRequestSchema } from "@notach/shared";
import { apiRequest } from "../services/api.js";
import { LocalizedError } from "../i18n/core.js";
import { useI18n } from "../i18n/useI18n.js";
import { ErrorAlert } from "./ErrorAlert.js";
import { AsyncButtonLabel } from "./AsyncButtonLabel.js";
import { Icon } from "./Icon.js";

interface Share {
  participantUid: string;
  email: string;
  role: "viewer" | "editor";
}

export function SharingDialog({
  noteId,
  onClose,
}: {
  noteId: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
  const [shares, setShares] = useState<Share[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  function focusFallback() {
    if (emailInput.current && !emailInput.current.disabled)
      emailInput.current.focus();
    else dialog.current?.focus();
  }

  useEffect(() => {
    let active = true;
    mounted.current = true;
    setLoading(true);
    void apiRequest<{ shares: Share[] }>(`/api/notes/${noteId}/shares`)
      .then((data) => {
        if (active) setShares(data.shares);
      })
      .catch((reason) => {
        if (active) setError(reason);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    const previous = document.activeElement;
    const keepFocusInside = (event: FocusEvent) => {
      if (
        event.target instanceof Node &&
        !dialog.current?.contains(event.target)
      )
        focusFallback();
    };
    document.addEventListener("focusin", keepFocusInside);
    emailInput.current?.focus();
    return () => {
      active = false;
      mounted.current = false;
      document.removeEventListener("focusin", keepFocusInside);
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, [noteId]);

  useEffect(() => {
    const focused = document.activeElement;
    if (
      !dialog.current?.contains(focused) ||
      (focused instanceof HTMLElement && focused.matches(":disabled"))
    )
      focusFallback();
  }, [saving, loading, error]);

  async function grant(event: FormEvent) {
    event.preventDefault();
    if (saving || loading) return;
    const parsed = ShareRequestSchema.safeParse({ email, role });
    if (!parsed.success) {
      setError(new LocalizedError("errors.invalidEmail"));
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await apiRequest(`/api/notes/${noteId}/shares`, {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      if (!mounted.current) return;
      setEmail("");
      const data = await apiRequest<{ shares: Share[] }>(
        `/api/notes/${noteId}/shares`,
      );
      if (mounted.current) setShares(data.shares);
    } catch (reason) {
      if (mounted.current) setError(reason);
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  async function revoke(uid: string) {
    if (saving || loading) return;
    setError(null);
    setSaving(true);
    try {
      await apiRequest(`/api/notes/${noteId}/shares/${uid}`, {
        method: "DELETE",
      });
      if (mounted.current)
        setShares((items) =>
          items.filter((share) => share.participantUid !== uid),
        );
    } catch (reason) {
      if (mounted.current) setError(reason);
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  return (
    <div
      className="modal-scrim"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialog}
        className="modal sharing-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
          if (event.key !== "Tab") return;
          const items = dialog.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]",
          );
          const first = items?.[0];
          const last = items?.[items.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <button
          type="button"
          className="modal-close"
          aria-label={t("common.close")}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
        <div className="eyebrow">{t("sharing.eyebrow")}</div>
        <h2 id="share-title">{t("sharing.grant")}</h2>
        <p className="muted">{t("sharing.description")}</p>
        {error !== null && (
          <ErrorAlert
            id="share-error"
            error={error}
            onDismiss={() => {
              setError(null);
              focusFallback();
            }}
          />
        )}
        <form
          className="stack-form"
          onSubmit={(event) => void grant(event)}
          noValidate
        >
          <label>
            {t("sharing.email")}
            <input
              ref={emailInput}
              type="email"
              value={email}
              required
              disabled={saving}
              autoComplete="email"
              maxLength={320}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            {t("sharing.role")}
            <select
              value={role}
              disabled={saving}
              onChange={(event) => setRole(event.target.value as typeof role)}
            >
              <option value="viewer">{t("sharing.viewer")}</option>
              <option value="editor">{t("sharing.editing")}</option>
            </select>
          </label>
          <button
            type="submit"
            className="button primary"
            disabled={saving || loading}
            aria-busy={saving}
          >
            <AsyncButtonLabel
              idle={t("sharing.grant")}
              busy={t("sharing.saving")}
              loading={saving}
            />
          </button>
        </form>
        {loading && (
          <p className="muted" role="status">
            {t("sharing.loading")}
          </p>
        )}
        <div className="share-list">
          {shares.map((share) => (
            <div key={share.participantUid}>
              <span>
                {share.email}
                <small>
                  {share.role === "editor"
                    ? t("sharing.editor")
                    : t("sharing.viewer")}
                </small>
              </span>
              <button
                type="button"
                className="text-button"
                disabled={saving || loading}
                onClick={() => void revoke(share.participantUid)}
              >
                {t("sharing.revoke")}
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
