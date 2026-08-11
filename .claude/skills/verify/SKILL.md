---
name: verify
description: How to build, run, and drive the Aram CRM app (Vite+React frontend, NestJS backend) to verify changes end-to-end.
---

# Verifying changes in this repo

## Servers

- Frontend: Vite dev server, usually already running on http://localhost:5173
  (vite.config.ts says port 5174 strictPort, but a long-running instance may sit
  on 5173 — check `Get-NetTCPConnection -State Listen` and match the PID's
  CommandLine to `E:\projects\crm\node_modules\...vite`). Start with `npm run dev`.
  HMR serves the working tree, so branch switches/edits are live immediately.
- Backend: NestJS on http://localhost:4100 (global prefix `/api`). Frontend
  default API base is `http://localhost:4100/api` (src/api/client.ts).
- Ports 3000/3001 belong to a DIFFERENT project (tiremall) — don't touch.

## Auth

Seed users (backend/prisma/seed.ts), password `demo1234`:
- yara@samemha.com — Owner + superadmin, active workspace "Default Workspace"
  (the one with Facebook + Instagram + WhatsApp connected).

JWT is stored in localStorage, so a Playwright page survives hard reloads once
logged in. Quick API smoke:
`POST http://localhost:4100/api/auth/login {"email":"yara@samemha.com","password":"demo1234"}`

## Driving the UI

Playwright MCP works well. Gotchas:
- SPA uses hash routing: deep-link with `http://localhost:5173/#/inbox`.
- The MCP sandbox strips `setTimeout` from the server-side realm:
  `page.waitForTimeout` and delays inside `page.route` handlers throw
  "setTimeout is not defined". Sleep via
  `page.evaluate(() => new Promise(r => setTimeout(r, ms)))` and inject network
  delays by monkey-patching `window.fetch` in `page.addInitScript`.
- Conversation list rows are `.conv-row`; the loading skeleton wrapper has
  `aria-label="Loading conversations"` (or Arabic "جارٍ تحميل المحادثات").
- Channel toggles are `.ch-toggle` in order: whatsapp, instagram, facebook,
  tiktok, webchat.

## Timing facts (useful for loading-behavior tests)

- `/conversations` (DB) ~0.6s; `/integrations/facebook/conversations` and
  `/integrations/instagram/conversations` are LIVE Graph API calls: ~3s / ~5s
  cold, can be 20s+, near-instant when the backend has them warm. FB/IG list
  queries only start after their `/status` query returns connected.
- Dashboard pre-warms `/conversations` + both statuses in the react-query
  cache, so navigating Dashboard → Inbox is a warm path; for cold-load tests
  do a full page load straight to `#/inbox`.
