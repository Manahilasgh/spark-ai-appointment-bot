# Spark — AI Appointment Booking Bot

An AI-assisted appointment booking system for a clinic ("Bright Smile Dental"). Customers chat with an
assistant to **book, reschedule or cancel** appointments — or use a plain form — while staff get a front-desk view of every booking and admins manage roles.

The AI is deliberately **advisory only**: the model turns conversation into structured fields, but the business rules (hours, slot length, availability) and the database decide what actually happens.
Nothing is written to the database until the user clicks a confirm button.

```
Customer (chat / form) ──► Express API ──► PostgreSQL
                             │                ▲
                             └──► LLM ────────┘  (extract intent + details; never writes)
```

---

## Table of contents

- [Features](#features)
- [Tech stack](#tech-stack)
- [High-level architecture](#high-level-architecture)
- [Repository layout](#repository-layout)
- [Data model](#data-model)
- [Running the project locally](#running-the-project-locally)
- [Environment variables](#environment-variables)
- [Scripts](#scripts)
- [API reference](#api-reference)
- [Booking rules](#booking-rules)
- [How the AI chat works](#how-the-ai-chat-works)
- [Key design decisions and tradeoffs](#key-design-decisions-and-tradeoffs)
- [Frontend guide](#frontend-guide)
- [Roles and permissions](#roles-and-permissions)
- [Security notes](#security-notes)
- [Deployment](#deployment)
- [Assumptions and known limitations](#assumptions-and-known-limitations)
- [Troubleshooting](#troubleshooting)
- [Verification checklist](#verification-checklist)
- [Roadmap](#roadmap)
- [Project status](#project-status)

---

## Features

**Customers**

- Email + password signup (with a **phone number** used so the clinic can reach them) and login.
- Conversational assistant that understands relative dates ("tomorrow", "next Monday afternoon"),
  asks for one missing detail at a time, and answers with a **streamed, word-by-word reply**.
- Draft state survives a page reload — the chat is persisted per conversation, not per browser render.
- Explicit confirmation button before anything is booked, moved or cancelled.
- Booking form fallback (pre-filled from the chat draft) if the assistant is down or the conversation
  is not converging.
- "Your appointments" list with reschedule and cancel actions for upcoming bookings.

**Staff / admin**

- "All appointments" table (upcoming / past / all, optional status filter) across the whole business,
  showing each customer's **name, email and phone** — the phone renders as a tap-to-call `tel:` link.
- Cancel any booking in the business.
- Admins additionally get a "Users and roles" table to promote/demote staff and admins.

**AI safety rails**

- The model only returns `{ reply, intent, appointmentRef, extracted }` JSON — validated with zod.
- Extracted values are coerced against the real service list and time/date formats; anything invalid
  is dropped rather than trusted.
- Appointments are only ever created or changed in `confirmBooking`, after an explicit user action.
- Every LLM call is logged to `ai_logs` (latency, success, raw payloads) for debugging and analytics.

---

## Tech stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Frontend | Next.js 15 (App Router), React 19, TypeScript | Client components, hand-written CSS (green theme), no UI framework |
| Backend | Node.js 18+, Express 4, TypeScript | `tsx` in dev, compiles to `dist` for production |
| Database | PostgreSQL 13+ (`citext`, `btree_gist`) | Double-booking is blocked by an exclusion constraint |
| Validation | zod | Every body / query / param is parsed before it reaches a service |
| Auth | `jsonwebtoken` + `bcryptjs` | 7-day tokens; role re-read from the DB on every request |
| AI | Any OpenAI-compatible chat-completions endpoint | Gemini, Mistral, Groq, … configured via env |
| Streaming | Server-sent events | LLM → API → browser |
| Logging | pino / pino-http | Pretty in dev, JSON in production, `Authorization` header redacted |
| Hardening | helmet, cors, express-rate-limit | Three rate-limit tiers (per IP and per user) |

---

## High-level architecture

Two deployables and two external services. The API is **stateless** (the JWT plus the database hold all
state), so it can be scaled horizontally or deployed as a serverless handler.

```
┌──────────────────────────────────────────────────────────────┐
│  Browser — Next.js 15 App Router (client components)         │
│  pages ─► components ─► src/lib/api.ts (typed fetch + SSE)   │
└───────────────────────────┬──────────────────────────────────┘
                            │  JSON over HTTP · Authorization: Bearer <JWT>
                            │  text/event-stream for streamed replies
┌───────────────────────────▼──────────────────────────────────┐
│  Express API (stateless, TypeScript)                         │
│                                                              │
│  app.ts      helmet · cors(allow-list) · express.json(10kb)  │
│              pino-http access log                            │
│  /health     DB ping  → 200 ok | 503 db_unavailable          │
│  /api/*      generalLimiter (120/min per IP)                 │
│              ├─ /auth         authLimiter · validate · service│
│              ├─ /appointments requireAuth · validate · service│
│              ├─ /chat         chatLimiter (per user) · service│
│              ├─ /staff        requireRole('staff','admin')    │
│              └─ /admin        requireRole('admin')            │
│  errorHandler → one JSON error shape for every failure        │
└─────────┬───────────────────────────────────┬────────────────┘
          │ pg Pool (max 10)                  │ chat completions (OpenAI-compatible)
┌─────────▼───────────────────┐   ┌───────────▼────────────────┐
│  PostgreSQL 13+             │   │  LLM provider              │
│  citext · btree_gist        │   │  Gemini / Mistral / Groq … │
│  6 tables, all tenant-scoped│   │  extract-only, never writes│
└─────────────────────────────┘   └────────────────────────────┘
```

### Backend layering

Each layer has one job, and requests flow strictly downward — routes never talk to the database directly
and services never touch `req`/`res`.

```
HTTP request
 └─ infrastructure   helmet, cors, express.json, pino-http        (app.ts)
     └─ /health      pool.query('SELECT 1')
     └─ /api/*       generalLimiter → route-level limiter
         └─ route    parse, call one service, pick the status code   (routes/*)
             └─ guard     requireAuth (JWT)  →  requireRole (role re-read from DB)
                 └─ validator  validate({ body, query, params }) with zod
                     └─ service   business rules + SQL through one pool   (services/*)
                         └─ database   constraints are the last line of defence
                     └─ errorHandler → { error: { code, message, details? } }
```

- `routes/*` are thin: validate → call a service → choose 200/201.
- `services/*` own the logic and ALL SQL (`appointmentService`, `chatService`, `staffService`, `authService`).
- `bookingRules.ts` owns availability maths (services, hours, timezone → UTC) and is used by both the form
  endpoint and the chat, so the two paths can never disagree.
- `aiService.ts` is the only module that talks to the LLM, and it never touches appointments.
- `schemas/*` is the contract: one zod schema per endpoint, typed with `z.infer` and shared with TypeScript.

### Two request paths, one set of rules

```
POST /api/appointments                     POST /api/chat/messages(/stream)
 (form)                                     (assistant)
   │                                          │
   ▼                                          ▼
 bookingRules.buildSlot            aiService.extractBooking → LLM (extract only)
   │                                          │  normalizeExtracted + applyIntent + business checks
   ▼                                          ▼
 appointmentService                chat_sessions.draft_booking (persisted state)
   │                                          │  user clicks Confirm
   │                                          ▼
   │                                POST /api/chat/sessions/:id/confirm
   ▼                                          ▼
   └──────────────► appointmentService.createAppointment ◄──────────────┘
                          │  INSERT … (exclusion constraint rejects overlaps)
                          ▼
                    appointments  ──►  GET /api/appointments        (the customer)
                                      GET /api/staff/appointments    (staff/admin + customer phone)
```

### Chat streaming sequence

```
Browser                    API                        PostgreSQL          LLM
  │ POST /chat/messages/stream │                            │               │
  ├───────────────────────────►│  load session + draft + last 12 messages
  │                            ├───────────────────────────►│               │
  │                            │◄───────────────────────────┤  + next 10 upcoming appts
  │                            ├── stream chat completions ─────────────────►│
  │◄── data: {delta, text} ────┤◄── tokens (ReplyExtractor pulls "reply" text) │
  │◄── data: {final, …} ───────┤  validate JSON, business checks, persist     │
  │  user clicks "Confirm booking"                            │               │
  ├───────────────────────────►│  INSERT INTO appointments ─►│               │
  │◄── 201 { appointment } ────┤◄───────────────────────────┤               │
```

### Trust boundaries (defence in depth)

| Boundary | What is untrusted | How it is handled |
| --- | --- | --- |
| Browser → API | All request input | zod schema per endpoint; JSON body capped at 10 kB; rate limits; JWT signature check |
| LLM → API | The model's JSON (it can hallucinate or return prose) | Parsed and zod-validated; values coerced against the real service list / date / `HH:mm` formats, or dropped; anything missing is re-asked |
| API → database | Racing requests, bad clocks, bad ranges | FK + CHECK constraints, `chk_time_order`, and the `EXCLUDE USING gist` overlap guard (→ 409) |
| Token → role | A stale or forged role claim | `requireRole` re-reads the role from the database on every request |

### Multi-tenancy

`business_id` is on every tenant-owned table (`users`, `chat_sessions`, `appointments`, `ai_logs`) and every
query filters by the caller's business scope. New signups are attached to `DEFAULT_BUSINESS_ID`. Row-Level
Security is **not** enabled, so tenant isolation currently depends on query discipline — see
[Assumptions and known limitations](#assumptions-and-known-limitations).

---

## Repository layout

```
spark-assessment/
├── backend/                     Express + TypeScript API
│   ├── src/
│   │   ├── app.ts               App wiring, helmet/CORS/JSON, /health, route mounting
│   │   ├── server.ts            HTTP listener + graceful shutdown (SIGTERM/SIGINT)
│   │   ├── config/env.ts        zod-validated environment (fails fast on bad config)
│   │   ├── db/pool.ts           pg connection pool (max 10)
│   │   ├── middleware/
│   │   │   ├── auth.ts          requireAuth (JWT) + requireRole (role read from DB)
│   │   │   ├── validate.ts      Parses body / query / params with zod
│   │   │   ├── rateLimit.ts     general / auth / chat limiters
│   │   │   ├── requestLogger.ts pino-http access logs
│   │   │   └── errorHandler.ts  notFound + the single JSON error shape
│   │   ├── routes/              auth, appointments, chat, staff, admin
│   │   ├── schemas/             zod schemas (auth, appointment, chat, staff, common) + barrel index
│   │   ├── services/
│   │   │   ├── authService.ts         signup / login / get user
│   │   │   ├── appointmentService.ts  create, list, cancel, reschedule, slot checks
│   │   │   ├── bookingRules.ts        services, hours, timezone → UTC slot maths
│   │   │   ├── businessService.ts     tenant lookup (name + timezone)
│   │   │   ├── chatService.ts         conversation state machine + confirmation
│   │   │   ├── aiService.ts           LLM call, JSON parsing, streaming, ai_logs
│   │   │   ├── replyExtractor.ts      pulls "reply" text out of a partially-streamed JSON object
│   │   │   └── staffService.ts        business-wide appointment list, users + roles
│   │   ├── types/express.d.ts   Adds req.user to Express's Request
│   │   └── utils/               AppError, asyncHandler, logger
│   ├── .env.example
│   └── tsconfig.json
├── frontend/                    Next.js app
│   ├── src/
│   │   ├── app/
│   │   │   ├── layout.tsx          AuthProvider + global CSS
│   │   │   ├── page.tsx            "/" → redirects to /dashboard or /login
│   │   │   ├── login/page.tsx      <AuthForm mode="login" />
│   │   │   ├── signup/page.tsx     <AuthForm mode="signup" />
│   │   │   ├── dashboard/page.tsx  Tabs: my bookings / all appointments / users & roles
│   │   │   └── globals.css         Design tokens, layout, cards, tables, badges
│   │   ├── components/          AuthForm, ChatWidget, AppointmentForm, AppointmentList,
│   │   │                        StaffAppointments, UserManagement
│   │   └── lib/                 api.ts (typed fetch + SSE stream), auth.tsx (context),
│   │                            types.ts, slots.ts (time helpers), typewriter.ts
│   ├── .env.example
│   └── next.config.mjs
├── db/schema.sql                Schema, indexes, triggers + sample data
└── .gitignore
```

---

## Data model

`db/schema.sql` is a single file applied by hand (no migration tool yet). Every tenant-owned table
carries `business_id`.

| Table | Purpose | Notable constraints |
| --- | --- | --- |
| `businesses` | The tenant; holds the `timezone` used to interpret every booking | — |
| `users` | Auth + profile: `email`, `password_hash` (bcrypt), `full_name`, `phone`, `role` | `email` is CITEXT and globally unique; `role IN ('customer','staff','admin')`; `phone` is nullable TEXT |
| `chat_sessions` | One conversation; `draft_booking` JSONB is the assistant's memory | `status IN ('active','completed','abandoned')` |
| `chat_messages` | Append-only history, one row per message | indexed `(session_id, created_at)` |
| `appointments` | The bookings | `EXCLUDE USING gist (business_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE status <> 'cancelled'` blocks double-booking; `chk_time_order` requires `ends_at > starts_at` |
| `ai_logs` | Every LLM call: model, request, response, latency, success, error | partial index on failures for quick triage |

Triggers keep `updated_at` current on `users` and `chat_sessions` and `appointments`.

Sample data seeds one business (Bright Smile Dental, `Asia/Karachi`), two users and a finished chat.
The seeded password hashes are **placeholders**, so log in by creating a real account through the
signup form, then promote that account to staff/admin (see [Roles and permissions](#roles-and-permissions)).

---

## Running the project locally

Three things run side by side: PostgreSQL, the API on `:4000`, and the web app on `:3000`.

### Quickstart

```bash
# 1) database (once) — creates the tables, indexes, triggers and sample rows
psql "$DATABASE_URL" -f db/schema.sql

# 2) API — terminal 1
cd backend
npm install
cp .env.example .env          # then fill in DATABASE_URL, JWT_SECRET and the AI_* values
npm run dev                   # → http://localhost:4000

# 3) web app — terminal 2
cd frontend
npm install
echo "NEXT_PUBLIC_API_URL=http://localhost:4000" > .env.local
npm run dev                   # → http://localhost:3000
```

Windows PowerShell equivalents for steps 2–3:

```powershell
cd backend;  npm install; Copy-Item .env.example .env; npm run dev      # terminal 1
cd frontend; npm install; Set-Content .env.local 'NEXT_PUBLIC_API_URL=http://localhost:4000' -Encoding utf8; npm run dev   # terminal 2
```

### Prerequisites

- **Node.js 18+** (`node --version`; the API declares `engines.node >= 18`, Next.js 15 needs 18.18+)
- **PostgreSQL 13+** — local install or a hosted provider (the schema assumes the `citext` and
  `btree_gist` extensions can be created, which is true on Neon / Supabase / RDS / local PG 13+)
- An **API key for an OpenAI-compatible LLM** (e.g. Google AI Studio / Gemini, Mistral, Groq)

### 1. Create the database

```bash
psql "postgresql://user:password@host:5432/dbname" -f db/schema.sql
```

The script is idempotent-ish for a fresh database: it creates the extensions, all tables, indexes,
triggers and the sample rows. Re-running it on an existing database will fail on the `CREATE TABLE`
statements, which is expected — delete/recreate the schema if you want a clean slate.

### 2. Backend

```bash
cd backend
npm install
# create .env (see Environment variables) — the API refuses to start if anything required is missing
npm run dev          # tsx watch src/server.ts  → http://localhost:4000
```

Check it is alive and can reach the database:

```bash
curl http://localhost:4000/health      # {"status":"ok"}   (503 {"status":"db_unavailable"} if PG is down)
```

> **Heads-up on `AI_MODEL`:** `backend/.env.example` matches the variable names below, but it ships
> `AI_MODEL=your-model` as a placeholder. Replace it with a real model id from your provider — the code
> default (`gemini-3.8-flash`, used only when the variable is absent) is a placeholder too.

### 3. Frontend

```bash
cd frontend
npm install
# create .env.local with NEXT_PUBLIC_API_URL=http://localhost:4000
npm run dev          # http://localhost:3000
```

Open <http://localhost:3000>, click **Create an account**, and sign up (name, email, phone, password).
`DEFAULT_BUSINESS_ID` decides which tenant new signups join, so keep it pointing at a row that exists
in `businesses` (the schema seeds `11111111-1111-1111-1111-111111111111`).

### 4. Try it

1. On the dashboard, ask the assistant: `book a teeth cleaning tomorrow at 3pm`.
2. It replies with a summary and a **Confirm booking** button — click it.
3. Switch to **All appointments** (staff/admin) to see the customer's name, email and phone.

### Ports and processes

| Process | Default port | Started by | How to check it |
| --- | --- | --- | --- |
| PostgreSQL | 5432 (or your provider's) | local service / hosted provider | `psql "$DATABASE_URL" -c 'select 1'` |
| API | `4000` (`PORT`) | `npm run dev` in `backend/` | `curl http://localhost:4000/health` → `{"status":"ok"}` |
| Web app | `3000` | `npm run dev` in `frontend/` | open <http://localhost:3000> |

Two terminals are required because both dev servers are long-running. If Next.js reports that port 3000 is
in use and silently starts on 3001, the app will still call `NEXT_PUBLIC_API_URL` and the API's `CORS_ORIGIN`
will reject it — stop the stray process instead of letting it switch ports:

```powershell
# Windows: free a port (example: 3000)
Get-NetTCPConnection -LocalPort 3000 -State Listen |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

```bash
# macOS/Linux
lsof -ti:3000 | xargs kill
```

### Everyday commands

| Task | Command |
| --- | --- |
| Type-check the API without running it | `cd backend` then `npm run typecheck` |
| Rebuild after changing `.env` | Ctrl+C, then `npm run dev` again — env is read at boot |
| Reset the dev cache (fixes most "page 500 / unstyled" issues) | stop dev, `Remove-Item frontend\.next -Recurse -Force`, `npm run dev` |
| Apply a schema change to a fresh database | `psql "$DATABASE_URL" -f db/schema.sql` |
| Promote your account to staff/admin | `UPDATE users SET role = 'admin' WHERE email = 'you@example.com';` |
| Give yourself a test booking | `POST /api/appointments` (see the API examples above) |

---

## Environment variables

### `backend/.env`

Validated by `src/config/env.ts` with zod — the process **exits with a list of problems** if anything
is missing or malformed, so misconfiguration surfaces at boot instead of at request time.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | — | Postgres connection string, e.g. `postgresql://user:pass@host/db?sslmode=require` |
| `JWT_SECRET` | yes | — | At least 16 characters. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `AI_API_KEY` | yes | — | Key for the OpenAI-compatible provider |
| `AI_BASE_URL` | no | `https://generativelanguage.googleapis.com/v1beta/openai` | `/chat/completions` is appended automatically |
| `AI_MODEL` | no | `gemini-3.8-flash` | Any model the provider exposes |
| `PORT` | no | `4000` | API port |
| `CORS_ORIGIN` | no | `http://localhost:3000` | Comma-separated allow-list of frontend origins |
| `DEFAULT_BUSINESS_ID` | no | `11111111-1111-1111-1111-111111111111` | Tenant that new signups are attached to; must exist in `businesses` |
| `NODE_ENV` | no | `development` | `production` switches logs to JSON and drops pino-pretty |

### `frontend/.env.local`

| Variable | Required | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | yes | Base URL of the API with **no** trailing slash, e.g. `http://localhost:4000` |

`.env` and `.env.local` are gitignored — never commit real keys.

---

## Scripts

| Where | Command | What it does |
| --- | --- | --- |
| `backend/` | `npm run dev` | `tsx watch src/server.ts` — hot-reloading API on `PORT` |
| `backend/` | `npm run build` | `tsc` → `dist/` (CommonJS, ES2022) |
| `backend/` | `npm start` | `node dist/server.js` — run the compiled build |
| `backend/` | `npm run typecheck` | `tsc --noEmit` — the quickest way to check the API still compiles |
| `frontend/` | `npm run dev` | `next dev` on <http://localhost:3000> |
| `frontend/` | `npm run build` | Production build (also type-checks the whole app) |
| `frontend/` | `npm start` | Serve the production build (`npm run build` first) |

> There is **no test runner configured** in either package today — verification is done with
> `npm run typecheck` (backend), `npm run build` (frontend) and manual API/UI checks.
> If you add tests, Vitest + supertest is the natural fit for the API and Jest/Vitest + React Testing
> Library for the UI.

---

## API reference

Base URL: `http://localhost:4000`. All request/response bodies are JSON. Protected routes expect
`Authorization: Bearer <jwt>`.

**Error shape** (every failure, from any layer):

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Request validation failed",
             "details": [{ "path": "phone", "message": "Enter a valid phone number" }] } }
```

| Code | HTTP | Meaning |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | zod rejected the body/query/params; `details[]` maps to form fields |
| `INVALID_JSON` | 400 | Body was not valid JSON |
| `UNAUTHORIZED` | 401 | Missing/invalid/expired token, or bad credentials on login |
| `INVALID_CREDENTIALS` | 401 | Wrong email or password (same message either way) |
| `FORBIDDEN` | 403 | Authenticated but the role is not allowed |
| `NOT_FOUND` | 404 | Appointment / session / user / business / route does not exist |
| `EMAIL_TAKEN` | 409 | Signup with an email that is already registered |
| `SLOT_TAKEN` | 409 | Overlapping booking — the DB exclusion constraint rejected it |
| `NOT_RESCHEDULABLE` | 409 | Appointment is cancelled, completed or already in the past |
| `SESSION_CLOSED` | 409 | Conversation is finished; start a new one |
| `INVALID_SLOT` | 422 | Date/time in the past, outside opening hours, or nonexistent; `details.field` says which input to fix |
| `INCOMPLETE_BOOKING` | 422 | Confirming a draft that is still missing details; `details.missing[]` lists them |
| `RATE_LIMITED` | 429 | Too many requests (see limits below) |
| `INTERNAL_ERROR` | 500 | Unexpected failure — details are logged, not returned |

**Rate limits** (`express-rate-limit`, standard `RateLimit-*` headers)

| Scope | Limit | Keyed by |
| --- | --- | --- |
| Everything under `/api` | 120 / minute | IP |
| `/api/auth/signup`, `/api/auth/login` | 20 / 15 minutes | IP |
| `/api/chat/*` | 20 / minute | user id |

### Health

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/health` | — | `{"status":"ok"}` or `503 {"status":"db_unavailable"}` |

### Auth — `/api/auth`

| Method | Path | Auth | Body | Returns |
| --- | --- | --- | --- | --- |
| `POST` | `/signup` | — | `fullName` (1–100), `email` (max 254, lowercased), `password` (8–72), `phone` (optional, ≤30 chars) | `201 { user, token }` |
| `POST` | `/login` | — | `email`, `password` | `{ user, token }` |
| `GET` | `/me` | bearer | — | `{ user }` |

`user` is `{ id, email, fullName, phone, role, businessId }`.

**Phone rules** (`signupSchema`): trimmed; may start with `+`; digits, spaces, `(` `)` `-` and `.` only;
at least **7 digits**; at most 30 characters. An omitted *or empty* value is stored as `NULL` instead of
an empty string. The signup form requires it (the API treats it as optional so older clients keep working).

### Appointments — `/api/appointments` (all require auth)

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| `GET` | `/options` | — | `{ services, hours: { open, close, slotMinutes }, timezone }` — the single source of truth shared by form and chat |
| `GET` | `/` | `?status=pending\|confirmed\|cancelled\|completed` | `{ appointments }` — the caller's own, newest first, max 50 |
| `POST` | `/` | `service` (must be in `SERVICES`), `date` (`YYYY-MM-DD`), `time` (`HH:mm`), `notes` (≤500, optional), `sessionId` (optional uuid) | `201 { appointment }` |
| `PATCH` | `/:id` | `date`, `time` — reschedules, keeping the original duration | `{ appointment }` |
| `PATCH` | `/:id/cancel` | — | `{ appointment }` |

An `appointment` is `{ id, service, startsAt, endsAt, status, notes, createdVia }` (`createdVia` is
`chat` or `form`).

### Chat — `/api/chat` (auth + chat rate limit)

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `POST` | `/messages` | `{ sessionId?, message }` — omit `sessionId` to start a new conversation | full reply, JSON |
| `POST` | `/messages/stream` | same | **SSE** stream: `delta` events with text, then one `final` event, or `error` |
| `GET` | `/sessions/:id` | — | `{ session, messages }` — history + current draft (used to resume after a reload) |
| `POST` | `/sessions/:id/confirm` | — | `201 { action, appointment }` for a booking, `200` for reschedule/cancel |

The reply payload is
`{ sessionId, reply, draft, action, missing[], readyToConfirm, summary, needsForm }`:

- `action` — `book` | `reschedule` | `cancel`
- `missing[]` — details still needed; when it is empty and `readyToConfirm` is true, show the confirm button
- `summary` — human-readable description of what will happen (e.g. `Teeth cleaning on Mon, Oct 5 at 3:00 PM`)
- `needsForm` — true when the assistant gave up (LLM failure or >4 user turns without converging) and the
  UI should offer the booking form instead

Streaming event format (`\n\n`-separated blocks):

```
data: {"type":"delta","text":"Sure, "}
data: {"type":"delta","text":"what time"}
data: {"type":"final","sessionId":"…","reply":"…","draft":{…},"action":"book","missing":[],"readyToConfirm":false,"summary":null,"needsForm":false}
```

### Staff — `/api/staff` (auth + role `staff` or `admin`)

| Method | Path | Query / Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/appointments` | `?when=upcoming\|past\|all` (default `upcoming`), `?status=…` (optional) | `{ appointments }` — up to 200, each with `customer: { name, email, phone }` |
| `PATCH` | `/appointments/:id/cancel` | — | `{ appointment }` — cancels any booking in the business |

### Admin — `/api/admin` (auth + role `admin`)

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/users` | — | `{ users }` — `{ id, email, fullName, role, createdAt }`, newest first, max 200 |
| `PATCH` | `/users/:id/role` | `{ role: 'customer'\|'staff'\|'admin' }` | `{ user }` — 409 `CANNOT_CHANGE_OWN_ROLE` if you target yourself |

### Examples

```bash
# sign up (phone is optional, but the app asks for it)
curl -X POST http://localhost:4000/api/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"fullName":"Ali Khan","email":"ali@example.com","password":"password123","phone":"+92 300 1234567"}'

# log in and keep the token
TOKEN=$(curl -s -X POST http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"ali@example.com","password":"password123"}' | jq -r .token)

# what can be booked?
curl -s http://localhost:4000/api/appointments/options -H "Authorization: Bearer $TOKEN"

# book straight through the form endpoint
curl -X POST http://localhost:4000/api/appointments \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"service":"Check-up","date":"2026-10-05","time":"15:00","notes":"first visit"}'

# chat with the assistant (JSON reply)
curl -X POST http://localhost:4000/api/chat/messages \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"message":"book a check-up tomorrow at 3pm"}'

# watch the reply stream in
curl -N -X POST http://localhost:4000/api/chat/messages/stream \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"sessionId":"<uuid from the previous call>","message":"yes please"}'

# confirm the drafted action
curl -X POST http://localhost:4000/api/chat/sessions/<uuid>/confirm -H "Authorization: Bearer $TOKEN"

# staff view (needs a staff or admin token)
curl -s "http://localhost:4000/api/staff/appointments?when=all" -H "Authorization: Bearer $TOKEN"
```

---

## Booking rules

These live in `backend/src/services/bookingRules.ts` — **not** in the LLM prompt. The model may only
propose; this module decides.

| Rule | Value / behaviour |
| --- | --- |
| Services | `Teeth cleaning`, `Check-up`, `Filling`, `Consultation` (enforced by `z.enum(SERVICES)`) |
| Opening hours | 09:00–18:00 wall-clock in the **business timezone** |
| Slot length | 30 minutes (`DEFAULT_DURATION_MIN`); a slot must finish by 18:00 |
| Timezone handling | `date` + `time` are interpreted as wall-clock in `businesses.timezone`, then converted to UTC (`zonedTimeToUtc`), so DST is handled correctly |
| Past bookings | Rejected if the start is less than 5 minutes away; the error's `details.field` is `date` or `time` |
| Invalid dates | `2026-02-30` is rejected as `INVALID_SLOT` |
| Double-booking | Blocked by the DB exclusion constraint, so concurrent requests cannot both win → `409 SLOT_TAKEN` |
| Reschedule | Keeps the original duration; only `pending`/`confirmed` appointments that have not ended can move |
| Cancel | Only `pending`/`confirmed`; the row is soft-deleted (`status = 'cancelled'`), and cancelled slots become bookable again |

Changing the business hours, services or slot length is a one-line change here; the booking form and the
assistant both read `GET /api/appointments/options`, so the UI follows automatically.

---

## How the AI chat works

1. **Input** — `POST /api/chat/messages` (or `/stream`) with an optional `sessionId`.
2. **Context assembly** (`chatService.handleMessage`) — loads the business (name + timezone), the session's
   persisted draft, the last 12 messages, and the user's next 10 upcoming appointments (numbered, so the
   model can say "appointment 2" for a cancel/reschedule).
3. **LLM call** (`aiService.extractBooking`) — one OpenAI-compatible request with `temperature: 0.2`, a
   15-second timeout and up to 2 attempts (retries are skipped once partial text has already been streamed).
   The system prompt contains services, hours, today's date in the business timezone, the numbered
   appointment list, the current draft JSON, and the rules; the model must answer with **JSON only**.
   The model is told it cannot book, change or cancel anything, and that user messages are data, not
   instructions.
4. **Validation** — the JSON is parsed and zod-validated (bad JSON or a wrong shape is an `AiError`), then
   `normalizeExtracted` keeps only values matching the real service list, an ISO date and an `HH:mm` time.
   `applyIntent` merges them into the draft, switching action when the user changes goal, and resolves which
   existing appointment a cancel/reschedule refers to.
5. **Business checks** — with all required fields present, the slot is built and tested: past/closed hours
   are rejected, an unchanged reschedule time is refused, and a taken slot produces a friendly
   "that time is already taken" reply with the time cleared so the user can pick again.
6. **Reply** — persisted to `chat_messages` (draft saved to `chat_sessions.draft_booking`) and returned.
7. **Confirmation** — only `POST /api/chat/sessions/:id/confirm` writes to `appointments`, and it re-checks
   that the session is active and the draft is complete. Booking marks the session `completed`.

**Graceful degradation** — if the LLM is unreachable or keeps failing, the user gets a clear message and
`needsForm: true`; for new bookings the UI opens the pre-filled form. For reschedules/cancels it points at
the buttons in the appointment list. Chat never becomes a dead end.

**Streaming** — the reply text is extracted from the *partially received* JSON by `ReplyExtractor`
(it tracks the opening `"reply":"` and decodes escapes across chunk boundaries), so the user sees words
appear while the rest of the JSON — intent and extracted fields — is still arriving. The `final` event
carries the authoritative, fully validated result.

**Logging** — every call (success or failure) is written to `ai_logs` with model, prompt, raw response,
latency and error, and mirrored to the pino log. Writing a log row is wrapped in try/catch so logging can
never break the chat.

---

## Key design decisions and tradeoffs

**1. The LLM only extracts; deterministic code decides.**
The model turns free text into `{ intent, service, date, time }` and writes a friendly sentence — nothing
more. Hours, slot length, availability and the write itself live in `bookingRules.ts` and
`appointmentService.ts`.
*Why:* LLM output is probabilistic, and a hallucinated slot is a real double-booking.
*Trade-off:* more code to maintain, and the assistant occasionally sounds blunter ("that time is already
taken") than a pure-LLM agent would. In exchange, business rules never need a prompt change.

**2. Model output is treated as untrusted input.**
`parseModelJson` requires strict JSON in a zod-validated shape; `normalizeExtracted` then keeps only values
that match the real service list, an ISO date and an `HH:mm` time; `applyIntent` drops any appointment
reference that does not resolve to one of the user's appointments.
*Why:* a prompt injection or a rambling model must not be able to invent a service or an arbitrary id.
*Trade-off:* legitimate but unusual phrasing is discarded and re-asked rather than accepted.

**3. Nothing is written without an explicit user confirmation.**
The chat can only reach `readyToConfirm`; the `INSERT`/`UPDATE` happens in
`POST /api/chat/sessions/:id/confirm`, which re-checks that the session is active and the draft complete.
*Why:* an irreversible booking action should be attributable to the human, not to a token stream.
*Trade-off:* one extra click, and the client must hold/restore the confirm state (it does, via the persisted
draft).

**4. Conversation state lives in the database, not in the prompt.**
`chat_sessions.draft_booking` (JSONB) is the assistant's memory; history is trimmed to the last 12 messages.
*Why:* it survives a reload and a new HTTP request, keeps token usage bounded, and makes the flow debuggable
with SQL.
*Trade-off:* extra reads/writes per turn, and the draft is a second source of truth that must stay in sync
with what the UI shows.

**5. Double-booking is prevented by the database.**
`appointments` carries `EXCLUDE USING gist (business_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
WHERE status <> 'cancelled'`. A racing request gets SQLSTATE `23P01`, mapped to `409 SLOT_TAKEN`.
*Why:* a check-then-insert in application code loses the race; this cannot.
*Trade-off:* it needs the `btree_gist` extension, and the constraint models **one bookable resource per
business** — a second chair or dentist means adding `resource_id` to it.

**6. Timezone maths is explicit, with no date library.**
`bookingRules.zonedTimeToUtc` uses `Intl.DateTimeFormat` to find a zone's offset and converts a wall-clock
date + time into a UTC instant; everything is stored as `TIMESTAMPTZ`.
*Why:* "tomorrow at 3pm" must mean the clinic's 3pm, and the browser's clock is not authoritative.
*Trade-off:* ~30 lines of offset arithmetic to maintain instead of an npm dependency; it assumes
`businesses.timezone` holds a valid IANA zone.

**7. The service catalogue and opening hours are typed constants.**
`SERVICES` and `BUSINESS_HOURS` are exported from `bookingRules.ts`, enforced with `z.enum(SERVICES)` and
served to the UI through `GET /api/appointments/options`.
*Why:* one source of truth shared by the form, the chat, API validation and the UI — and changing hours is a
one-line, type-checked change.
*Trade-off:* changing them needs a deploy, and a business cannot self-serve its own hours or services (DB
tables would be the next step).

**8. Cancellation is a status change, never a delete.**
`status = 'cancelled'` on `pending`/`confirmed` rows; no `DELETE FROM` exists anywhere in the API.
*Why:* cancelled slots must become bookable again (which is exactly why the exclusion constraint ignores
cancelled rows) while the clinic keeps the history.
*Trade-off:* tables grow forever, and there is no un-cancel endpoint and no reschedule audit trail.

**9. Auth is a 7-day JWT in `localStorage`, with no refresh token.**
`requireAuth` verifies the signature; the frontend clears the token on logout and on any `401`
(via the `auth:expired` event).
*Why:* very few moving parts, and it works cleanly with `fetch` and SSE.
*Trade-off:* a token cannot be revoked before it expires (logout is client-side only), and `localStorage` is
readable by injected scripts — an httpOnly cookie with CSRF protection is the hardening step.

**10. Roles are re-read from the database on every request.**
`requireRole` queries `users.role` instead of trusting the JWT claim.
*Why:* promoting a colleague to staff takes effect on their next click, not in seven days, and a demotion is
immediate.
*Trade-off:* one extra query per role-gated request.

**11. One booking service, two entry points.**
The form (`POST /api/appointments`) and the chat confirmation both call the same
`createAppointment` / `rescheduleAppointment` / `cancelAppointment` functions.
*Why:* the two paths cannot drift apart in validation or behaviour.
*Trade-off:* the chat cannot take a shortcut even when the model is confident.

**12. Streaming is an optimisation with a non-streaming twin.**
`POST /api/chat/messages` returns complete JSON; `/messages/stream` returns SSE (`delta` events, then a
`final` event). `ReplyExtractor` pulls the `reply` text out of the still-arriving JSON so words appear
immediately.
*Why:* perceived latency is the main UX cost of a slow model, and the JSON endpoint stays as the simple path.
Retries stop once text has been sent so the user never sees a duplicated reply.
*Trade-off:* two endpoints to keep in sync, a bespoke partial-JSON parser, and proxies or serverless cold
starts must not buffer the response.

**13. Validation at the edge with a single error shape.**
One zod schema per endpoint; failures return
`{ error: { code: 'VALIDATION_ERROR', details: [{ path, message }] } }`, and the UI maps `details[].path`
onto the matching form field.
*Why:* identical error handling on every endpoint, with a generic form-error mechanism and no per-form
plumbing.
*Trade-off:* the schema paths must match the client's field names (e.g. `phone`) for field highlighting, and
there is no generated OpenAPI document.

**14. Rate limiting is in-process.**
Three `express-rate-limit` tiers using the default memory store.
*Why:* no extra infrastructure, and it caps LLM spend per user as well as per IP.
*Trade-off:* counters reset on restart and are per instance — two API instances would allow double the
traffic; production would switch to the Redis store.

**15. Every LLM call is logged in full.**
`ai_logs` stores the model, prompt, raw response, latency, success flag and error.
*Why:* the fastest way to debug a parse/prompt failure, and it gives prompt-iteration analytics.
*Trade-off:* it grows without bound and contains raw conversation text, so it is PII-sensitive and needs a
retention policy before production.

**16. The phone number is required in the form but optional in the API.**
`POST /api/auth/signup` accepts `phone`, validates it when present, and normalises a blank value to `NULL`.
*Why:* staff need a reachable number, but making it mandatory server-side would break existing clients; the
signup form enforces it for new users.
*Trade-off:* API clients can still create accounts without a phone (the staff list then shows none), and
accounts created before this change are not backfilled.

**17. Small frontend dependency surface.**
Plain `fetch` wrappers in `src/lib/api.ts`, React context for auth, hand-written CSS, no data-fetching or UI
library.
*Why:* nothing extra to learn, fast installs, and nothing to keep upgrading at this scope.
*Trade-off:* caching, retries and optimistic updates are manual — each component tracks its own
loading/error state — and CSS is maintained by hand rather than with utility classes or components.

---

## Frontend guide

### Routes

| Route | File | Behaviour |
| --- | --- | --- |
| `/` | `app/page.tsx` | Spinner, then redirect to `/dashboard` (signed in) or `/login` |
| `/login` | `app/login/page.tsx` | `AuthForm` — email + password |
| `/signup` | `app/signup/page.tsx` | `AuthForm` — full name, email, **phone number**, password |
| `/dashboard` | `app/dashboard/page.tsx` | Header + tab bar; customers see the chat and their list, staff/admins get extra tabs |

### Components

| Component | Responsibility |
| --- | --- |
| `AuthForm` | Login/signup. Mirrors the server's phone rule locally so mistakes are caught before the request; server `details[]` is mapped onto the matching field via `fieldErrors` |
| `ChatWidget` | Message list, streamed replies, suggestion chips, confirm button, and the booking-form fallback. Persists the active `sessionId` in `localStorage` and rehydrates the transcript on reload |
| `AppointmentForm` | Service/date/time/notes; slots come from `GET /api/appointments/options`; can attach itself to a chat session |
| `AppointmentList` | The customer's own bookings with inline reschedule (date + time) and cancel |
| `StaffAppointments` | Front-desk table with upcoming/past/all filters and cancel. Customer column shows name, email and a `tel:`-linked phone |
| `UserManagement` | Admin-only role dropdowns (own row is disabled) |

### `src/lib`

| Module | Contents |
| --- | --- |
| `api.ts` | `request()` wrapper (JSON, bearer token, network-error mapping), `streamMessage()` SSE reader, `ApiError`, and the typed `api.*` client used by every component |
| `auth.tsx` | `AuthProvider` / `useAuth()`: restores the session with `GET /api/auth/me`, exposes `login`, `signup`, `logout` |
| `types.ts` | Shared types (`User`, `Appointment`, `StaffAppointment`, `ChatReply`, `BookingOptions`, …) plus `DEFAULT_OPTIONS` so the form works even if `/options` fails |
| `slots.ts` | Slot generation and timezone-aware date/time helpers (`buildSlots`, `label12`, `partsIn`, `todayIn`) |
| `typewriter.ts` | Progressive text rendering for streamed replies |

### Auth and session details

- The JWT is kept in `localStorage` under `auth_token`; the active chat session id under `chat_session_id`.
- Any `401` with a token present dispatches a `auth:expired` window event; `AuthProvider` listens for it and
  logs the user out (so an expired token never leaves a broken UI).
- Logging out clears both keys.
- Styling is plain CSS in `app/globals.css`: design tokens (green palette), `.card`, `.data-table`,
  `.badge-<status>` (confirmed / pending / cancelled), `.tabs`, `.skeleton`, `.alert`, and a responsive
  `.table-wrap` for narrow screens.

---

## Roles and permissions

| Capability | customer | staff | admin |
| --- | :---: | :---: | :---: |
| Chat with the assistant / use the booking form | ✅ | ✅ | ✅ |
| See and manage **their own** appointments | ✅ | ✅ | ✅ |
| See **all** appointments in the business (with customer contact details) | — | ✅ | ✅ |
| Cancel anyone's appointment in the business | — | ✅ | ✅ |
| List users and change roles | — | — | ✅ |
| Change their own role | — | — | ❌ (blocked to prevent lockout) |

`requireRole` re-reads the role **from the database on every request**, so a promotion or demotion takes
effect immediately rather than when the token expires.

To give yourself staff/admin access while developing, promote your signup account with SQL:

```sql
UPDATE users SET role = 'staff' WHERE email = 'you@example.com';   -- or 'admin'
```

Refresh the page — the new tab ("All appointments" / "Users and roles") appears on the next load.

---

## Security notes

- **Passwords** — bcrypt (10 rounds), never stored or logged in plaintext. Login compares against a dummy
  hash when the email is unknown so the response time does not reveal which accounts exist.
- **Tokens** — JWT with `sub` (user id), `bid` (business) and `role`, valid for 7 days. Send it as
  `Authorization: Bearer`. Store `JWT_SECRET` in the environment, never in code.
- **Authorisation** — every request carries a business scope; queries filter by `business_id`, and
  role-gated routes re-read the role from the database. A user can only ever touch their own appointments
  (staff/admin routes are the deliberate exception within their own business).
- **Input handling** — one zod schema per endpoint parses bodies, queries and params; JSON bodies are
  capped at 10 kB; helmet sets the usual security headers; CORS is an explicit allow-list
  (`CORS_ORIGIN`), so only your frontend origins can call the API from a browser.
- **Abuse** — three rate-limit tiers (global, auth, chat). The chat limiter keys on the user id, which
  also caps LLM spend per person.
- **Logging** — pino redacts `req.headers.authorization`. Note that `ai_logs` stores full prompts and
  responses: treat that table as potentially containing personal data, add a retention job before
  production, and consider redacting messages for regulated deployments.
- **Deliberate trade-off** — the frontend keeps the JWT in `localStorage`, which is simple and works with
  the SSE stream but is readable by any injected script. Moving to an httpOnly cookie (with CSRF
  protection) is the hardening step if that matters for your threat model.

## Deployment

**Backend**

1. Set the same environment variables on the host (at minimum `DATABASE_URL`, `JWT_SECRET`, `AI_API_KEY`,
   `CORS_ORIGIN`, and `NODE_ENV=production`).
2. `npm run build` → `npm start` (`node dist/server.js`), behind a reverse proxy that supports streaming.
3. Apply `db/schema.sql` to the managed database once (the sample rows are optional in production).
4. `app.ts` default-exports the Express app, so the same code can also be mounted as a serverless handler
   (e.g. on Vercel) without changes.

If you put the API behind nginx or a similar proxy, keep buffering **off** for
`/api/chat/messages/stream` (the handler already sets `X-Accel-Buffering: no`) so replies keep streaming.

**Frontend**

1. `NEXT_PUBLIC_API_URL=https://your-api-host` in the build environment (no trailing slash), and make sure
   the API's `CORS_ORIGIN` lists the frontend's origin.
2. `npm run build` then `npm start`, or deploy to Vercel/any Node host.

---

## Assumptions and known limitations

This project is built to a specific, simple clinic model. The list below is deliberately explicit so the
gap between "works in the demo" and "production-ready for any clinic" is obvious.

### Assumptions

- **One bookable resource per business.** The overlap guard is per `business_id`, so it models a single chair
  / single practitioner. Two parallel calendars need `resource_id` in the exclusion constraint.
- **Uniform opening hours, every day.** `09:00–18:00` in `bookingRules.ts`, with no weekends-off, holidays,
  closures or lunch breaks, and no per-service duration (everything is 30 minutes by default).
- **A fixed service catalogue** (`Teeth cleaning`, `Check-up`, `Filling`, `Consultation`).
- **Every user belongs to exactly one business,** and new signups land in `DEFAULT_BUSINESS_ID`. There is no
  invitation, tenant-selection or self-serve onboarding flow.
- **Email is globally unique** (`CITEXT` across tenants), which keeps login single-step but means the same
  email cannot exist in two businesses.
- **The business timezone is the source of truth** (`businesses.timezone`), not the browser's clock or
  timezone, for validating "today", opening hours and displayed slots.
- **Users are reachable by phone.** A number is stored as typed (no E.164 normalisation or carrier
  validation) and is optional at the database level.
- **The LLM provider speaks the OpenAI chat-completions API** and returns JSON that usually matches the
  requested shape; the code degrades gracefully when it does not, but it cannot fix a wrong model or key.
- **One API instance at a time,** with a pg pool of 10 connections — fine for development and demo traffic,
  and the reason the rate limiter uses an in-process store.
- **A modern browser** with `fetch` streaming (`ReadableStream`) support; the code shows a clear error
  instead of silently failing when that is missing.
- **Configuration comes from `.env` files** (`backend/.env`, `frontend/.env.local`) — there is no secrets
  manager or per-environment config service.
- **PostgreSQL 13+ with permission to create the `citext` and `btree_gist` extensions.**

### Known limitations

- **No notifications.** Nothing emails, texts or calls anyone: no reminders, no booking confirmations, no
  cancellation notices, no email verification. The phone number is collected for this purpose but is not
  used for it yet.
- **No account lifecycle features.** No password reset, no "change my details" screen (a phone number can
  only be set at signup), and no account deletion.
- **`appointments.status = 'completed'` is never set.** The schema allows it and the API filters accept it,
  but no code or job ever marks a past appointment as completed — past appointments stay `confirmed` (the
  staff "Past" view works off `ends_at <= now()`).
- **`chat_sessions.status = 'abandoned'` is never set.** An unfinished conversation stays `active`
  indefinitely, so abandoned sessions accumulate.
- **Nothing is ever deleted.** There is no `DELETE FROM` anywhere in the API: cancelled appointments stay as
  rows, and there is no way to un-cancel one. No audit trail of past reschedules either.
- **No pagination.** Lists use hard caps instead — 50 own appointments, 200 staff appointments, 200 users,
  200 messages per session. Older rows simply are not returned.
- **The assistant only knows the next 10 upcoming appointments** (`listUpcoming(actor, 10)`); it cannot
  answer questions about past bookings or totals, and it cannot resolve "my appointment" when the user has
  more than 10 upcoming.
- **No availability calendar.** Users see a slot dropdown generated from opening hours, not a view of
  existing bookings, so a slot can legitimately be taken between display and submit (`409 SLOT_TAKEN`).
- **JWTs cannot be revoked** before their 7-day expiry; logout is client-side only.
- **Rate limits are per instance and reset on restart** (in-process store).
- **Row-Level Security is not enabled,** so tenant isolation depends on every query remembering its
  `business_id` scope — one missed `WHERE` would leak across tenants.
- **No tests and no CI.** Verification is `npm run typecheck` (API) plus `npm run build` (UI) and manual
  checks; there is no regression safety net.
- **The schema is applied by hand** (`psql -f db/schema.sql`), with no migrations, so production changes
  need a manual plan.
- **`ai_logs` grows unbounded** and stores raw prompts and responses (potential PII), with no retention job.
- **No admin UI for configuration.** Services, hours and timezone must be changed in code / SQL.
- **Single-region assumption,** and streaming needs a proxy that does not buffer; serverless platforms may
  need extra configuration for SSE plus a warm start.
- **No i18n/localisation** and no formal accessibility audit (semantic tables, labels and `aria` attributes
  are used, but screen-reader testing has not been done).
- **Windows development caveat:** running `next build` while `next dev` is running corrupts `frontend/.next`
  and the dev server starts returning 500s — see [Troubleshooting](#troubleshooting).

The [Roadmap](#roadmap) lists the fixes for most of the above.

---

## Troubleshooting

**A page 500s and the dev log shows `ENOENT … .next/server/app/<route>/page.js`, or the browser says
`Cannot find module '/NNN.js'`.**
Your `.next` build cache is stale or was written by a different process. Fix:

```bash
# stop the dev server, then
rm -rf frontend/.next        # Windows: Remove-Item frontend\.next -Recurse -Force
cd frontend && npm run dev
```

Root cause to avoid: **never run `next build` while `next dev` is running** — both write to the same
`.next` directory and the dev server ends up referencing chunks that no longer exist. Also hard-refresh
(Ctrl+Shift+R) the browser, because a Next.js error overlay stays cached in the tab.

**The page HTML loads but is completely unstyled.** Same stale-`.next` cause — the CSS chunk is gone with
it. Use the fix above and confirm `/_next/static/css/app/layout.css` returns content.

**`Error: listen EADDRINUSE: address already in use :::3000` (or `:4000`).**
Another dev server is still running. Find and stop it:

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

If Next.js silently starts on `:3001`, the frontend will still call `NEXT_PUBLIC_API_URL` and the API's
`CORS_ORIGIN` will reject it — always check the port printed at startup.

**`GET /health` returns `503 {"status":"db_unavailable"}`.** The API is up but Postgres is unreachable:
check `DATABASE_URL`, that the database is running, and that your IP is allowed by the provider's
firewall (hosted Postgres often needs an allow-list entry or `?sslmode=require`).

**The API exits immediately, printing `Invalid environment configuration:` and a list of fields.**
`src/config/env.ts` is strict by design. Add the missing variables to `backend/.env` — the list in
[Environment variables](#environment-variables) is the source of truth, and `backend/.env.example`
already matches it.

**`401 UNAUTHORIZED` on every request.** The token expired or was signed with a different `JWT_SECRET`
(changing the secret invalidates existing sessions). Log in again.

**`429 RATE_LIMITED`.** You hit one of the limits (120/min per IP, 20/15min on auth, 20/min per user on
chat). Wait it out or raise the values in `src/middleware/rateLimit.ts` while developing.

**`409 SLOT_TAKEN` for a slot the UI offered.** Someone booked it in between — this is the exclusion
constraint doing its job. Pick another time.

**The assistant always replies with "I'm having trouble understanding requests right now".** The LLM call
is failing. Check `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`, the provider's quota, and the `ai_logs` table
(`SELECT created_at, success, error FROM ai_logs ORDER BY id DESC LIMIT 10;`) — each failed call is logged
with its error.

**`relation "…" does not exist`.** `db/schema.sql` has not been applied to the database in
`DATABASE_URL`.

**Signup rejects my phone number.** It must be digits with spaces, `+`, `-`, `(`, `)` or `.` only, contain at
least 7 digits, and be at most 30 characters. Leave it blank to store `NULL` (the API allows that; only the
web form requires it).

**Signup fails with `500 INTERNAL_ERROR`.** New users are inserted into `DEFAULT_BUSINESS_ID`; if that UUID
does not exist in `businesses`, the insert violates the foreign key and the API logs an unhandled error.
Point the variable at a real row (the schema seeds `11111111-1111-1111-1111-111111111111`).

---

## Verification checklist

Useful after a schema change, a refactor, or a fresh clone:

```bash
# API
cd backend
npm run typecheck                     # API compiles
curl http://localhost:4000/health     # {"status":"ok"}

# UI (stop `next dev` first!)
cd ../frontend
npm run build                         # UI compiles + type-checks
```

Then, in the browser: sign up with a phone → book via chat → confirm → the booking appears under
"Your appointments" → promote the account to staff → it appears in "All appointments" with the customer's
name, email and phone.

---

## Roadmap

Ordered roughly by value:

- **Notifications** — confirmation and reminder emails/SMS. The `phone` column is already collected for this,
  and it is the biggest gap between "demo" and "usable in a real clinic".
- **Row-Level Security** on `business_id` so tenant isolation is enforced by the database rather than by
  every query remembering its scope.
- **Tests and CI** — Vitest + supertest for the API, React Testing Library for the UI, and a pipeline running
  typecheck → tests → build on every push.
- **Migrations** (e.g. `node-pg-migrate`) instead of applying `db/schema.sql` by hand.
- **Multiple bookable resources** per business — add `resource_id` to the `appointments` exclusion constraint
  and a staff calendar so a clinic can run two chairs in parallel.
- **Availability calendar** — show existing bookings instead of a blind slot list, plus a waitlist for fully
  booked days.
- **Retention jobs** for `chat_messages` and `ai_logs` (and PII redaction in `ai_logs`).
- **Pagination** on the staff/admin lists, plus a `DELETE`/archive policy for cancelled appointments.
- **Account lifecycle** — password reset, profile editing (so an existing user can add or change their phone),
  and account deletion.
- **Configurable services/hours/timezone** in the database with an admin screen, instead of constants in code.
- **Refresh tokens** (or httpOnly cookies) so sessions can be revoked, and a Redis-backed rate limiter for
  multi-instance deployments.
- **Mark appointments as `completed`** with a scheduled job, so the status enum is fully exercised and
  reporting per period becomes possible.

---

## Project status

- Built as an assessment project; the git history is the change log:
  `85312bb` schema → `ffe93a4` API → `7f79bea` UI → `4b3b86c` reschedule + theme → `a2ea463` cancel/reschedule
  via chat → `32dda21` streaming and schema restructuring → `f1e2d02` phone number on signup and in the
  staff customer list → `b06ef03` this README plus a refreshed `backend/.env.example`.
- The phone-number feature (signup field, `users.phone` persistence, and the number shown under each
  customer's name for staff) is verified end to end against a real database.
- No license file is included; treat the code as private unless one is added.










