import { parseServiceAuthority, type LocalServices } from "@notach/shared";
import { resolveApiBaseUrl } from "./api-endpoint.js";

/** Injected by Vite from the same canonical config used by the API and Firebase CLI. */
declare const __NOTACH_LOCAL_SERVICES__: LocalServices;
export const localServices = __NOTACH_LOCAL_SERVICES__;

export const runtimeConfig = {
  apiBaseUrl: resolveApiBaseUrl(
    import.meta.env.VITE_API_BASE_URL,
    localServices.apiOrigin,
  ),
  useFirebaseEmulators: import.meta.env.VITE_USE_FIREBASE_EMULATORS === "true",
  authEmulator: parseServiceAuthority(
    import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_HOST ||
      localServices.authEmulatorAuthority,
  ),
  firestoreEmulator: parseServiceAuthority(
    import.meta.env.VITE_FIRESTORE_EMULATOR_HOST ||
      localServices.firestoreEmulatorAuthority,
  ),
};
