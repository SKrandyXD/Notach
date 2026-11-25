import { getApp, getApps, initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth } from "firebase/auth";
import { connectFirestoreEmulator, getFirestore } from "firebase/firestore";
import { runtimeConfig } from "./config/runtime.js";

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
};

const missing = Object.entries(config)
  .filter(([, value]) => !value)
  .map(([key]) => key);
if (missing.length)
  throw new Error(
    `Firebase web configuration is missing: ${missing.join(", ")}`,
  );

export const firebaseApp = getApps().length ? getApp() : initializeApp(config);
export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);

if (runtimeConfig.useFirebaseEmulators) {
  const { authEmulator, firestoreEmulator } = runtimeConfig;
  connectAuthEmulator(
    auth,
    `http://${authEmulator.host}:${authEmulator.port}`,
    {
      disableWarnings: true,
    },
  );
  connectFirestoreEmulator(db, firestoreEmulator.host, firestoreEmulator.port);
}
