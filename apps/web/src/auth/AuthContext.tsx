import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  createUserWithEmailAndPassword,
  deleteUser,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  type User,
} from "firebase/auth";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { auth, db } from "../firebase.js";
import { AuthContext, type AuthContextValue } from "./context.js";
import { useI18n } from "../i18n/useI18n.js";

export function AuthProvider({ children }: { children: ReactNode }) {
  const { language } = useI18n();
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [registering, setRegistering] = useState(false);
  const loading = authLoading || registering;

  useEffect(() => {
    auth.languageCode = language;
  }, [language]);

  useEffect(
    () =>
      onAuthStateChanged(auth, (current) => {
        setUser(current);
        setAuthLoading(false);
      }),
    [],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      registering,
      async register(displayName, email, password) {
        setRegistering(true);
        let createdUser: User | undefined;
        try {
          const credential = await createUserWithEmailAndPassword(
            auth,
            email.trim(),
            password,
          );
          createdUser = credential.user;
          await updateProfile(credential.user, {
            displayName: displayName.trim(),
          });
          await setDoc(doc(db, "users", credential.user.uid), {
            displayName: displayName.trim(),
            preferredLanguage: language,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (error) {
          if (createdUser) {
            try {
              await deleteUser(createdUser);
            } catch {
              /* Sign out below if account rollback is unavailable. */
            }
            try {
              await signOut(auth);
            } catch {
              /* Clear the rendered session even if local sign-out fails. */
            }
            setUser(null);
          }
          throw error;
        } finally {
          setRegistering(false);
        }
      },
      async login(email, password) {
        await signInWithEmailAndPassword(auth, email.trim(), password);
      },
      async logout() {
        await signOut(auth);
      },
      async resetPassword(email) {
        await sendPasswordResetEmail(auth, email.trim());
      },
    }),
    [user, loading, registering, language],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
