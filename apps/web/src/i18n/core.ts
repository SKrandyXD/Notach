import { catalogs, type Message, type TranslationKey } from "./catalogs.js";

export type Language = keyof typeof catalogs;
export type TranslationParams = Record<string, string | number>;
export type Translate = (
  key: TranslationKey,
  params?: TranslationParams,
) => string;
export const LANGUAGE_STORAGE_KEY = "notach.language";
export const localeFor = (language: Language): string =>
  language === "uk" ? "uk-UA" : "en-GB";
export const isLanguage = (value: unknown): value is Language =>
  value === "uk" || value === "en";

export function storedLanguage(): Language {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isLanguage(stored) ? stored : "uk";
  } catch {
    return "uk";
  }
}

export function translate(
  language: Language,
  key: TranslationKey,
  params: TranslationParams = {},
): string {
  const message: Message = catalogs[language][key] ?? catalogs.uk[key];
  const template =
    typeof message === "string"
      ? message
      : (message[
          new Intl.PluralRules(localeFor(language)).select(
            Number(params.count ?? 0),
          )
        ] ?? message.other);
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined
      ? match
      : typeof value === "number"
        ? new Intl.NumberFormat(localeFor(language)).format(value)
        : value;
  });
}

export class LocalizedError extends Error {
  constructor(public readonly translationKey: TranslationKey) {
    super(translationKey);
  }
}
