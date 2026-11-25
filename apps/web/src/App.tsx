import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  BrowserRouter,
  Link,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { doc, getDoc } from "firebase/firestore";
import {
  SummaryContentSchema,
  SummaryOptionsSchema,
  normalizeTags,
  normalizeTitle,
  type Note,
  type Summary,
  type SummaryContent,
  type SummaryModelCatalog,
} from "@notach/shared";
import { AuthProvider } from "./auth/AuthContext.js";
import { useAuth } from "./auth/useAuth.js";
import { db } from "./firebase.js";
import { apiRequest } from "./services/api.js";
import { focusSearchFromShortcut } from "./services/search-shortcut.js";
import {
  createNote,
  getNote,
  watchOwnNotes,
  watchSharedNotes,
  NoteRevisionConflict,
  updateNoteFields,
  setNoteStatus,
} from "./services/notes.js";
import { I18nProvider } from "./i18n/I18nProvider.js";
import { useI18n } from "./i18n/useI18n.js";
import { LanguageSwitcher } from "./i18n/LanguageSwitcher.js";
import { UserLanguageSync } from "./i18n/UserLanguageSync.js";
import { saveUserProfile } from "./services/profile.js";
import { isLanguage, LocalizedError } from "./i18n/core.js";
import type { TranslationKey } from "./i18n/catalogs.js";
import "./styles.css";
import { AsyncButtonLabel } from "./components/AsyncButtonLabel.js";
import { Icon } from "./components/Icon.js";
import { ErrorAlert } from "./components/ErrorAlert.js";
import { SharingDialog } from "./components/SharingDialog.js";
import { FeedbackForm } from "./components/FeedbackForm.js";
import { SummaryLimitsPanel } from "./components/SummaryLimitsPanel.js";
import { SummaryGenerationControls } from "./components/SummaryGenerationControls.js";
import { useConfirmation } from "./components/useConfirmation.js";
import {
  CollaborativeNoteSession,
  type CollaborationStatus,
  type TextSelection,
} from "./services/collaboration.js";
import {
  CollaborativeSummarySession,
  watchSummaryHistory,
  watchGenerationActivity,
  type GenerationActivity,
  type SummarySelection,
} from "./services/summary-sync.js";
import type { SummaryField } from "@notach/shared";

function RequireAuth() {
  const { t } = useI18n();
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading)
    return (
      <div className="page-center" role="status">
        {t("common.loading")}
      </div>
    );
  return user ? (
    <Outlet />
  ) : (
    <Navigate to="/login" replace state={{ from: location.pathname }} />
  );
}

function GuestOnly({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { user, loading, registering } = useAuth();
  if (registering) return children;
  if (loading)
    return (
      <div className="page-center" role="status">
        {t("common.loading")}
      </div>
    );
  return user ? <Navigate to="/notes" replace /> : children;
}

function HomeRedirect() {
  const { t } = useI18n();
  const { user, loading } = useAuth();
  return loading ? (
    <div className="page-center" role="status">
      {t("common.loading")}
    </div>
  ) : (
    <Navigate to={user ? "/notes" : "/login"} replace />
  );
}

function AuthPage({ mode }: { mode: "login" | "register" | "forgot" }) {
  const { t } = useI18n();
  const { login, register, resetPassword } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [success, setSuccess] = useState<"auth.resetSent" | null>(null);
  const [busy, setBusy] = useState(false);
  const returnTo =
    (location.state as { from?: string } | null)?.from ?? "/notes";

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    setBusy(true);
    try {
      if (mode === "login") {
        await login(email, password);
        navigate(returnTo, { replace: true });
      }
      if (mode === "register") {
        if (password.length < 8) throw new LocalizedError("auth.passwordShort");
        if (password !== confirm)
          throw new LocalizedError("auth.passwordMismatch");
        await register(name, email, password);
        navigate("/notes", { replace: true });
      }
      if (mode === "forgot") {
        await resetPassword(email);
        setSuccess("auth.resetSent");
      }
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  }

  const title =
    mode === "login"
      ? t("auth.loginTitle")
      : mode === "register"
        ? t("auth.registerTitle")
        : t("auth.resetTitle");
  return (
    <main className="auth-page">
      <section className="auth-card">
        <LanguageSwitcher />
        <Link
          className="brand brand-light"
          to="/login"
          aria-label={t("common.homeLabel")}
        >
          <span className="brand-mark">N</span>
          <span>Notach</span>
        </Link>
        <div className="eyebrow">{t("auth.eyebrow")}</div>
        <h1>{title}</h1>
        <p className="muted">
          {mode === "login"
            ? t("auth.loginDescription")
            : mode === "register"
              ? t("auth.registerDescription")
              : t("auth.resetDescription")}
        </p>
        <form onSubmit={submit} className="stack-form">
          {mode === "register" && (
            <label>
              {t("common.name")}
              <input
                autoComplete="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={80}
              />
            </label>
          )}
          <label>
            {t("common.email")}
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          {mode !== "forgot" && (
            <label>
              {t("auth.password")}
              <input
                type="password"
                autoComplete={
                  mode === "login" ? "current-password" : "new-password"
                }
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                minLength={8}
                required
              />
            </label>
          )}
          {mode === "register" && (
            <label>
              {t("auth.confirmPassword")}
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                minLength={8}
                required
              />
            </label>
          )}
          {error !== null && (
            <ErrorAlert error={error} onDismiss={() => setError(null)} />
          )}
          {success && (
            <p className="alert success" role="status">
              {t(success)}
            </p>
          )}
          <button className="button primary full" disabled={busy}>
            {busy
              ? t("common.wait")
              : mode === "login"
                ? t("auth.signIn")
                : mode === "register"
                  ? t("auth.signUp")
                  : t("auth.sendReset")}
          </button>
        </form>
        <div className="auth-links">
          {mode === "login" && (
            <>
              <Link to="/forgot-password">{t("auth.forgotPassword")}</Link>
              <span>
                {t("auth.noAccount")}{" "}
                <Link to="/register">{t("common.create")}</Link>
              </span>
            </>
          )}
          {mode === "register" && (
            <span>
              {t("auth.hasAccount")} <Link to="/login">{t("auth.signIn")}</Link>
            </span>
          )}
          {mode === "forgot" && (
            <Link to="/login">{t("auth.backToLogin")}</Link>
          )}
        </div>
        <p className="privacy-note">{t("auth.aiPrivacy")}</p>
      </section>
      <div className="auth-art" aria-hidden="true">
        <div className="art-orb orb-one" />
        <div className="art-orb orb-two" />
        <div className="art-note">
          <span>{t("auth.artIdeas")}</span>
          <strong>
            {t("auth.artKeep")}
            <br />
            {t("auth.artFind")}
          </strong>
          <i>✦</i>
        </div>
        <div className="art-lines">
          <span />
          <span />
          <span />
        </div>
      </div>
    </main>
  );
}

function AppShell({
  children,
  beforeSignOut,
}: {
  children: ReactNode;
  beforeSignOut?: () => Promise<void>;
}) {
  const { t } = useI18n();
  const { user, logout } = useAuth();
  const { confirm, confirmation } = useConfirmation();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname, location.search]);
  const [mobileSidebar, setMobileSidebar] = useState(
    () => window.matchMedia?.("(max-width: 900px)").matches ?? false,
  );
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 900px)");
    if (!media) return;
    const update = () => setMobileSidebar(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem("notach.sidebarCollapsed") === "true";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("notach.sidebarCollapsed", String(sidebarCollapsed));
    } catch {
      /* Works without storage. */
    }
  }, [sidebarCollapsed]);
  return (
    <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside
        id="notach-sidebar"
        inert={mobileSidebar ? !menuOpen : sidebarCollapsed}
        className={`sidebar ${menuOpen ? "sidebar-open" : ""}`}
      >
        <Link className="brand" to="/notes">
          <span className="brand-mark">N</span>
          <span>Notach</span>
        </Link>
        <div className="sidebar-caption">{t("nav.workspace")}</div>
        <Link className="button new-note" to="/notes/new">
          <Icon name="plus" /> {t("notes.new")}
        </Link>
        <nav className="side-nav" aria-label={t("nav.main")}>
          <Link
            to="/notes"
            aria-current={
              location.pathname === "/notes" && !location.search
                ? "page"
                : undefined
            }
          >
            <Icon name="notes" /> <span>{t("notes.all")}</span>
          </Link>
          <Link
            to="/notes?favorites=true"
            aria-current={
              location.pathname === "/notes" &&
              location.search.includes("favorites=true")
                ? "page"
                : undefined
            }
          >
            <Icon name="star" /> <span>{t("nav.favorites")}</span>
          </Link>
          <Link
            to="/shared"
            aria-current={location.pathname === "/shared" ? "page" : undefined}
          >
            <Icon name="shared" /> <span>{t("nav.shared")}</span>
          </Link>
          <Link
            to="/archive"
            aria-current={location.pathname === "/archive" ? "page" : undefined}
          >
            <Icon name="archive" /> <span>{t("nav.archive")}</span>
          </Link>
        </nav>
        <div className="sidebar-bottom">
          <div className="user-mini">
            <span className="avatar">
              {(user?.displayName || user?.email || "N")
                .slice(0, 1)
                .toUpperCase()}
            </span>
            <span className="user-name">
              {user?.displayName || user?.email}
            </span>
          </div>
          <Link
            to="/profile"
            className="side-profile"
            aria-current={location.pathname === "/profile" ? "page" : undefined}
          >
            <Icon name="settings" /> <span>{t("nav.profile")}</span>
          </Link>
          <button
            className="side-signout"
            onClick={() =>
              confirm({
                title: t("confirmation.signOutTitle"),
                description: t("confirmation.signOutDescription"),
                notice: beforeSignOut
                  ? t("confirmation.saveBeforeSignOut")
                  : undefined,
                context: user?.email ?? undefined,
                icon: "logout",
                confirmLabel: t("auth.signOut"),
                pendingLabel: t("confirmation.signingOut"),
                onConfirm: async () => {
                  await beforeSignOut?.();
                  await logout();
                },
              })
            }
          >
            <Icon name="logout" /> <span>{t("auth.signOut")}</span>
          </button>
        </div>
      </aside>
      {menuOpen && (
        <button
          className="sidebar-scrim"
          aria-label={t("nav.closeMenu")}
          onClick={() => setMenuOpen(false)}
        />
      )}
      <div className="main-column">
        <header className="topbar">
          <button
            className="icon-button sidebar-toggle"
            aria-controls="notach-sidebar"
            aria-expanded={!sidebarCollapsed}
            aria-label={
              sidebarCollapsed ? t("nav.showSidebar") : t("nav.hideSidebar")
            }
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
          >
            <Icon name="menu" />
          </button>
          <button
            className="mobile-menu"
            aria-expanded={menuOpen}
            aria-controls="notach-sidebar"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label={t("nav.openMenu")}
          >
            <Icon name="menu" />
          </button>
          <div className="top-title">
            {t(
              location.pathname === "/shared"
                ? "nav.shared"
                : location.pathname === "/archive"
                  ? "nav.archive"
                  : location.pathname === "/profile"
                    ? "nav.profile"
                    : "notes.mine",
            )}
          </div>
          <LanguageSwitcher />
          <div className="top-user">
            <span className="avatar small">
              {(user?.displayName || user?.email || "N")
                .slice(0, 1)
                .toUpperCase()}
            </span>
            <span>{user?.displayName || user?.email}</span>
          </div>
        </header>
        {children}
      </div>
      {confirmation}
    </div>
  );
}

