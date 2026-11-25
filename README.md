# Notach

Notach is a notes app with shared editing and AI summaries. Write a note, share
it with someone, or turn a long text into a short summary and a list of key
points. The original stays separate from the summary, so you can edit either
without losing the other.

The app was built as a course project. It uses React and TypeScript in the
browser, Firebase for accounts and storage, and an Express server for Gemini
requests and operations that need server-side access checks.

You can:

- Organize notes with tags, favorites, and an archive. Search the loaded notes
  by title or content, with title matches shown first.
- Share a note with another registered user as a viewer or editor. Editors can
  work on the same text at the same time.
- Choose a Gemini model, summary length, and output language. Optionally ask for
  tags and a title, then apply the suggestions you want.
- Reopen previous summaries, edit them together, and leave a rating and comment.
- Switch the interface between Ukrainian and English.

Notes and summary edits save automatically. Each successful generation adds a
history entry; editing that result updates the entry and retains its original AI
output. Changing the note text marks older summaries as outdated.

## Run locally

You need Node.js 22 or newer, npm 10 or newer, and Java 21 or newer for the
Firestore emulator. The Firebase CLI is included in the project dependencies.

The commands below use PowerShell. Run them from the repository root.

### Install and configure

```powershell
npm.cmd ci

if (!(Test-Path .firebaserc)) {
  Copy-Item .firebaserc.example .firebaserc
}
New-Item -ItemType Directory -Force backend | Out-Null
if (!(Test-Path backend/.env)) {
  Copy-Item apps/api/.env.example backend/.env
}
if (!(Test-Path apps/web/.env.local)) {
  Copy-Item apps/web/.env.example apps/web/.env.local
}
```

For a local setup, keep these values in `backend/.env`:

```dotenv
FIREBASE_PROJECT_ID=demo-notach
USE_FIREBASE_EMULATORS=true
AI_PROVIDER=mock
```

Use these emulator-only values in `apps/web/.env.local`:

```dotenv
VITE_FIREBASE_API_KEY=local-development
VITE_FIREBASE_AUTH_DOMAIN=localhost
VITE_FIREBASE_PROJECT_ID=demo-notach
VITE_FIREBASE_APP_ID=local-development
VITE_FIREBASE_MESSAGING_SENDER_ID=local-development
VITE_USE_FIREBASE_EMULATORS=true
VITE_API_BASE_URL=
```

`demo-notach` is a local demo project ID. It must match in both environment
files and the `projects.default` value in `.firebaserc`. The other Firebase
values above are placeholders for local emulators. This setup needs neither an
Admin credential nor a Gemini key. The mock provider builds predictable results
from the note's sentences; use it to try the app without calling an external
model.

### Start the services

Keep each command running in its own terminal, from the repository root.

```powershell
# Terminal 1: local Authentication and Firestore
npm.cmd run emulators
```

```powershell
# Terminal 2: Express API
npm.cmd run dev:api
```

```powershell
# Terminal 3: React app
npm.cmd run dev:web
```

Open <http://localhost:5173>, register an account, and create a note. To try
sharing, register a second account in another browser session and give it access
from the first account.

Local accounts and notes belong to the emulators. The start command does not
export data on shutdown, so use cloud Firebase or configure emulator
import/export if you need data to survive a restart. Password-reset links are
printed in the Auth emulator terminal instead of being emailed.

Hosts and ports live in
[`packages/shared/src/local-services.json`](packages/shared/src/local-services.json).
Run `npm.cmd run config:show` to see the resolved addresses. Leave
`VITE_API_BASE_URL` empty for the default local setup.

## Use cloud Firebase

Create a Firebase project, enable Email/Password sign-in, create a Firestore
database, and register a web app in Project settings. Copy that app's Firebase
configuration into the matching `VITE_FIREBASE_*` values in
`apps/web/.env.local`, then set:

```dotenv
VITE_USE_FIREBASE_EMULATORS=false
```

Put your Firebase Admin service-account JSON in `backend/secrets/`. Update
`backend/.env` with your project ID and the path to that file:

```dotenv
FIREBASE_PROJECT_ID=your-project-id
USE_FIREBASE_EMULATORS=false
GOOGLE_APPLICATION_CREDENTIALS=../../backend/secrets/service-account.json
```

