import { z } from "zod";
import defaults from "./local-services.json" with { type: "json" };

const hostSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (host) => /^[a-zA-Z0-9.-]+$/.test(host),
    "Expected a hostname or IPv4 address without a protocol or port.",
  );
const portSchema = z.coerce.number().int().min(1).max(65535);
const localServicesSchema = z
  .object({
    browserHost: hostSchema,
    emulatorHost: hostSchema,
    webPort: portSchema,
    apiPort: portSchema,
    authPort: portSchema,
    firestorePort: portSchema,
    emulatorUiPort: portSchema,
    emulatorHubPort: portSchema,
    emulatorLoggingPort: portSchema,
  })
  .superRefine((config, context) => {
    const ports = Object.entries(config).filter(([key]) =>
      key.endsWith("Port"),
    );
    const used = new Map<unknown, string>();
    for (const [key, port] of ports) {
      const previous = used.get(port);
      if (previous)
        context.addIssue({
          code: "custom",
          path: [key],
          message: `Port is already assigned to ${previous}.`,
        });
      used.set(port, key);
    }
  });

export type LocalServiceEnvironment = Record<string, string | undefined>;
export type LocalServicePorts = z.infer<typeof localServicesSchema>;

/** Canonical defaults live in local-services.json; NOTACH_* variables override them for every local service. */
export function resolveLocalServices(
  environment: LocalServiceEnvironment = {},
) {
  const config = localServicesSchema.parse({
    browserHost: environment.NOTACH_BROWSER_HOST || defaults.browserHost,
    emulatorHost: environment.NOTACH_EMULATOR_HOST || defaults.emulatorHost,
    webPort: environment.NOTACH_WEB_PORT ?? defaults.webPort,
    apiPort: environment.NOTACH_API_PORT ?? defaults.apiPort,
    authPort: environment.NOTACH_AUTH_PORT ?? defaults.authPort,
    firestorePort: environment.NOTACH_FIRESTORE_PORT ?? defaults.firestorePort,
    emulatorUiPort:
      environment.NOTACH_EMULATOR_UI_PORT ?? defaults.emulatorUiPort,
    emulatorHubPort:
      environment.NOTACH_EMULATOR_HUB_PORT ?? defaults.emulatorHubPort,
    emulatorLoggingPort:
      environment.NOTACH_EMULATOR_LOGGING_PORT ?? defaults.emulatorLoggingPort,
  });
  return {
    ...config,
    webOrigin: `http://${config.browserHost}:${config.webPort}`,
    apiOrigin: `http://${config.browserHost}:${config.apiPort}`,
    authEmulatorAuthority: `${config.emulatorHost}:${config.authPort}`,
    firestoreEmulatorAuthority: `${config.emulatorHost}:${config.firestorePort}`,
    emulatorUiOrigin: `http://${config.browserHost}:${config.emulatorUiPort}`,
  };
}

export type LocalServices = ReturnType<typeof resolveLocalServices>;

/** Firebase Admin host variables intentionally omit the protocol. */
export function parseServiceAuthority(authority: string): {
  host: string;
  port: number;
} {
  const match = /^([a-zA-Z0-9.-]+):(\d+)$/.exec(authority);
  if (!match)
    throw new Error("Expected a service hostname and port without a protocol.");
  return { host: hostSchema.parse(match[1]), port: portSchema.parse(match[2]) };
}

export function isServiceAuthority(value: string): boolean {
  try {
    parseServiceAuthority(value);
    return true;
  } catch {
    return false;
  }
}
