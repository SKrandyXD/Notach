import { doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "../firebase.js";
import type { Language } from "../i18n/core.js";

interface UserProfileChanges {
  displayName?: string;
  preferredLanguage?: Language;
}

const pendingWrites = new Map<string, Promise<void>>();

/** Preserve selection order even when an earlier Firestore write is slow or fails. */
export function saveUserProfile(
  uid: string,
  changes: UserProfileChanges,
): Promise<void> {
  const values = { ...changes };
  const previous = pendingWrites.get(uid) ?? Promise.resolve();
  const write = previous
    .catch(() => undefined)
    .then(() =>
      updateDoc(doc(db, "users", uid), {
        ...values,
        updatedAt: serverTimestamp(),
      }),
    );
  pendingWrites.set(uid, write);
  const clear = () => {
    if (pendingWrites.get(uid) === write) pendingWrites.delete(uid);
  };
  void write.then(clear, clear);
  return write;
}
