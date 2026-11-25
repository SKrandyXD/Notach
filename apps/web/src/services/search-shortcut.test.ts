import { describe, expect, it } from "vitest";
import { focusSearchFromShortcut } from "./search-shortcut.js";

describe("global note search shortcut", () => {
  it("focuses and selects the search input with Ctrl+K", () => {
    const input = document.createElement("input");
    document.body.append(input);
    const event = new KeyboardEvent("keydown", {
      key: "k",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    expect(focusSearchFromShortcut(event, input)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);
    input.remove();
  });

  it("supports Command+K and ignores unrelated shortcuts", () => {
    const input = document.createElement("input");
    const commandK = new KeyboardEvent("keydown", {
      key: "K",
      metaKey: true,
      cancelable: true,
    });
    const plainK = new KeyboardEvent("keydown", { key: "k", cancelable: true });

    expect(focusSearchFromShortcut(commandK, input)).toBe(true);
    expect(focusSearchFromShortcut(plainK, input)).toBe(false);
    expect(plainK.defaultPrevented).toBe(false);
  });
});
