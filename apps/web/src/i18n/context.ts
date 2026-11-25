import { createContext } from "react";
import type { Language, Translate } from "./core.js";

export interface I18nValue {
  language: Language;
  locale: string;
  setLanguage: (language: Language) => void;
  getLanguageRevision: () => number;
  applyLanguageIfUnchanged: (
    language: Language,
    expectedRevision: number,
  ) => boolean;
  t: Translate;
  formatNumber: (value: number) => string;
  formatDate: (
    value: Date | string,
    options?: Intl.DateTimeFormatOptions,
  ) => string;
}

export const I18nContext = createContext<I18nValue | null>(null);
