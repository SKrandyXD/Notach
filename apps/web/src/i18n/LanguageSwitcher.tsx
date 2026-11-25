import { useRef, useState } from "react";
import { useAuth } from "../auth/useAuth.js";
import { saveUserProfile } from "../services/profile.js";
import { isLanguage, LocalizedError } from "./core.js";
import { useI18n } from "./useI18n.js";
import { ErrorAlert } from "../components/ErrorAlert.js";

export function LanguageSwitcher() {
  const { user, registering } = useAuth();
  const { language, setLanguage, t } = useI18n();
  const [saveFailed, setSaveFailed] = useState(false);
  const latestChange = useRef(0);

  async function changeLanguage(next: string) {
    if (!isLanguage(next)) return;
    const changeId = ++latestChange.current;
    setLanguage(next);
    setSaveFailed(false);
    if (user) {
      try {
        await saveUserProfile(user.uid, { preferredLanguage: next });
        if (changeId === latestChange.current) setSaveFailed(false);
      } catch {
        if (changeId === latestChange.current) setSaveFailed(true);
      }
    }
  }

  return (
    <div className="language-control">
      <label className="language-switcher">
        <span>{t("common.language")}</span>
        <select
          aria-label={t("common.language")}
          value={language}
          disabled={registering}
          onChange={(event) => void changeLanguage(event.target.value)}
        >
          <option value="uk">{t("language.uk")}</option>
          <option value="en">{t("language.en")}</option>
        </select>
      </label>
      {saveFailed && (
        <div className="language-save-error">
          <ErrorAlert
            error={new LocalizedError("language.saveFailed")}
            onDismiss={() => setSaveFailed(false)}
          />
        </div>
      )}
    </div>
  );
}
