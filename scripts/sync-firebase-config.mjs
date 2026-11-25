import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolveLocalServices } from "@notach/shared";

const services = resolveLocalServices(process.env);
if (process.argv.includes("--show")) {
  console.info(
    JSON.stringify(
      {
        web: services.webOrigin,
        api: services.apiOrigin,
        authEmulator: services.authEmulatorAuthority,
        firestoreEmulator: services.firestoreEmulatorAuthority,
        emulatorUi: services.emulatorUiOrigin,
      },
      null,
      2,
    ),
  );
} else {
  const configPath = fileURLToPath(
    new URL("../firebase.json", import.meta.url),
  );
  const raw = await readFile(configPath, "utf8");
  const config = JSON.parse(raw);
  config.emulators = {
    ...config.emulators,
    auth: {
      ...config.emulators?.auth,
      host: services.emulatorHost,
      port: services.authPort,
    },
    firestore: {
      ...config.emulators?.firestore,
      host: services.emulatorHost,
      port: services.firestorePort,
    },
    ui: {
      ...config.emulators?.ui,
      enabled: true,
      host: services.emulatorHost,
      port: services.emulatorUiPort,
    },
    hub: {
      ...config.emulators?.hub,
      host: services.emulatorHost,
      port: services.emulatorHubPort,
    },
    logging: {
      ...config.emulators?.logging,
      host: services.emulatorHost,
      port: services.emulatorLoggingPort,
    },
    singleProjectMode: true,
  };
  const updated = `${JSON.stringify(config, null, 2)}\n`;
  if (raw !== updated) await writeFile(configPath, updated, "utf8");
  console.info(
    "Firebase local endpoints synchronized from packages/shared/src/local-services.json.",
  );
}
