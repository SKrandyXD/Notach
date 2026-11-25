import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "./AuthContext.js";
import { useAuth } from "./useAuth.js";
import { I18nProvider } from "../i18n/I18nProvider.js";

const mocks = vi.hoisted(() => ({
  notify: null as null | ((user: unknown) => void),
  user: { uid: "new-user", displayName: null },
  create: vi.fn(),
  updateProfile: vi.fn(),
  setDoc: vi.fn(),
  deleteUser: vi.fn(),
  signOut: vi.fn(),
  auth: { languageCode: null },
}));
vi.mock("../firebase.js", () => ({ auth: mocks.auth, db: {} }));
vi.mock("firebase/auth", () => ({
  onAuthStateChanged: (_auth: unknown, notify: (user: unknown) => void) => {
    mocks.notify = notify;
    notify(null);
    return () => undefined;
  },
  createUserWithEmailAndPassword: mocks.create,
  updateProfile: mocks.updateProfile,
  deleteUser: mocks.deleteUser,
  signOut: mocks.signOut,
  sendPasswordResetEmail: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
}));
vi.mock("firebase/firestore", () => ({
  doc: vi.fn(() => ({})),
  serverTimestamp: () => "timestamp",
  setDoc: mocks.setDoc,
}));

function Probe() {
  const { user, loading, register } = useAuth();
  const [failed, setFailed] = useState(false);
  return (
    <>
      <output>
        {loading ? "loading" : "ready"}:{user?.uid ?? "none"}
      </output>
      <button
        onClick={() => {
          void register("Name", "new@example.test", "password").catch(() =>
            setFailed(true),
          );
        }}
      >
        register
      </button>
      {failed && <p>failed</p>}
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockImplementation(async () => {
    mocks.notify?.(mocks.user);
    return { user: mocks.user };
  });
  mocks.updateProfile.mockResolvedValue(undefined);
  mocks.deleteUser.mockResolvedValue(undefined);
  mocks.signOut.mockImplementation(async () => {
    mocks.notify?.(null);
  });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("registration profile setup", () => {
  it("keeps authenticated routes gated until the Firestore profile exists", async () => {
    let finishProfile!: () => void;
    mocks.setDoc.mockReturnValue(
      new Promise<void>((resolve) => {
        finishProfile = resolve;
      }),
    );
    render(
      <I18nProvider>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </I18nProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("ready:none");
    await act(async () => {
      fireEvent.click(screen.getByText("register"));
    });
    expect(mocks.setDoc).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("loading:new-user");

    await act(async () => {
      finishProfile();
    });
    expect(screen.getByRole("status")).toHaveTextContent("ready:new-user");
  });

  it("signs out the incomplete account when profile setup and account rollback fail", async () => {
    mocks.setDoc.mockRejectedValue(new Error("profile write failed"));
    mocks.deleteUser.mockRejectedValue(new Error("rollback unavailable"));
    render(
      <I18nProvider>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </I18nProvider>,
    );
    await act(async () => {
      fireEvent.click(screen.getByText("register"));
    });

    expect(await screen.findByText("failed")).toBeInTheDocument();
    expect(mocks.deleteUser).toHaveBeenCalledWith(mocks.user);
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("ready:none");
  });
});
