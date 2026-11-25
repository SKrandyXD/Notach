import { describe, expect, it } from "vitest";
import {
  normalizeTags,
  normalizeTitle,
  splitIntoChunks,
  SummaryContentSchema,
  SummaryOptionsSchema,
  SaveSummaryRequestSchema,
} from "./index.js";

describe("shared note helpers", () => {
  it("normalizes Ukrainian titles and tags", () => {
    expect(normalizeTitle("  КОНСПЕКТ Із Мови  ")).toBe("конспект із мови");
    expect(normalizeTags([" #Навчання ", "навчання", " Робота "])).toEqual([
      "навчання",
      "робота",
    ]);
  });

  it("splits long text without losing words", () => {
    const source = `${"слово ".repeat(12)}\n\n${"термін ".repeat(12)}`;
    const chunks = splitIntoChunks(source, 10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks.every(
        (chunk) => (chunk.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) <= 10,
      ),
    ).toBe(true);
    expect(chunks.join(" ").match(/[\p{L}\p{N}]+/gu)).toHaveLength(24);
  });

  it("rejects malformed model output", () => {
    expect(
      SummaryContentSchema.safeParse({ shortText: "", keyPoints: [], tags: [] })
        .success,
    ).toBe(false);
  });

  it("keeps old summary payloads compatible while validating optional titles and historical bases", () => {
    const summary = { shortText: "Summary", keyPoints: ["Fact"], tags: [] };
    expect(SummaryContentSchema.parse(summary)).toEqual(summary);
    expect(SummaryOptionsSchema.parse({}).generateTitle).toBeUndefined();
    expect(
      SummaryContentSchema.parse({
        ...summary,
        suggestedTitle: "  Suggested title  ",
      }).suggestedTitle,
    ).toBe("Suggested title");
    expect(
      SummaryContentSchema.safeParse({
        ...summary,
        suggestedTitle: "x".repeat(121),
      }).success,
    ).toBe(false);
    expect(
      SaveSummaryRequestSchema.parse({
        sourceRevision: 1,
        requestId: "bd766b8f-b30d-47a2-9b94-f1bbdef87999",
        summary,
        baseSummaryId: "saved-base",
      }).baseSummaryId,
    ).toBe("saved-base");
  });
});
