import { useEffect } from "react";
import { doc, getDoc } from "firebase/firestore";
import { db } from "../firebase.js";
import { useAuth } from "../auth/useAuth.js";
import { isLanguage } from "./core.js";
import { useI18n } from "./useI18n.js";

export function UserLanguageSync() {
  const { user, loading } = useAuth();
  const { getLanguageRevision, applyLanguageIfUnchanged } = useI18n();
  useEffect(() => {
    if (!user || loading) return;
    let active = true;
    const revisionAtStart = getLanguageRevision();
    void getDoc(doc(db, "users", user.uid))
      .then((snapshot) => {
        const preferred = snapshot.data()?.preferredLanguage;
        if (active && isLanguage(preferred))
          applyLanguageIfUnchanged(preferred, revisionAtStart);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [user, loading, getLanguageRevision, applyLanguageIfUnchanged]);
  return null;
}
