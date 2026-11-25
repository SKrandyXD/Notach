import { describe, expect, it } from "vitest";
import { resolveApiBaseUrl } from "./api-endpoint.js";
import { resolveLocalServices } from "@notach/shared";

const services = resolveLocalServices();
const apiOrigin = services.apiOrigin;

describe("API endpoint selection", () => {
  it("uses the shared API origin when no override is configured", () => {
    for (const configured of [undefined, "", "  "])
      expect(resolveApiBaseUrl(configured, apiOrigin)).toBe(apiOrigin);
  });

  it("retains explicit hosted API configuration", () => {
    expect(resolveApiBaseUrl("https://api.example.test/", apiOrigin)).toBe(
      "https://api.example.test",
    );
  });

  it("rejects credentials and unsupported protocols", () => {
    for (const value of [
      "file:///secret",
      "https://name:password@example.test",
    ])
      expect(() => resolveApiBaseUrl(value, apiOrigin)).toThrow();
  });
});
