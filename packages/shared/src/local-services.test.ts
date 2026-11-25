import { describe, expect, it } from "vitest";
import {
  parseServiceAuthority,
  resolveLocalServices,
} from "./local-services.js";

describe("local service configuration", () => {
  it("rejects invalid or conflicting ports before services start", () => {
    expect(() => resolveLocalServices({ NOTACH_API_PORT: "0" })).toThrow();
    expect(() => resolveLocalServices({ NOTACH_API_PORT: "65536" })).toThrow();
    expect(() =>
      resolveLocalServices({ NOTACH_API_PORT: "not-a-port" }),
    ).toThrow();
    expect(() =>
      resolveLocalServices({
        NOTACH_API_PORT: "18001",
        NOTACH_WEB_PORT: "18001",
      }),
    ).toThrow();
  });

  it("validates Firebase endpoint overrides without allowing URLs", () => {
    const services = resolveLocalServices();
    const host = services.emulatorHost;
    expect(parseServiceAuthority(services.authEmulatorAuthority)).toEqual({
      host,
      port: services.authPort,
    });
    expect(() =>
      parseServiceAuthority(`http://${services.authEmulatorAuthority}`),
    ).toThrow();
    expect(() => parseServiceAuthority(`${host}:70000`)).toThrow();
    expect(() =>
      resolveLocalServices({ NOTACH_EMULATOR_HOST: `${host}/path` }),
    ).toThrow();
  });

  it("uses host and port overrides consistently across local endpoints", () => {
    const services = resolveLocalServices({
      NOTACH_BROWSER_HOST: "web.example.test",
      NOTACH_EMULATOR_HOST: "emulators.example.test",
      NOTACH_WEB_PORT: "18001",
      NOTACH_API_PORT: "18002",
      NOTACH_AUTH_PORT: "18003",
      NOTACH_FIRESTORE_PORT: "18004",
      NOTACH_EMULATOR_UI_PORT: "18005",
    });
    expect(services.webOrigin).toBe("http://web.example.test:18001");
    expect(services.apiOrigin).toBe("http://web.example.test:18002");
    expect(services.authEmulatorAuthority).toBe("emulators.example.test:18003");
    expect(services.firestoreEmulatorAuthority).toBe(
      "emulators.example.test:18004",
    );
    expect(services.emulatorUiOrigin).toBe("http://web.example.test:18005");
  });
});