export function NotesPage({
  status = "active",
  shared = false,
}: {
  status?: "active" | "archived";
  shared?: boolean;
}) {
  const { t, locale, formatDate, formatNumber } = useI18n();
  const { user } = useAuth();
  const navigate = useNavigate();
  const searchInput = useRef<HTMLInputElement>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [queryText, setQueryText] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selectedTag, setSelectedTag] = useState("");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [sortBy, setSortBy] = useState("updated");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [params] = useSearchParams();
  const notesScope = useRef("");
  const remoteTag = shared ? undefined : selectedTag || undefined;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      focusSearchFromShortcut(event, searchInput.current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  useEffect(() => {
    setFavoriteOnly(params.get("favorites") === "true");
  }, [params]);
  useEffect(() => {
    const timer = setTimeout(
      () => setDebounced(normalizeTitle(queryText)),
      300,
    );
    return () => clearTimeout(timer);
  }, [queryText]);
  useEffect(() => {
    if (!user?.uid) return;
    const scope = `${user.uid}:${shared}:${status}`;
    if (notesScope.current !== scope) setNotes([]);
    notesScope.current = scope;
    setBusy(true);
    setError(null);
    let active = true;
    const receive = (items: Note[]) => {
      if (!active) return;
      setNotes(items);
      setError(null);
      setBusy(false);
    };
    const fail = (reason: unknown) => {
      if (active) {
        setError(reason);
        setBusy(false);
      }
    };
    const stop = shared
      ? watchSharedNotes(user.uid, receive, fail)
      : watchOwnNotes(user.uid, receive, fail, status, remoteTag);
    return () => {
      active = false;
      stop();
    };
  }, [user?.uid, status, remoteTag, shared]);
  const tags = useMemo(
    () => [...new Set(notes.flatMap((note) => note.tags))].sort(),
    [notes],
  );
  const visible = useMemo(
    () =>
      notes
        .filter((note) => {
          if (favoriteOnly && !note.favorite) return false;
          if (selectedTag && !note.tags.includes(selectedTag)) return false;
          return (
            !debounced ||
            note.titleNormalized.includes(debounced) ||
            normalizeTitle(note.content).includes(debounced)
          );
        })
        .sort((a, b) => {
          if (debounced) {
            const titlePriority =
              Number(b.titleNormalized.includes(debounced)) -
              Number(a.titleNormalized.includes(debounced));
            if (titlePriority) return titlePriority;
          }
          return sortBy === "title"
            ? a.title.localeCompare(b.title, locale)
            : b.updatedAt.getTime() - a.updatedAt.getTime();
        }),
    [notes, debounced, favoriteOnly, sortBy, locale, selectedTag],
  );

  async function create() {
    if (!user) return;
    try {
      const note = await createNote(user.uid, {
        title: t("notes.untitled"),
        content: "",
        tags: [],
      });
      navigate(`/notes/${note.id}`);
    } catch (reason) {
      setError(reason);
    }
  }
  const heading = shared
    ? t("nav.shared")
    : status === "archived"
      ? t("nav.archive")
      : favoriteOnly
        ? t("notes.favorites")
        : t("notes.all");
  return (
    <AppShell>
      <main className="content-area" aria-busy={busy}>
        <div className="list-heading">
          <div>
            <div className="eyebrow">{t("notes.eyebrow")}</div>
            <h1>{heading}</h1>
            <p className="muted">
              {t("notes.count", { count: visible.length })}
            </p>
            {shared && (
              <p className="page-description">{t("notes.sharedDescription")}</p>
            )}
          </div>
          <Link to="/notes/new" className="button primary">
            <Icon name="plus" /> {t("notes.new")}
          </Link>
        </div>
        <div className="list-toolbar">
          <label className="search-box">
            <Icon name="search" />
            <input
              ref={searchInput}
              aria-label={t("notes.searchLabel")}
              aria-keyshortcuts="Control+K Meta+K"
              placeholder={t("notes.searchPlaceholder")}
              value={queryText}
              onChange={(event) => setQueryText(event.target.value)}
            />
            <kbd>Ctrl K</kbd>
          </label>
          <label className="select-label">
            {t("notes.sort")}
            <select
              value={sortBy}
              onChange={(event) => setSortBy(event.target.value)}
            >
              <option value="updated">{t("notes.sortUpdated")}</option>
              <option value="title">{t("notes.sortTitle")}</option>
            </select>
          </label>
        </div>
        <p className="list-update" role="status">
          {busy && notes.length > 0 ? (
            t("common.loading")
          ) : !busy && !error ? (
            <span className="sync-indicator">{t("notes.liveSync")}</span>
          ) : (
            "\u00a0"
          )}
        </p>
        {status === "active" && (
          <div className="tag-filters" aria-label={t("notes.tagFilter")}>
            <button
              className={!selectedTag ? "active" : ""}
              onClick={() => setSelectedTag("")}
            >
              {t("common.all")}
            </button>
            {tags.map((tag) => (
              <button
                key={tag}
                className={selectedTag === tag ? "active" : ""}
                onClick={() => setSelectedTag(selectedTag === tag ? "" : tag)}
              >
                #{tag}
              </button>
            ))}
          </div>
        )}
        {error !== null && (
          <ErrorAlert error={error} onDismiss={() => setError(null)} />
        )}
        {busy && notes.length === 0 ? (
          <div className="empty-state" role="status">
            {t("notes.loading")}
          </div>
        ) : visible.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">✦</div>
            <h2>
              {queryText || selectedTag
                ? t("notes.noResults")
                : t("notes.empty")}
            </h2>
            <p>
              {queryText || selectedTag
                ? t("notes.changeSearch")
                : t("notes.emptyDescription")}
            </p>
            {!queryText && !selectedTag && !shared && status === "active" && (
              <button className="button primary" onClick={() => void create()}>
                {t("notes.create")}
              </button>
            )}
          </div>
        ) : (
          <div className="note-grid">
            {visible.map((note) => (
              <Link
                className="note-card"
                key={note.id}
                to={`/notes/${note.id}`}
              >
                <div className="note-card-top">
                  <span className="note-kind">
                    {note.favorite
                      ? t("notes.favoriteBadge")
                      : t("notes.noteBadge")}
                  </span>
                  {shared && "sharedRole" in note && (
                    <span
                      className={`access-badge ${note.sharedRole === "editor" ? "editor" : "viewer"}`}
                    >
                      {note.sharedRole === "editor"
                        ? t("sharing.editor")
                        : t("sharing.viewer")}
                    </span>
                  )}
                  <time>
                    {formatDate(note.updatedAt, {
                      day: "numeric",
                      month: "short",
                    })}
                  </time>
                </div>
                <h2>{note.title || t("notes.untitled")}</h2>
                <p className="note-preview">
                  {note.content || t("notes.noText")}
                </p>
                <div className="note-card-footer">
                  <div className="chips">
                    {note.tags.slice(0, 3).map((tag) => (
                      <span className="chip" key={tag}>
                        #{tag}
                      </span>
                    ))}
                  </div>
                  <span className="summary-count">
                    ✦ {formatNumber(note.summaryCount ?? 0)}
                  </span>
                </div>
                <div className="note-card-meta">
                  {note.content.trim()
                    ? t("common.words", {
                        count: note.content.trim().split(/\s+/u).length,
                      })
                    : t("notes.draft")}{" "}
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </AppShell>
  );
}

interface SummaryResult extends SummaryContent {
  isUserEdited?: boolean;
  noteId: string;
  sourceRevision: number;
  requestId: string;
  modelId: string;
  promptVersion: string;
  durationMs: number;
  outdated: boolean;
  saved: boolean;
  summaryId?: string;
}

function restoreSummary(summary: Summary, revision: number): SummaryResult {
  return {
    ...summary,
    tags: summary.suggestedTags,
    requestId: crypto.randomUUID(),
    outdated: summary.sourceRevision !== revision,
    saved: true,
  };
}

export function NoteEditorRoute() {
  const { noteId } = useParams();
  return <NoteEditor key={noteId ?? "new"} />;
}

export function NoteEditor() {
  const { t, formatDate, formatNumber } = useI18n();
  const { noteId } = useParams();
  const isNew = noteId === "new" || !noteId;
  const { user } = useAuth();
  const navigate = useNavigate();
  const [note, setNote] = useState<Note | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagText, setTagText] = useState("");
  const [favorite, setFavorite] = useState(false);
  const [role, setRole] = useState<"owner" | "editor" | "viewer">("owner");
  const [loading, setLoading] = useState(!isNew);
  const [creationRetry, setCreationRetry] = useState(0);
  const newNotePromise = useRef<Promise<Note> | null>(null);
  const [metadataRetry, setMetadataRetry] = useState(0);
  const failedMetadata = useRef("");
  const metadataWrite = useRef<Promise<Note> | null>(null);
  const { confirm, confirmation } = useConfirmation();
  const [autoSaving, setAutoSaving] = useState(false);
  const [collaborationReady, setCollaborationReady] = useState(false);
  const [collaborationStatus, setCollaborationStatus] =
    useState<CollaborationStatus>("connecting");
  const [collaborationRetry, setCollaborationRetry] = useState(0);
  const collaboration = useRef<CollaborativeNoteSession | null>(null);
  const contentInput = useRef<HTMLTextAreaElement>(null);
  const pendingSelection = useRef<TextSelection | undefined>(undefined);
  const canonicalNote = useRef<Note | null>(note);
  const editorValues = useRef({ title, tags, favorite });
  canonicalNote.current = note;
  editorValues.current = { title, tags, favorite };
  const [saveStatus, setSaveStatus] = useState<
    "state.unsaved" | "state.saved" | "state.saving" | "state.saveError"
  >("state.unsaved");
  const [error, setError] = useState<unknown>(null);
  const [options, setOptions] = useState({
    language: "uk" as const,
    length: "short" as const,
    generateTags: true,
    generateTitle: true,
  });
  const [modelCatalog, setModelCatalog] = useState<SummaryModelCatalog | null>(
    null,
  );
  const [selectedModelId, setSelectedModelId] = useState("");
  const [modelsUnavailable, setModelsUnavailable] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const modelRequest = useRef<{
    uid: string;
    controller: AbortController;
    promise: Promise<void>;
  } | null>(null);
  const [summaryPanelOpen, setSummaryPanelOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [activity, setActivity] = useState<GenerationActivity | null>(null);
  const generationRequest = useRef("");
  const [cancelling, setCancelling] = useState(false);
  const generationCancelled = useRef(new Set<string>());
  const [result, setResult] = useState<SummaryResult | null>(null);
  const [summaryDraft, setSummaryDraft] = useState<SummaryContent | null>(null);
  const [summaryPointsText, setSummaryPointsText] = useState("");
  const [editingSummary, setEditingSummary] = useState(false);
  const editingSummaryRef = useRef(false);
  editingSummaryRef.current = editingSummary;
  const summarySession = useRef<CollaborativeSummarySession | null>(null);
  const [summarySyncStatus, setSummarySyncStatus] = useState("connecting");
  const summarySaving = summarySyncStatus === "saving";
  const summaryInputs = useRef<
    Partial<Record<SummaryField, HTMLInputElement | HTMLTextAreaElement | null>>
  >({});
  const summarySelection = useRef<SummarySelection | undefined>(undefined);
  const [savedSummaries, setSavedSummaries] = useState<Summary[]>([]);
  const [selectedSummaryId, setSelectedSummaryIdState] = useState("");
  const selectedSummary = useRef("");
  const setSelectedSummaryId = useCallback((id: string) => {
    selectedSummary.current = id;
    setSelectedSummaryIdState(id);
  }, []);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [tagsApplied, setTagsApplied] = useState(false);
  const [titleApplied, setTitleApplied] = useState(false);
  const [feedbackError, setFeedbackError] = useState<unknown>(null);
  const [feedbackSaving, setFeedbackSaving] = useState(false);
  const [feedbackRating, setFeedbackRating] = useState(5);
  const [feedbackComment, setFeedbackComment] = useState("");
  const [feedbackAccepted, setFeedbackAccepted] = useState(true);
  const [feedbackMessage, setFeedbackMessage] = useState<TranslationKey | null>(
    null,
  );
  const [shareOpen, setShareOpen] = useState(false);
  useEffect(() => {
    setFeedbackError(null);
    setFeedbackMessage(null);
    setFeedbackOpen(false);
    setFeedbackRating(5);
    setFeedbackComment("");
    setFeedbackAccepted(true);
  }, [selectedSummaryId]);

  const receiveRemoteNote = useCallback(
    (next: Note) => {
      const previous = canonicalNote.current;
      const values = editorValues.current;
      if (previous) {
        if ((values.title.trim() || t("notes.untitled")) === previous.title)
          setTitle(next.title);
        const removed = previous.tags.filter(
          (tag) => !values.tags.includes(tag),
        );
        const added = values.tags.filter((tag) => !previous.tags.includes(tag));
        setTags(
          normalizeTags([
            ...next.tags.filter((tag) => !removed.includes(tag)),
            ...added,
          ]),
        );
        if (values.favorite === Boolean(previous.favorite))
          setFavorite(Boolean(next.favorite));
      }
      canonicalNote.current = next;
      setNote(next);
    },
    [t],
  );

  useEffect(() => {
    if (!note?.id || !user?.uid || isNew || loading) return;
    let active = true;
    setCollaborationReady(false);
    const session = new CollaborativeNoteSession(
      db,
      note.id,
      user.uid,
      role !== "viewer",
      {
        onNote: (next) => {
          if (active) receiveRemoteNote(next);
        },
        onContent: (next, selection) => {
          if (!active) return;
          pendingSelection.current = selection;
          setContent(next);
        },
        getSelection: () => {
          const input = contentInput.current;
          return input && document.activeElement === input
            ? { start: input.selectionStart, end: input.selectionEnd }
            : undefined;
        },
        onStatus: (status) => {
          if (active) setCollaborationStatus(status);
        },
        onError: (reason) => {
          if (!active) return;
          setError(reason);
        },
      },
    );
    collaboration.current = session;
    void session
      .start()
      .then((latest) => {
        if (!active) return;
        receiveRemoteNote(latest);
        setCollaborationReady(true);
      })
      .catch((reason) => {
        if (active) setError(reason);
      });
    return () => {
      active = false;
      session.destroy();
      if (collaboration.current === session) collaboration.current = null;
    };
  }, [
    note?.id,
    user?.uid,
    role,
    isNew,
    loading,
    collaborationRetry,
    receiveRemoteNote,
  ]);

  useLayoutEffect(() => {
    const selection = pendingSelection.current;
    if (
      selection &&
      contentInput.current &&
      document.activeElement === contentInput.current
    )
      contentInput.current.setSelectionRange(selection.start, selection.end);
    pendingSelection.current = undefined;
  }, [content]);

  const loadModels = useCallback((): Promise<void> => {
    if (!user?.uid) return Promise.resolve();
    if (modelRequest.current?.uid === user.uid)
      return modelRequest.current.promise;
    const request = {
      uid: user.uid,
      controller: new AbortController(),
      promise: Promise.resolve(),
    };
    modelRequest.current = request;
    setModelsLoading(true);
    request.promise = apiRequest<SummaryModelCatalog>("/api/models", {
      signal: request.controller.signal,
    })
      .then((catalog) => {
        if (modelRequest.current !== request) return;
        setModelCatalog(catalog);
        setSelectedModelId((current) =>
          catalog.models.some((model) => model.id === current)
            ? current
            : catalog.defaultModelId,
        );
        setModelsUnavailable(false);
      })
      .catch(() => {
        if (
          modelRequest.current === request &&
          !request.controller.signal.aborted
        )
          setModelsUnavailable(true);
      })
      .finally(() => {
        if (modelRequest.current === request) {
          modelRequest.current = null;
          setModelsLoading(false);
        }
      });
    return request.promise;
  }, [user?.uid]);

  useEffect(() => {
    setModelCatalog(null);
    setSelectedModelId("");
    setModelsUnavailable(false);
    void loadModels();
    const onFocus = () => void loadModels();
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      const request = modelRequest.current;
      modelRequest.current = null;
      request?.controller.abort();
    };
  }, [loadModels]);

  useEffect(() => {
    if (summaryPanelOpen) void loadModels();
  }, [summaryPanelOpen, loadModels]);

  useEffect(() => {
    setSummaryPanelOpen(false);
    setHistoryOpen(false);
    setFeedbackOpen(false);
    setResult(null);
    setSummaryDraft(null);
    setSavedSummaries([]);
    setSelectedSummaryId("");
    setEditingSummary(false);
    setFeedbackMessage(null);
    setTagsApplied(false);
    setTitleApplied(false);
    setHistoryLoading(false);
    if (isNew || !noteId) {
      let active = true;
      setError(null);
      newNotePromise.current ??= createNote(user?.uid ?? "", {
        title: "",
        content: "",
        tags: [],
      });
      void newNotePromise.current
        .then((created) => {
          if (active) navigate(`/notes/${created.id}`, { replace: true });
        })
        .catch((reason) => {
          if (active) setError(reason);
        });
      return () => {
        active = false;
      };
    }
    let active = true;
    setLoading(true);
    setHistoryLoading(true);
    setError(null);
    setRole("owner");
    getNote(noteId)
      .then(async (loaded) => {
        if (!loaded) throw new LocalizedError("errors.permission");
        if (!active) return;
        setNote(loaded);
        setTitle(loaded.title);
        setContent(loaded.content);
        setTags(loaded.tags);
        setFavorite(loaded.favorite === true);
        if (loaded.ownerUid !== user?.uid) {
          const share = await getDoc(
            doc(db, "noteShares", `${noteId}_${user?.uid}`),
          );
          if (!share.exists() || share.data().status !== "accepted")
            throw new LocalizedError("errors.permission");
          if (!active) return;
          setRole(share.data().role === "editor" ? "editor" : "viewer");
        }
        setSaveStatus("state.saved");
      })
      .catch((reason) => {
        if (active) setError(reason);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [noteId, isNew, user?.uid, setSelectedSummaryId, navigate, creationRetry]);

  useEffect(() => {
    if (!note?.id || loading) return;
    const stopHistory = watchSummaryHistory(
      db,
      note.id,
      (items) => {
        setSavedSummaries(items);
        setHistoryLoading(false);
        const current = selectedSummary.current;
        const latest = items[0];
        const selected = items.find((item) => item.id === current);
        if (
          !editingSummaryRef.current &&
          latest &&
          (!current || !selected || latest.id !== current)
        ) {
          setSelectedSummaryId(latest.id);
          const restored = restoreSummary(
            latest,
            canonicalNote.current?.revision ?? 1,
          );
          setResult(restored);
          setSummaryDraft(restored);
          setSummaryPointsText(restored.keyPoints.join("\n"));
        } else if (selected) {
          setResult(
            restoreSummary(selected, canonicalNote.current?.revision ?? 1),
          );
        }
      },
      (reason) => {
        setHistoryLoading(false);
        setError(reason);
      },
    );
    const stopActivity = watchGenerationActivity(
      db,
      note.id,
      (next) => {
        setActivity(next);
        if (
          next?.requestId === generationRequest.current &&
          next.status !== "generating"
        ) {
          if (next.status === "cancelled")
            generationCancelled.current.add(next.requestId);
          setGenerating(false);
        }
      },
      setError,
    );
    return () => {
      stopHistory();
      stopActivity();
    };
  }, [note?.id, loading, setSelectedSummaryId]);

  useEffect(() => {
    if (!note?.id || !selectedSummaryId) return;
    let active = true;
    const session = new CollaborativeSummarySession(
      db,
      note.id,
      selectedSummaryId,
      role !== "viewer",
      {
        onDraft: (fields, selection) => {
          if (!active) return;
          summarySelection.current = selection;
          setSummaryDraft({
            shortText: fields.shortText,
            keyPoints: fields.pointsText.split("\n"),
            tags: fields.tagsText.split("\n").filter(Boolean),
            suggestedTitle: fields.suggestedTitle,
          });
          setSummaryPointsText(fields.pointsText);
        },
        getSelection: () => {
          for (const [field, input] of Object.entries(summaryInputs.current)) {
            if (input && document.activeElement === input)
              return {
                field: field as SummaryField,
                start: input.selectionStart ?? 0,
                end: input.selectionEnd ?? 0,
              };
          }
          return undefined;
        },
        onStatus: (status) => {
          if (active) setSummarySyncStatus(status);
        },
        onError: (reason) => {
          if (active) setError(reason);
        },
      },
    );
    summarySession.current = session;
    void session.start().catch((reason) => {
      if (active) {
        setError(reason);
        setSummarySyncStatus("error");
      }
    });
    return () => {
      active = false;
      session.destroy();
      if (summarySession.current === session) summarySession.current = null;
    };
  }, [note?.id, selectedSummaryId, role]);

  useLayoutEffect(() => {
    const selection = summarySelection.current;
    const input = selection && summaryInputs.current[selection.field];
    if (selection && input && document.activeElement === input)
      input.setSelectionRange(selection.start, selection.end);
    summarySelection.current = undefined;
  }, [summaryDraft, summaryPointsText]);

  useEffect(() => {
    if (!note || isNew || role === "viewer" || autoSaving) return;
    const fields = {
      ...((title.trim() || t("notes.untitled")) !== note.title
        ? { title: title.trim() || t("notes.untitled") }
        : {}),
      ...(tags.join("|") !== note.tags.join("|") ? { tags } : {}),
    };
    if (!Object.keys(fields).length) return;
    const fingerprint = JSON.stringify([fields, metadataRetry]);
    if (failedMetadata.current === fingerprint) return;
    const timer = setTimeout(() => {
      setAutoSaving(true);
      const write = updateNoteFields(note.id, fields, { baseTags: note.tags });
      metadataWrite.current = write;
      void write
        .then((updated) => {
          receiveRemoteNote(updated);
          failedMetadata.current = "";
        })
        .catch((reason) => {
          failedMetadata.current = fingerprint;
          setError(reason);
          setSaveStatus("state.saveError");
        })
        .finally(() => {
          if (metadataWrite.current === write) metadataWrite.current = null;
          setAutoSaving(false);
        });
    }, 350);
    return () => {
      clearTimeout(timer);
    };
  }, [
    note,
    isNew,
    role,
    title,
    tags,
    autoSaving,
    metadataRetry,
    receiveRemoteNote,
    t,
  ]);

  useEffect(() => {
    if (isNew || role === "viewer" || !noteId) return;
    const isDirty =
      Boolean(
        note &&
        ((title.trim() || t("notes.untitled")) !== note.title ||
          content !== note.content ||
          tags.join("|") !== note.tags.join("|") ||
          favorite !== (note.favorite === true)),
      ) ||
      (!note && Boolean(title || content || tags.length));
    setSaveStatus(
      autoSaving || collaborationStatus === "saving"
        ? "state.saving"
        : collaborationStatus === "error" || Boolean(failedMetadata.current)
          ? "state.saveError"
          : isDirty
            ? "state.unsaved"
            : "state.saved",
    );
  }, [
    note,
    title,
    content,
    tags,
    favorite,
    role,
    isNew,
    noteId,
    autoSaving,
    collaborationStatus,
    metadataRetry,
    t,
  ]);

  const dirty = isNew
    ? Boolean(title.trim() || content.trim() || tags.length)
    : Boolean(
        note &&
        ((title.trim() || t("notes.untitled")) !== note.title ||
          content !== note.content ||
          tags.join("|") !== note.tags.join("|") ||
          favorite !== (note.favorite === true)),
      );
  const prepareToLeave = useCallback(async () => {
    if (isNew) {
      await newNotePromise.current;
      return;
    }
    if (role === "viewer") return;
    const original = await collaboration.current?.flush();
    const updated = await metadataWrite.current;
    const baseline = updated ?? original ?? canonicalNote.current;
    const values = editorValues.current;
    if (baseline) {
      const nextTitle = values.title.trim() || t("notes.untitled");
      const fields = {
        ...(nextTitle !== baseline.title ? { title: nextTitle } : {}),
        ...(values.tags.join("|") !== baseline.tags.join("|")
          ? { tags: values.tags }
          : {}),
        ...(values.favorite !== Boolean(baseline.favorite)
          ? { favorite: values.favorite }
          : {}),
      };
      if (Object.keys(fields).length) {
        const saved = await updateNoteFields(baseline.id, fields, {
          baseTags: baseline.tags,
        });
        receiveRemoteNote(saved);
      }
    }
    await summarySession.current?.flush();
  }, [isNew, role, t, receiveRemoteNote]);

  useEffect(() => {
    const pending =
      dirty ||
      autoSaving ||
      collaborationStatus === "saving" ||
      summarySyncStatus === "saving" ||
      summarySyncStatus === "error";
    const guard = (event: BeforeUnloadEvent) => {
      if (pending) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const guardInternalLinks = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (
        !(anchor instanceof HTMLAnchorElement) ||
        anchor.origin !== window.location.origin ||
        anchor.hasAttribute("download") ||
        (anchor.target && anchor.target !== "_self")
      )
        return;
      if (anchor.href !== window.location.href && pending) {
        event.preventDefault();
        event.stopPropagation();
        const destination = anchor.pathname + anchor.search + anchor.hash;
        confirm({
          title: t("confirmation.leaveTitle"),
          description: t("confirmation.leaveDescription"),
          confirmLabel: t("confirmation.saveAndLeave"),
          pendingLabel: t("state.saving"),
          onConfirm: async () => {
            await prepareToLeave();
            navigate(destination);
          },
        });
      }
    };
    window.addEventListener("beforeunload", guard);
    document.addEventListener("click", guardInternalLinks, true);
    return () => {
      window.removeEventListener("beforeunload", guard);
      document.removeEventListener("click", guardInternalLinks, true);
    };
  }, [
    dirty,
    autoSaving,
    collaborationStatus,
    t,
    summarySyncStatus,
    confirm,
    prepareToLeave,
    navigate,
  ]);

  async function reloadOriginal() {
    if (!noteId || isNew) return;
    const latest = await getNote(noteId);
    if (!latest) {
      setError(new LocalizedError("errors.noteNotFound"));
      return;
    }
    setNote(latest);
    setTitle(latest.title);
    setContent(latest.content);
    setTags(latest.tags);
    setFavorite(latest.favorite === true);
    setError(null);
  }

  async function addTag(event: FormEvent) {
    event.preventDefault();
    const normalized = normalizeTags([...tags, tagText]);
    if (normalized.length > tags.length) setTags(normalized);
    setTagText("");
  }

  async function summarize() {
    if (!note || dirty) {
      setError(new LocalizedError("errors.saveFirst"));
      return;
    }
    if (!content.trim()) {
      setError(new LocalizedError("errors.emptyNote"));
      return;
    }
    setGenerating(true);
    setError(null);
    setFeedbackOpen(false);
    setHistoryOpen(false);
    setTagsApplied(false);
    setTitleApplied(false);
    const requestId = crypto.randomUUID();
    generationRequest.current = requestId;
    try {
      const data = await apiRequest<
        Omit<SummaryResult, keyof SummaryContent> & { summary: SummaryContent }
      >("/api/summarize", {
        method: "POST",
        body: JSON.stringify({
          noteId: note.id,
          revision: note.revision,
          requestId,
          modelId: selectedModelId || undefined,
          options: SummaryOptionsSchema.parse(options),
        }),
      });
      if (
        generationCancelled.current.has(requestId) ||
        generationRequest.current !== requestId
      )
        return;
      if (
        data.saved &&
        data.summaryId &&
        selectedSummary.current === data.summaryId
      )
        return;
      const parsed = SummaryContentSchema.parse(data.summary);
      setResult({ ...data, ...parsed });
      setSummaryDraft(parsed);
      setSummaryPointsText(parsed.keyPoints.join("\n"));
      setEditingSummary(false);
      setSelectedSummaryId(data.summaryId ?? "");
      setFeedbackMessage(null);
      if (data.outdated) setError(new LocalizedError("summary.outdated"));
    } catch (reason) {
      if (
        generationRequest.current === requestId &&
        (reason as { code?: string }).code !== "AI_CANCELLED" &&
        !generationCancelled.current.has(requestId)
      )
        setError(reason);
    } finally {
      if (generationRequest.current === requestId) {
        generationRequest.current = "";
        setGenerating(false);
      }
    }
  }

  function updateSummaryField(field: SummaryField, value: string) {
    if (field === "pointsText") setSummaryPointsText(value);
    else
      setSummaryDraft((draft) =>
        draft ? { ...draft, [field]: value } : draft,
      );
    try {
      summarySession.current?.update(field, value);
    } catch (reason) {
      setError(reason);
    }
  }

  async function cancelSummarization() {
    if (!note) return;
    const sharedRequest =
      activity?.status === "generating" &&
      (!activity.expiresAt || activity.expiresAt.toMillis() > Date.now())
        ? activity.requestId
        : undefined;
    const localRequest =
      generating && !generationCancelled.current.has(generationRequest.current)
        ? generationRequest.current
        : undefined;
    const requestId = sharedRequest || localRequest;
    if (!requestId) return;
    setCancelling(true);
    try {
      const data = await apiRequest<{ cancelled: boolean }>(
        `/api/notes/${note.id}/generation/${requestId}/cancel`,
        { method: "POST", body: "{}" },
      );
      if (!data.cancelled) return;
      generationCancelled.current.add(requestId);
      setGenerating(false);
      setActivity((current) =>
        current?.requestId === requestId
          ? { ...current, status: "cancelled" }
          : current,
      );
    } catch (reason) {
      setError(reason);
    } finally {
      setCancelling(false);
    }
  }

  async function submitFeedback() {
    if (!note || !result) return;
    const summaryId = selectedSummaryId;
    setFeedbackError(null);
    setFeedbackSaving(true);
    try {
      if (!selectedSummaryId)
        throw new LocalizedError("errors.saveSummaryFirst");
      await apiRequest(
        `/api/notes/${note.id}/summaries/${selectedSummaryId}/feedback`,
        {
          method: "POST",
          body: JSON.stringify({
            rating: feedbackRating,
            comment: feedbackComment,
            accepted: feedbackAccepted,
          }),
        },
      );
      if (selectedSummary.current === summaryId) {
        setFeedbackMessage("feedback.saved");
        setFeedbackOpen(false);
      }
    } catch (reason) {
      if (selectedSummary.current === summaryId) setFeedbackError(reason);
    } finally {
      setFeedbackSaving(false);
    }
  }

  function showHistory() {
    setHistoryOpen((open) => !open);
  }

  async function chooseSummary(summary: Summary) {
    if (!note) return;
    const item = restoreSummary(summary, note.revision);
    setSelectedSummaryId(summary.id);
    setResult(item);
    setSummaryDraft({
      shortText: summary.shortText,
      keyPoints: summary.keyPoints,
      tags: summary.suggestedTags,
      ...(summary.suggestedTitle
        ? { suggestedTitle: summary.suggestedTitle }
        : {}),
    });
    setSummaryPointsText(summary.keyPoints.join("\n"));
    setEditingSummary(false);
    setHistoryOpen(false);
    setFeedbackOpen(false);
    setFeedbackMessage(null);
    setFeedbackRating(5);
    setFeedbackComment("");
    setFeedbackAccepted(true);
    setTagsApplied(false);
    setTitleApplied(false);
  }

  async function archive() {
    if (!note) return;
    if (dirty) {
      setError(new LocalizedError("errors.saveFirst"));
      return;
    }
    try {
      await setNoteStatus(
        note,
        note.status === "archived" ? "active" : "archived",
      );
      navigate(note.status === "archived" ? "/archive" : "/notes");
    } catch (reason) {
      setError(reason);
    }
  }

  function deleteCurrent() {
    if (!note) return;
    const id = note.id;
    confirm({
      title: t("confirmation.deleteTitle"),
      description: t("confirmation.deleteDescription"),
      notice: t("confirmation.irreversible"),
      context: title.trim() || t("notes.untitled"),
      tone: "danger",
      icon: "trash",
      confirmLabel: t("common.delete"),
      pendingLabel: t("confirmation.deleting"),
      onConfirm: async () => {
        await apiRequest(`/api/notes/${id}`, { method: "DELETE" });
        navigate("/notes");
      },
    });
  }

  function openShares() {
    setShareOpen(true);
  }

  function retryNoteSave() {
    if (isNew) {
      newNotePromise.current = null;
      setCreationRetry((value) => value + 1);
    } else {
      failedMetadata.current = "";
      setMetadataRetry((value) => value + 1);
    }
  }

  const hasRevisionConflict =
    error instanceof NoteRevisionConflict ||
    (error instanceof LocalizedError &&
      error.translationKey === "errors.revisionConflict") ||
    (error as { code?: string } | null)?.code === "NOTE_REVISION_CONFLICT";
  const summaryValue = summaryDraft ?? result;
  const mergedSuggestedTags = normalizeTags([
    ...tags,
    ...(summaryValue?.tags ?? []).map((tag) => tag.slice(0, 30)),
  ]);
  const canApplySuggestedTags =
    mergedSuggestedTags.join("|") !== tags.join("|");
  async function saveAutomaticFields(
    fields: { title?: string; tags?: string[]; favorite?: boolean },
    mergeTags = false,
  ) {
    if (!note || role === "viewer") return false;
    setAutoSaving(true);
    setError(null);
    setSaveStatus("state.saving");
    try {
      await collaboration.current?.flush();
      const updated = await updateNoteFields(note.id, fields, { mergeTags });
      canonicalNote.current = updated;
      setNote(updated);
      if (fields.title !== undefined) setTitle(updated.title);
      if (fields.tags !== undefined) setTags(updated.tags);
      if (fields.favorite !== undefined) setFavorite(Boolean(updated.favorite));
      setSaveStatus("state.saved");
      return true;
    } catch (reason) {
      setError(reason);
      setSaveStatus("state.saveError");
      return false;
    } finally {
      setAutoSaving(false);
    }
  }
  async function applySuggestedTags() {
    if (role === "viewer" || !canApplySuggestedTags) return;
    if (await saveAutomaticFields({ tags: mergedSuggestedTags }, true))
      setTagsApplied(true);
  }
  async function applySuggestedTitle() {
    if (!summaryValue?.suggestedTitle || role === "viewer") return;
    if (await saveAutomaticFields({ title: summaryValue.suggestedTitle }))
      setTitleApplied(true);
  }
  function changeContent(next: string) {
    setContent(next);
    if (!isNew) {
      try {
        collaboration.current?.updateText(next);
      } catch (reason) {
        setError(reason);
      }
    }
  }
  async function retryCollaboration() {
    setError(null);
    if (collaborationReady && collaboration.current) {
      try {
        await collaboration.current.flush();
      } catch (reason) {
        setError(reason);
        return;
      }
    }
    setCollaborationRetry((retry) => retry + 1);
  }
  if (loading)
    return (
      <AppShell>
        <main className="content-area">
          <div role="status" className="empty-state">
            {t("editor.loading")}
          </div>
        </main>
      </AppShell>
    );
  if (!isNew && !note)
    return (
      <AppShell>
        <main className="content-area">
          <h1>{t("errors.noteNotFound")}</h1>
          {error !== null && (
            <ErrorAlert error={error} onDismiss={() => setError(null)} />
          )}
          <Link to="/notes" className="button secondary">
            {t("editor.back")}
          </Link>
        </main>
      </AppShell>
    );
  const busyGenerating =
    generating ||
    (activity?.status === "generating" &&
      (!activity.expiresAt || activity.expiresAt.toMillis() > Date.now()));
  const stale = Boolean(
    result &&
    note &&
    (result.sourceRevision !== note.revision || content !== note.content),
  );

  return (
    <AppShell beforeSignOut={prepareToLeave}>
      <main className="editor-page">
        <div className="editor-top">
          <Link
            to={note?.status === "archived" ? "/archive" : "/notes"}
            className="back-link"
          >
            {t("editor.backWithArrow")}
          </Link>
          <div className="editor-actions">
            <span
              className={`save-state ${saveStatus === "state.saveError" ? "state-error" : ""}`}
              aria-live="polite"
            >
              <i /> {isNew && !note ? t("notes.new") : t(saveStatus)}
            </span>
            {saveStatus === "state.saveError" && error === null && (
              <button
                type="button"
                className="text-button"
                onClick={retryNoteSave}
              >
                {t("common.retry")}
              </button>
            )}
            <button
              className="button secondary"
              aria-expanded={summaryPanelOpen}
              aria-controls="summary-panel"
              onClick={() => setSummaryPanelOpen((open) => !open)}
            >
              {summaryPanelOpen
                ? t("summary.hidePanel")
                : t("summary.openPanel")}
            </button>
          </div>
        </div>
        {error !== null && (
          <ErrorAlert error={error} onDismiss={() => setError(null)}>
            {(saveStatus === "state.saveError" || isNew) && (
              <button
                className="button small secondary"
                onClick={retryNoteSave}
              >
                {t("common.retry")}
              </button>
            )}
            {hasRevisionConflict && (
              <div className="inline-actions">
                <button
                  className="button small secondary"
                  onClick={() => void reloadOriginal()}
                >
                  {t("editor.reload")}
                </button>
                <button
                  className="button small secondary"
                  onClick={() => void navigator.clipboard.writeText(content)}
                >
                  {t("editor.copy")}
                </button>
              </div>
            )}
          </ErrorAlert>
        )}
        <div
          className={`editor-columns ${summaryPanelOpen ? "" : "summary-hidden"}`}
        >
          <section
            className="editor-panel original-panel"
            aria-labelledby="original-heading"
          >
            <div className="panel-head">
              <div>
                <div className="eyebrow">{t("editor.original")}</div>
                <h1 id="original-heading">
                  {note?.status === "archived"
                    ? t("editor.archived")
                    : t("editor.yourNote")}
                </h1>
              </div>
              {note && role === "owner" && (
                <div className="panel-tools">
                  <button
                    aria-label={
                      favorite ? t("editor.unfavorite") : t("editor.favorite")
                    }
                    className={`icon-button ${favorite ? "is-favorite" : ""}`}
                    aria-busy={autoSaving}
                    disabled={autoSaving || !collaborationReady}
                    onClick={() =>
                      void saveAutomaticFields({ favorite: !favorite })
                    }
                  >
                    {favorite ? "★" : "☆"}
                  </button>
                  <button
                    className="button small secondary"
                    onClick={() => void openShares()}
                  >
                    {t("sharing.share")}
                  </button>
                </div>
              )}
            </div>
            <label className="field-label">
              {t("editor.title")}
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={120}
                placeholder={t("editor.titlePlaceholder")}
                readOnly={role === "viewer" || isNew}
              />
            </label>
            <div className="tag-entry">
              <div className="chips">
                {tags.map((tag) => (
                  <span className="chip" key={tag}>
                    #{tag}
                    {role !== "viewer" && (
                      <button
                        aria-label={t("editor.removeTag", { tag })}
                        onClick={() =>
                          setTags(tags.filter((item) => item !== tag))
                        }
                      >
                        ×
                      </button>
                    )}
                  </span>
                ))}
              </div>
              {role !== "viewer" && (
                <form onSubmit={addTag}>
                  <input
                    disabled={isNew}
                    aria-label={t("editor.newTag")}
                    value={tagText}
                    onChange={(event) => setTagText(event.target.value)}
                    maxLength={30}
                    placeholder={t("editor.addTag")}
                  />
                </form>
              )}
            </div>
            <label className="field-label content-label">
              {t("editor.text")}
              <textarea
                ref={contentInput}
                value={content}
                onChange={(event) => changeContent(event.target.value)}
                maxLength={50000}
                placeholder={t("editor.textPlaceholder")}
                readOnly={
                  role === "viewer" ||
                  isNew ||
                  (!isNew &&
                    (!collaborationReady || collaborationStatus === "error"))
                }
              />
            </label>
            <div className="editor-footer">
              <span>
                {t("editor.statistics", {
                  words: t("common.words", {
                    count: content.trim()
                      ? content.trim().split(/\s+/u).length
                      : 0,
                  }),
                  characters: t("common.characters", { count: content.length }),
                })}
              </span>
              {note && (
                <span
                  className="revision-badge"
                  title={t("editor.revisionHelp")}
                >
                  {t("editor.version", {
                    revision: formatNumber(note.revision),
                  })}
                </span>
              )}
            </div>
            {!isNew && (
              <div className="collaboration-status" aria-live="polite">
                <span>
                  {t(
                    collaborationStatus === "connecting"
                      ? "collaboration.connecting"
                      : collaborationStatus === "error" ||
                          Boolean(failedMetadata.current)
                        ? "collaboration.paused"
                        : role === "viewer"
                          ? "collaboration.viewer"
                          : "collaboration.enabled",
                  )}
                </span>
                {collaborationStatus === "error" && (
                  <button
                    className="text-button"
                    onClick={() => void retryCollaboration()}
                  >
                    {t("collaboration.retry")}
                  </button>
                )}
              </div>
            )}
            <div className="original-tools">
              {note && role !== "viewer" && (
                <>
                  <button
                    className="button small secondary"
                    onClick={() => void archive()}
                  >
                    {note.status === "archived"
                      ? t("editor.unarchive")
                      : t("editor.archive")}
                  </button>
                  {role === "owner" && (
                    <button
                      className="button small danger-ghost"
                      onClick={() => void deleteCurrent()}
                    >
                      {t("common.delete")}
                    </button>
                  )}
                </>
              )}
            </div>
          </section>

          {summaryPanelOpen && (
            <section
              id="summary-panel"
              className="editor-panel assistant-panel"
              aria-labelledby="assistant-heading"
            >
              <SummaryGenerationControls>
                <div
                  className="summary-settings"
                  role="group"
                  aria-label={t("summary.settings")}
                >
                  <label className="model-select">
                    {t("summary.model")}
                    <select
                      value={selectedModelId}
                      aria-busy={modelsLoading}
                      disabled={
                        busyGenerating || !modelCatalog || role === "viewer"
                      }
                      onChange={(event) =>
                        setSelectedModelId(event.target.value)
                      }
                    >
                      {modelCatalog ? (
                        modelCatalog.models.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.label}
                          </option>
                        ))
                      ) : (
                        <option value="">{t("summary.serverModel")}</option>
                      )}
                    </select>
                  </label>
                  {modelsUnavailable && (
                    <p className="muted model-fallback" role="status">
                      {t("summary.modelsFallback")}{" "}
                      <button
                        type="button"
                        className="text-button"
                        disabled={modelsLoading}
                        aria-busy={modelsLoading}
                        onClick={() => void loadModels()}
                      >
                        {modelsLoading
                          ? t("summary.loadingModels")
                          : t("summary.retryModels")}
                      </button>
                    </p>
                  )}
                  <div className="options-row">
                    <label>
                      {t("summary.length")}
                      <select
                        disabled={busyGenerating || role === "viewer"}
                        value={options.length}
                        onChange={(event) =>
                          setOptions({
                            ...options,
                            length: event.target.value as typeof options.length,
                          })
                        }
                      >
                        <option value="short">{t("summary.short")}</option>
                        <option value="medium">{t("summary.medium")}</option>
                        <option value="detailed">
                          {t("summary.detailed")}
                        </option>
                      </select>
                    </label>
                    <label>
                      {t("common.language")}
                      <select
                        disabled={busyGenerating || role === "viewer"}
                        value={options.language}
                        onChange={(event) =>
                          setOptions({
                            ...options,
                            language: event.target
                              .value as typeof options.language,
                          })
                        }
                      >
                        <option value="uk">{t("language.uk")}</option>
                        <option value="en">{t("language.en")}</option>
                      </select>
                    </label>
                  </div>
                </div>
                <div
                  className="summary-options"
                  role="group"
                  aria-label={t("summary.include")}
                >
                  <label className="summary-option">
                    <input
                      type="checkbox"
                      aria-label={t("summary.tags")}
                      aria-describedby="summary-tags-help"
                      disabled={busyGenerating || role === "viewer"}
                      checked={options.generateTags}
                      onChange={(event) =>
                        setOptions({
                          ...options,
                          generateTags: event.target.checked,
                        })
                      }
                    />
                    <span className="option-copy">
                      <span className="option-title">{t("summary.tags")}</span>
                      <small id="summary-tags-help">
                        {t("summary.tagsDescription")}
                      </small>
                    </span>
                    <span className="option-check" aria-hidden="true" />
                  </label>
                  <label className="summary-option">
                    <input
                      type="checkbox"
                      aria-label={t("summary.titleOption")}
                      aria-describedby="summary-title-help"
                      disabled={busyGenerating || role === "viewer"}
                      checked={options.generateTitle}
                      onChange={(event) =>
                        setOptions({
                          ...options,
                          generateTitle: event.target.checked,
                        })
                      }
                    />
                    <span className="option-copy">
                      <span className="option-title">
                        {t("summary.titleOption")}
                      </span>
                      <small id="summary-title-help">
                        {t("summary.titleDescription")}
                      </small>
                    </span>
                    <span className="option-check" aria-hidden="true" />
                  </label>
                </div>
                <button
                  type="button"
                  className={`button primary summarize-button ${busyGenerating ? "is-generating" : ""}`}
                  onClick={() =>
                    void (busyGenerating ? cancelSummarization() : summarize())
                  }
                  aria-busy={cancelling}
                  title={
                    busyGenerating && role !== "viewer"
                      ? t("summary.cancelHint")
                      : undefined
                  }
                  disabled={
                    cancelling ||
                    (busyGenerating
                      ? role === "viewer"
                      : !note ||
                        role === "viewer" ||
                        !content.trim() ||
                        dirty ||
                        historyLoading ||
                        autoSaving ||
                        !collaborationReady ||
                        collaborationStatus !== "saved")
                  }
                >
                  {cancelling ? (
                    <span className="spinner" aria-hidden="true" />
                  ) : (
                    <Icon name={busyGenerating ? "stop" : "sparkles"} />
                  )}
                  <AsyncButtonLabel
                    idle={t("summary.generate")}
                    busy={t(
                      cancelling
                        ? "summary.cancelling"
                        : role === "viewer"
                          ? "summary.generating"
                          : "summary.cancelGeneration",
                    )}
                    loading={busyGenerating || cancelling}
                  />
                </button>
                <SummaryLimitsPanel
                  modelId={selectedModelId || undefined}
                  refreshKey={`${busyGenerating}:${activity?.requestId ?? ""}:${activity?.status ?? ""}`}
                />
              </SummaryGenerationControls>
              {!note && (
                <div className="summary-empty">
                  <div className="empty-icon">✧</div>
                  <h3>{t("summary.saveNoteFirst")}</h3>
                  <p>{t("summary.saveNoteDescription")}</p>
                </div>
              )}
              {note && !result && !busyGenerating && !historyLoading && (
                <div className="summary-empty">
                  <div className="empty-icon">✧</div>
                  <h3>{t("summary.emptyTitle")}</h3>
                  <p>{t("summary.emptyDescription")}</p>
                  <small>{t("summary.reviewNotice")}</small>
                </div>
              )}
              {activity?.status === "cancelled" && (
                <p role="status">{t("summary.cancelled")}</p>
              )}

              {busyGenerating && (
                <div className="generating-state" role="status">
                  <span className="spinner" />
                  {t("summary.generating")}
                </div>
              )}
              {!busyGenerating && result && summaryValue && (
                <div className="summary-content">
                  {stale && (
                    <div className="alert warning">{t("summary.outdated")}</div>
                  )}
                  {editingSummary && stale && result.saved && (
                    <p className="muted">{t("summary.historicalEdit")}</p>
                  )}
                  {options.generateTitle &&
                    (Boolean(summaryValue.suggestedTitle) ||
                      (editingSummary &&
                        result.suggestedTitle !== undefined)) && (
                      <div className="summary-section">
                        <div className="section-heading">
                          <h3>{t("summary.suggestedTitle")}</h3>
                        </div>
                        {editingSummary ? (
                          <input
                            ref={(input) => {
                              summaryInputs.current.suggestedTitle = input;
                            }}
                            className="summary-title-edit"
                            aria-label={t("summary.editTitle")}
                            value={summaryValue.suggestedTitle}
                            maxLength={120}
                            onChange={(event) =>
                              updateSummaryField(
                                "suggestedTitle",
                                event.target.value,
                              )
                            }
                          />
                        ) : (
                          <p>{summaryValue.suggestedTitle}</p>
                        )}
                        {role !== "viewer" && (
                          <button
                            className="button small secondary"
                            disabled={
                              autoSaving ||
                              !collaborationReady ||
                              title === summaryValue.suggestedTitle
                            }
                            onClick={() => void applySuggestedTitle()}
                          >
                            {title === summaryValue.suggestedTitle
                              ? t("summary.titleAlreadyApplied")
                              : t("summary.applyTitle")}
                          </button>
                        )}
                        {titleApplied && (
                          <p role="status" className="muted">
                            {t("summary.titleApplied")}
                          </p>
                        )}
                      </div>
                    )}
                  <div className="summary-section">
                    <div className="section-heading">
                      <h3>{t("summary.shortText")}</h3>
                      {!editingSummary && role !== "viewer" && (
                        <button
                          className="text-button"
                          disabled={
                            (stale && !result.saved) ||
                            summarySyncStatus === "connecting" ||
                            summarySyncStatus === "error"
                          }
                          onClick={() => {
                            setSummaryPointsText(
                              summaryValue.keyPoints.join("\n"),
                            );
                            setEditingSummary(true);
                          }}
                        >
                          {t("common.edit")}
                        </button>
                      )}
                    </div>
                    {editingSummary ? (
                      <textarea
                        ref={(input) => {
                          summaryInputs.current.shortText = input;
                        }}
                        className="summary-edit"
                        aria-label={t("summary.editText")}
                        value={summaryValue.shortText}
                        onChange={(event) =>
                          updateSummaryField("shortText", event.target.value)
                        }
                        maxLength={4000}
                      />
                    ) : (
                      <p>{summaryValue.shortText}</p>
                    )}
                  </div>
                  <div className="summary-section">
                    <div className="section-heading">
                      <h3>{t("summary.keyPoints")}</h3>
                    </div>
                    {editingSummary ? (
                      <textarea
                        ref={(input) => {
                          summaryInputs.current.pointsText = input;
                        }}
                        className="summary-edit points-edit"
                        aria-label={t("summary.editPoints")}
                        value={summaryPointsText}
                        onChange={(event) =>
                          updateSummaryField("pointsText", event.target.value)
                        }
                      />
                    ) : (
                      <ol className="key-points">
                        {summaryValue.keyPoints.map((point, index) => (
                          <li key={`${index}-${point}`}>
                            <span>{String(index + 1).padStart(2, "0")}</span>
                            {point}
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                  {options.generateTags && summaryValue.tags.length > 0 && (
                    <div className="summary-section">
                      <div className="section-heading">
                        <h3>{t("summary.suggestedTags")}</h3>
                      </div>
                      <div className="chips">
                        {summaryValue.tags.map((tag) => (
                          <span className="chip suggested" key={tag}>
                            #{tag}
                          </span>
                        ))}
                      </div>
                      {role !== "viewer" && (
                        <button
                          className="button small secondary apply-tags"
                          disabled={
                            !canApplySuggestedTags ||
                            autoSaving ||
                            !collaborationReady
                          }
                          onClick={() => void applySuggestedTags()}
                        >
                          {canApplySuggestedTags
                            ? t("summary.applyTags")
                            : t("summary.tagsAlreadyApplied")}
                        </button>
                      )}
                      {tagsApplied && (
                        <p className="muted" role="status">
                          {t("summary.tagsApplied")}
                        </p>
                      )}
                    </div>
                  )}
                  <p className="auto-label">
                    ✦{" "}
                    {result.saved
                      ? t("summary.savedLabel")
                      : t("summary.autoLabel")}
                    {result.modelId !== "user-authored" &&
                      result.durationMs > 0 && (
                        <>
                          {" "}
                          ·{" "}
                          {t("summary.duration", {
                            duration: result.durationMs,
                          })}
                        </>
                      )}
                  </p>
                  {result.modelId === "user-authored" ? (
                    <p className="model-label">{t("summary.userEdited")}</p>
                  ) : (
                    <p className="model-label">
                      {t("summary.modelUsed", {
                        model:
                          modelCatalog?.models.find(
                            (model) => model.id === result.modelId,
                          )?.label ?? result.modelId,
                      })}
                    </p>
                  )}
                  {summarySyncStatus === "error" && (
                    <button
                      className="button small secondary"
                      onClick={() =>
                        void summarySession.current?.retry().catch(setError)
                      }
                    >
                      {t("common.retry")}
                    </button>
                  )}
                  {editingSummary && (
                    <div className="inline-actions">
                      <button
                        className="button small secondary"
                        onClick={() => setEditingSummary(false)}
                      >
                        {t("summary.finishEditing")}
                      </button>
                      <span role="status">
                        {t(
                          summarySyncStatus === "invalid"
                            ? "summary.draftInvalid"
                            : summarySyncStatus === "saving"
                              ? "state.saving"
                              : summarySyncStatus === "error"
                                ? "state.saveError"
                                : "state.saved",
                        )}
                      </span>
                    </div>
                  )}
                  {result.saved && (
                    <div className="feedback-controls">
                      <button
                        className="text-button"
                        aria-expanded={feedbackOpen}
                        aria-controls="summary-feedback"
                        onClick={() => setFeedbackOpen((open) => !open)}
                      >
                        {feedbackOpen ? t("feedback.hide") : t("feedback.open")}
                      </button>
                      {feedbackMessage && (
                        <p className="muted" role="status">
                          {t(feedbackMessage)}
                        </p>
                      )}
                      {feedbackOpen && (
                        <div id="summary-feedback">
                          {feedbackError !== null && (
                            <ErrorAlert
                              error={feedbackError}
                              onDismiss={() => setFeedbackError(null)}
                            />
                          )}
                          <FeedbackForm
                            rating={feedbackRating}
                            onRatingChange={setFeedbackRating}
                            comment={feedbackComment}
                            onCommentChange={setFeedbackComment}
                            accepted={feedbackAccepted}
                            onAcceptedChange={setFeedbackAccepted}
                            saving={feedbackSaving}
                            onSubmit={() => void submitFeedback()}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
              {historyLoading && (
                <p role="status" className="muted">
                  {t("summary.historyLoading")}
                </p>
              )}
              {note && (
                <button
                  className="text-button history-toggle"
                  disabled={historyLoading || summarySaving}
                  aria-expanded={historyOpen}
                  aria-controls="summary-history"
                  onClick={() => void showHistory()}
                >
                  {historyOpen
                    ? t("summary.hideHistory")
                    : t("summary.history", { count: savedSummaries.length })}
                </button>
              )}
              {historyOpen && (
                <div id="summary-history" className="history-list">
                  {savedSummaries.length
                    ? savedSummaries.map((summary) => (
                        <button
                          key={summary.id}
                          disabled={summarySaving}
                          onClick={() => void chooseSummary(summary)}
                        >
                          <strong>
                            {summary.shortText.slice(0, 78)}
                            {summary.shortText.length > 78 ? "…" : ""}
                          </strong>
                          <span>
                            {t("notes.revision")}{" "}
                            {formatNumber(summary.sourceRevision)} ·{" "}
                            {formatDate(summary.createdAt, {
                              dateStyle: "short",
                              timeStyle: "short",
                            })}
                          </span>
                        </button>
                      ))
                    : !historyLoading && <p>{t("summary.emptyHistory")}</p>}
                </div>
              )}
            </section>
          )}
        </div>
        {shareOpen && note && (
          <SharingDialog
            key={note.id}
            noteId={note.id}
            onClose={() => setShareOpen(false)}
          />
        )}
        {confirmation}
      </main>
    </AppShell>
  );
}

export function ProfilePage() {
  const { t, language, setLanguage } = useI18n();
  const { user } = useAuth();
  const [name, setName] = useState(user?.displayName ?? "");
  const [message, setMessage] = useState<"profile.saved" | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (user)
      void getDoc(doc(db, "users", user.uid))
        .then((snapshot) => {
          if (snapshot.exists())
            setName(snapshot.data().displayName ?? user.displayName ?? "");
        })
        .catch(setError);
  }, [user]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!user) return;
    setError(null);
    setMessage(null);
    try {
      await saveUserProfile(user.uid, {
        displayName: name.trim(),
        preferredLanguage: language,
      });
      setMessage("profile.saved");
    } catch (reason) {
      setError(reason);
    }
  }
  return (
    <AppShell>
      <main className="content-area narrow-content">
        <div className="eyebrow">{t("profile.eyebrow")}</div>
        <h1>{t("nav.profile")}</h1>
        <p className="muted">{t("profile.description")}</p>
        <form className="profile-form" onSubmit={save}>
          <label>
            {t("common.name")}
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
            />
          </label>
          <label>
            {t("common.email")}
            <input value={user?.email ?? ""} readOnly />
          </label>
          <label>
            {t("profile.language")}
            <select
              value={language}
              onChange={(event) =>
                setLanguage(
                  isLanguage(event.target.value) ? event.target.value : "uk",
                )
              }
            >
              <option value="uk">{t("language.uk")}</option>
              <option value="en">{t("language.en")}</option>
            </select>
          </label>
          <button className="button primary">{t("profile.save")}</button>
          {message && (
            <p role="status" className="muted">
              {t(message)}
            </p>
          )}
          {error !== null && (
            <ErrorAlert error={error} onDismiss={() => setError(null)} />
          )}
        </form>
      </main>
    </AppShell>
  );
}

function NotFound() {
  const { t } = useI18n();
  return (
    <main className="page-center">
      <div>
        <span className="brand-mark">N</span>
        <h1>{t("notFound.title")}</h1>
        <Link className="button primary" to="/notes">
          {t("notFound.back")}
        </Link>
      </div>
    </main>
  );
}

function AppRoutes() {
  const location = useLocation();
  return (
    <Routes location={location}>
      <Route path="/" element={<HomeRedirect />} />
      <Route
        path="/login"
        element={
          <GuestOnly>
            <AuthPage mode="login" />
          </GuestOnly>
        }
      />
      <Route
        path="/register"
        element={
          <GuestOnly>
            <AuthPage mode="register" />
          </GuestOnly>
        }
      />
      <Route
        path="/forgot-password"
        element={
          <GuestOnly>
            <AuthPage mode="forgot" />
          </GuestOnly>
        }
      />
      <Route element={<RequireAuth />}>
        <Route path="/notes" element={<NotesPage />} />
        <Route path="/notes/new" element={<NoteEditorRoute />} />
        <Route path="/notes/:noteId" element={<NoteEditorRoute />} />
        <Route path="/shared" element={<NotesPage shared />} />
        <Route path="/archive" element={<NotesPage status="archived" />} />
        <Route path="/profile" element={<ProfilePage />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <I18nProvider>
        <AuthProvider>
          <UserLanguageSync />
          <AppRoutes />
        </AuthProvider>
      </I18nProvider>
    </BrowserRouter>
  );
}
