import { describe, expect, it } from "vitest";
import { MockSummarizationAdapter } from "./mock-adapter.js";

describe("mock title suggestions", () => {
  it("suggests a bounded title only when requested", async () => {
    const adapter = new MockSummarizationAdapter();
    const options = {
      language: "en",
      length: "short",
      generateTags: false,
    } as const;
    const result = await adapter.summarize(
      "A project meeting is planned. Olena prepares the agenda.",
      { ...options, generateTitle: true },
    );
    expect(result.suggestedTitle).toBe("A project meeting is planned");
    expect(result.tags).toEqual([]);
    expect(
      await adapter.summarize("A source note.", options),
    ).not.toHaveProperty("suggestedTitle");
  });
});