The relative credential path is resolved from `apps/api` when you use
`npm.cmd run dev:api`. Keep the Admin credential on the server; only the public
Firebase Web SDK configuration belongs in the frontend.

Keep your own project ID in the local environment files and, if you use a
Firebase CLI default project, `.firebaserc`. These files are ignored by Git; the
committed templates contain demo values only.

Deploy the included Firestore Rules and indexes to your project. Replace
`YOUR_FIREBASE_PROJECT_ID` before running:

```powershell
npx.cmd firebase login
npx.cmd firebase deploy --only firestore --project YOUR_FIREBASE_PROJECT_ID
```

Wait for the indexes to finish building. Sign out of the local app, stop the
emulators, and restart the API and frontend. Both emulator flags must be
`false`. Register or sign in to a cloud account: emulator accounts and notes do
not transfer automatically.

The frontend and API can still run locally while Authentication and Firestore
use the cloud project.

## Enable Gemini

Set these values in `backend/.env`, then restart the API:

```dotenv
AI_PROVIDER=gemini
GEMINI_API_KEY=your-key
GEMINI_MODEL=gemini-3.5-flash-lite
AI_HOURLY_BUDGET_USD=0.10
```

The model picker uses the server's [model list](apps/api/src/config/models.ts).
Gemini works with either emulated or cloud Firebase. When you request a summary,
the server reads the saved note and sends its text to Google's Gemini API. Long
notes are processed in parts, then the intermediate summaries are combined.

The hourly budget is a per-user estimate based on token usage and model prices.
It reserves funds before each provider call and records usage in Firestore. The
summary panel shows spending, reservations, and time until reset. This is an
application limit; it does not set a spending cap on your Google account.

Two commands help check the integration:

```powershell
# Read model metadata without generating text
npm.cmd run check:ai

# Generate a summary from a short synthetic note
npm.cmd run verify:ai
```

`verify:ai` uses real Gemini quota, may incur charges, and bypasses the app's
per-user budget. A successful metadata check does not guarantee that generation
is available. If Gemini returns `AI_UNAVAILABLE` with an upstream 503, try again
later or choose another configured model. The app does not silently switch to
mock results, and failed generation leaves the original note intact.

## How the pieces fit together

The browser uses Firebase Authentication for sign-in and the Firestore SDK for
note reads, autosave, and live subscriptions. Yjs merges concurrent text edits.
Firestore Rules check ownership, sharing permissions, and document structure.

Requests for generation, summary edits, ratings, sharing changes, and note
deletion go through Express with a Firebase ID token. The server checks the
token and access rights itself because Firebase Admin bypasses Firestore Rules.
Generation also checks the source revision, input size, and available budget.
Gemini responses are validated before being saved.

```text
apps/web/          React UI, Firebase client, live editing
apps/api/          Express API, Firebase Admin, Gemini and mock adapters
packages/shared/   Types, Zod schemas, text and collaboration helpers
backend/           Local server environment and private credentials
firestore.rules    Client access and validation rules
firebase.json      Hosting and emulator configuration
```

Environment templates are in [`apps/api/.env.example`](apps/api/.env.example)
and [`apps/web/.env.example`](apps/web/.env.example). The API loads
`backend/.env` first, then `apps/api/.env` without replacing values already set.
Existing process environment variables take precedence over both files.

## Checks and builds

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
npm.cmd test
npm.cmd run test:rules
npm.cmd run build
```

The tests cover shared validation, UI behavior, API access checks,
collaboration, and budget accounting. `test:rules` starts a temporary Firestore
emulator for the Rules and transaction tests. Automated tests do not call real
Gemini or production Firebase. Use `npm.cmd run format` to apply Prettier
formatting.

`build` compiles the shared package and API, then writes the frontend to
`apps/web/dist`. It does not deploy anything.

## Hosting

Firebase Hosting is configured for the frontend. The Express API needs its own
Node.js host with HTTPS. Before building for deployment, set `VITE_API_BASE_URL`
to that API's public HTTPS address, turn off both emulator flags, and set the
server's `CORS_ORIGIN` to the frontend's origin. Add the web domain to Firebase
Authentication's authorized domains.

Keep Gemini keys and Admin credentials in the backend environment. Vite embeds
`VITE_*` values in the browser bundle, so those variables must never contain
server secrets. Private environment files and credentials are excluded by
`.gitignore`.
