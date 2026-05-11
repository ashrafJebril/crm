# tkana — full-stack AI WhatsApp agent platform

React + Vite + Tailwind v4 frontend, NestJS + Prisma + SQLite backend, JWT-authenticated.

## Stack

**Frontend** (this directory)
- Vite 6 + React 18 + TypeScript
- Tailwind v4 (CSS-first config via `@theme`) + custom oklch token system
- No Redux, no React Query — `useFetch` / `useMutation` hooks (~80 LOC)
- `React.lazy` per screen — initial paint = shell + Dashboard only

**Backend** ([backend/](backend/))
- NestJS 10 + Prisma 5 + SQLite (`prisma/dev.db`)
- JWT auth (bcryptjs) — 7-day tokens, global `AuthGuard`, `@Public()` decorator for opt-out
- 30+ REST routes under `/api`, all protected except `/api/auth/login|register` and `/api/health`

## Run it

Two terminals.

### Terminal 1 — backend

```bash
cd backend
npm install                  # first time only
npm run prisma:push          # creates dev.db from prisma/schema.prisma
npm run seed                 # seeds users, contacts, conversations, appointments, etc.
npm run dev                  # http://localhost:3001/api
```

To wipe and reseed: `npm run reset`.

### Terminal 2 — frontend

```bash
npm install                  # first time only
npm run dev                  # http://localhost:5173
```

## Login

The seed creates four users, all with password `demo1234`:

| Email | Role |
|---|---|
| yara@cedar.com  | Owner   |
| omar@cedar.com  | Manager |
| lina@cedar.com  | Agent   |
| karim@cedar.com | Agent   |

Login form is pre-filled with `yara@cedar.com` / `demo1234` for convenience.

## API surface

Base URL: `http://localhost:3001/api`. All routes except `/auth/login`, `/auth/register`, `/health` require `Authorization: Bearer <token>`.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/auth/login` | `{ email, password }` → `{ token, user }` |
| `POST` | `/auth/register` | `{ email, password, name, role?, color? }` |
| `GET`  | `/auth/me` | Current user from token |
| `GET`  | `/health` | Liveness check |
| `GET / POST / PATCH / DELETE` | `/contacts[/:id]` | Contacts CRUD |
| `GET`  | `/conversations` | List |
| `GET`  | `/conversations/:id` | Detail with messages |
| `POST` | `/conversations` | Create |
| `PATCH`| `/conversations/:id` | Update status / pinned / escalated |
| `POST` | `/conversations/:id/read` | Zero unread counter |
| `GET / POST` | `/conversations/:id/messages` | List + send |
| `GET / POST / PATCH / DELETE` | `/appointments[/:id]` | Appointments CRUD |
| `GET / POST` | `/templates[/:id]` | Templates |
| `GET`  | `/team` | Workspace users |
| `GET / POST / PATCH / DELETE` | `/campaigns[/:id]` | Campaigns CRUD |
| `GET`  | `/dashboard/summary` | Counts + AI resolution % + running campaigns |

## What's wired end-to-end (frontend ↔ backend)

| Screen | Reads from API | Mutates via API |
|---|---|---|
| **Login** | `/auth/me` (bootstrap) | `/auth/login` |
| **Dashboard** | `/dashboard/summary` | — |
| **Inbox** | `/conversations`, `/conversations/:id`, `/contacts` | Send message, mark read |
| **Calendar** | `/appointments`, `/contacts`, `/team` | Create appointment, mark complete/cancelled |
| **Contacts** | `/contacts` | Create, bulk delete |
| **Campaigns** | `/campaigns` | Create (from final builder step), pause/resume, delete |
| **Templates** | `/templates` | — (read-only for now) |
| **Team** | `/team` | — (read-only for now) |
| **Settings** | — | — (UI mock for now) |
| **Agents / Automations / Analytics / Billing** | — | — (per scope: deferred) |

## Architecture

```
e:\projects\crm\
├── README.md                     ← you are here
├── package.json                  ← frontend deps (React 18, Vite 6, Tailwind v4)
├── .env.local                    ← VITE_API_URL=http://localhost:3001/api
│
├── src/                          ← frontend
│   ├── main.tsx                  ← <TweaksProvider><AuthProvider><App/></AuthProvider></TweaksProvider>
│   ├── App.tsx                   ← gates on auth status; renders shell or <Login/>
│   ├── api/
│   │   ├── client.ts             ← fetch wrapper, JWT interceptor, ApiError
│   │   └── useFetch.ts           ← useFetch + useMutation
│   ├── auth/
│   │   ├── context.tsx           ← AuthProvider, useAuth, /auth/me bootstrap
│   │   └── Login.tsx
│   ├── tweaks/                   ← theme/lang/density/accent state
│   ├── shell/                    ← Sidebar + Topbar (Topbar shows user + logout)
│   ├── components/               ← Avatar, Badge, Toggle, charts, CommandPalette
│   ├── icons/                    ← 40 inline SVG icons
│   ├── data/                     ← static seeded constants (AGENTS, INTENTS, etc.)
│   ├── lib/                      ← types.ts, tx.ts (EN/AR helper)
│   ├── styles/                   ← tokens.css + app.css + Tailwind entry
│   ├── router.tsx                ← hash router + lazy() screen registry
│   └── screens/                  ← 11 screens, lazy-loaded
│
└── backend/
    ├── package.json              ← backend deps (NestJS 10, Prisma 5, JWT, bcryptjs)
    ├── .env                      ← DATABASE_URL, PORT, CORS_ORIGIN
    ├── prisma/
    │   ├── schema.prisma         ← User, Contact, Conversation, Message, Appointment,
    │   │                            Template, Campaign
    │   ├── seed.ts               ← matches frontend mock data + 4 demo users
    │   └── dev.db                ← SQLite file (gitignored)
    └── src/
        ├── main.ts               ← bootstrap with CORS, /api prefix, ValidationPipe
        ├── app.module.ts         ← imports all feature modules
        ├── prisma/               ← global PrismaService
        ├── auth/                 ← AuthGuard (global), Public decorator, login/register/me
        ├── health/               ← public liveness endpoint
        ├── contacts/             ← controller + service + DTOs
        ├── conversations/        ← list / detail / messages / mark-read
        ├── appointments/         ← CRUD
        ├── templates/            ← list / create
        ├── team/                 ← list users
        ├── campaigns/            ← CRUD
        └── dashboard/            ← /dashboard/summary
```

## Performance notes (still hold)

- CSS variables drive theme/accent/density/RTL. Switching themes = single attribute write on `<html>`.
- Each screen lazy-loaded → initial paint excludes 10 of the 11 screens.
- All charts are pure SVG, memoized.
- Backend uses Prisma's `findMany` with explicit `orderBy` and `@@index` on hot fields (`Conversation.contactId`, `Appointment.startAt`, `Message.conversationId`).
- JWT verification per request is a single sync `verify` against an in-memory secret — no DB hit, no introspection.

## Out of scope (per current roadmap)

- AI Agents endpoints (no `/agents` CRUD; the 4 agents stay seeded as static frontend data)
- Full Campaign builder persistence (only the final-step "Schedule send" hits `/campaigns POST`)
- Automations engine (graph builder still works visually; doesn't execute)
- Analytics aggregations beyond `/dashboard/summary`
- Settings persistence (UI is mocked, no backend writes yet)
- Real-time updates (no WebSocket; polling/refetch only)
