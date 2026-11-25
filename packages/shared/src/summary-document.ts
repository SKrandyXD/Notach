import * as Y from "yjs";
import { SummaryContentSchema, type SummaryContent } from "./index.js";

export const summaryFields = [
  "shortText",
  "pointsText",
  "suggestedTitle",
  "tagsText",
] as const;
export type SummaryField = (typeof summaryFields)[number];
export type SummaryDraftFields = Record<SummaryField, string>;

export function summaryDraftFields(
  content: SummaryContent,
): SummaryDraftFields {
  return {
    shortText: content.shortText,
    pointsText: content.keyPoints.join("\n"),
    suggestedTitle: content.suggestedTitle ?? "",
    tagsText: content.tags.join("\n"),
  };
}

export function seedSummaryDocument(content: SummaryContent): Y.Doc {
  const document = new Y.Doc();
  for (const [field, text] of Object.entries(summaryDraftFields(content))) {
    document.getText(field).insert(0, text);
  }
  return document;
}

export function readSummaryDocument(document: Y.Doc): SummaryDraftFields {
  return Object.fromEntries(
    summaryFields.map((field) => [field, document.getText(field).toString()]),
  ) as SummaryDraftFields;
}

export function validateSummaryDraft(fields: SummaryDraftFields) {
  const lines = (text: string) =>
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  return SummaryContentSchema.safeParse({
    shortText: fields.shortText,
    keyPoints: lines(fields.pointsText),
    tags: lines(fields.tagsText),
    ...(fields.suggestedTitle.trim()
      ? { suggestedTitle: fields.suggestedTitle }
      : {}),
  });
}

// Apply only the changed range so concurrent edits retain their CRDT identities.
export function replaceSummaryField(
  document: Y.Doc,
  field: SummaryField,
  next: string,
) {
  const text = document.getText(field);
  const previous = text.toString();
  let start = 0;
  while (
    start < previous.length &&
    start < next.length &&
    previous[start] === next[start]
  )
    start++;
  let end = 0;
  while (
    end < previous.length - start &&
    end < next.length - start &&
    previous[previous.length - 1 - end] === next[next.length - 1 - end]
  )
    end++;
  if (start > 0 && /[\uD800-\uDBFF]/.test(previous[start - 1]!)) start--;
  if (end > 0 && /[\uDC00-\uDFFF]/.test(previous[previous.length - end]!))
    end--;
  document.transact(() => {
    const removed = previous.length - start - end;
    if (removed) text.delete(start, removed);
    const inserted = next.slice(start, next.length - end);
    if (inserted) text.insert(start, inserted);
  });
}
