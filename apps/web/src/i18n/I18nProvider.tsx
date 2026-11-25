import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { I18nContext, type I18nValue } from "./context.js";
import {
  LANGUAGE_STORAGE_KEY,
  localeFor,
  storedLanguage,
  translate,
  type Language,
} from "./core.js";

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, updateLanguage] = useState<Language>(storedLanguage);
  const languageRevision = useRef(0);
  const setLanguage = useCallback((next: Language) => {
    languageRevision.current += 1;
    updateLanguage(next);
  }, []);
  const getLanguageRevision = useCallback(() => languageRevision.current, []);
  const applyLanguageIfUnchanged = useCallback(
    (next: Language, expectedRevision: number) => {
      if (languageRevision.current !== expectedRevision) return false;
      languageRevision.current += 1;
      updateLanguage(next);
      return true;
    },
    [],
  );
  const locale = localeFor(language);

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = translate(language, "meta.title");
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute("content", translate(language, "meta.description"));
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    } catch {
      /* Language selection still works without storage. */
    }
  }, [language]);

  const value = useMemo<I18nValue>(
    () => ({
      language,
      locale,
      setLanguage,
      getLanguageRevision,
      applyLanguageIfUnchanged,
      t: (key, params) => translate(language, key, params),
      formatNumber: (number) => new Intl.NumberFormat(locale).format(number),
      formatDate: (date, options) =>
        new Intl.DateTimeFormat(locale, options).format(new Date(date)),
    }),
    [
      language,
      locale,
      setLanguage,
      getLanguageRevision,
      applyLanguageIfUnchanged,
    ],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
