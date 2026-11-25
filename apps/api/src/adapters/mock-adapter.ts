import {
  SummaryContentSchema,
  type SummaryContent,
  type SummaryOptions,
} from "@notach/shared";
import type { SummarizationPort } from "../domain.js";

function extractSentences(text: string): string[] {
  return (text.match(/[^.!?\n]+[.!?]?/gu) ?? [text])
    .map((part) => part.trim())
    .filter(Boolean);
}

export class MockSummarizationAdapter implements SummarizationPort {
  async summarize(
    text: string,
    options: SummaryOptions,
  ): Promise<SummaryContent> {
    if (/\[\[mock-error\]\]/i.test(text))
      throw new Error("MOCK_PROVIDER_FAILURE");
    const sentences = extractSentences(text);
    const keyPoints = sentences.slice(
      0,
      options.length === "detailed" ? 8 : options.length === "medium" ? 5 : 3,
    );
    const shortText =
      keyPoints.join(" ").slice(0, 1000) || text.trim().slice(0, 1000);
    const terms = text.toLocaleLowerCase("uk-UA").match(/[\p{L}]{5,}/gu) ?? [];
    const frequencies = new Map<string, number>();
    for (const term of terms)
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    const tags = options.generateTags
      ? [...frequencies]
          .filter(([, count]) => count > 1)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([term]) => term)
      : [];
    const suggestedTitle = options.generateTitle
      ? (sentences[0] ?? text)
          .replace(/[.!?]+$/u, "")
          .slice(0, 120)
          .trim()
      : undefined;
    return SummaryContentSchema.parse({
      shortText,
      keyPoints,
      tags,
      ...(suggestedTitle ? { suggestedTitle } : {}),
    });
  }
}
