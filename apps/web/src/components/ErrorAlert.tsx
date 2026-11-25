import { Children, type ReactNode } from "react";
import { useI18n } from "../i18n/useI18n.js";
import { friendlyError } from "../services/api.js";
import { Icon } from "./Icon.js";

interface ErrorAlertProps {
  error: unknown;
  onDismiss: () => void;
  children?: ReactNode;
  id?: string;
}

export function ErrorAlert({
  error,
  onDismiss,
  children,
  id,
}: ErrorAlertProps) {
  const { t } = useI18n();
  const actions = Children.toArray(children);
  return (
    <div id={id} className="alert error dismissible-alert" role="alert">
      <div className="alert-content">
        <span>{friendlyError(error, t)}</span>
        {actions.length > 0 && <div className="alert-actions">{actions}</div>}
      </div>
      <button
        type="button"
        className="icon-button alert-dismiss"
        aria-label={t("errors.dismiss")}
        onClick={onDismiss}
      >
        <Icon name="close" />
      </button>
    </div>
  );
}
