# SP-30 Platform UX: Responsive Shell, Language in the URL, Public Site: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- **Responsive shell.**
  - Shared breakpoints (`sm 640`, `md 768`, `lg 1024`, `xl 1280`) are defined once in `src/styles/breakpoints.ts` and mirrored as documented literal values in the CSS (ruling 2).
  - Below `md`, the sidebar becomes an off-canvas drawer. It opens from a menu button in the topbar, has a scrim, closes on route change, Escape or scrim tap, traps focus while open, and slides in from the inline start (so from the right in Arabic).
  - From `md` to below `xl` it is a collapsible icon rail. From `xl` up it is full, as today.
  - The collapsed state is remembered per device; today it is forced to `false` on load at `tweaks/context.tsx:32`.
  - The topbar search collapses to an icon below `lg`, and the topbar never overflows.
- **Phone-usable screens, first wave** (roadmap order):
  - **Inbox:** three columns, then a single pane on phones (list → thread → details) with a back button.
  - **Contacts:** a card list on phones; the table scrolls inside its own container on tablets.
  - **Pipeline:** the board scrolls horizontally inside its container with scroll-snap columns; the table view behaves like Contacts.
  - **Calendar:** day view and agenda on phones; the week view stays from `md`.
- **Second wave:** Dashboard (home), Follow-ups, Settings (all tabs), Team, the SP-06 record sheet, and every dialog (full-screen sheets below `sm`).
- Other screens (Social, Campaigns, Templates, Workflows builder, Analytics, Ads, Channels, Media, Agent, Admin) only get **no horizontal page scroll** at 390 px. Their full phone layouts are deferred and listed in the roadmap (ruling 3).
- **Roadmap acceptance:** `each screen is verified at 390px width through the verify skill with no horizontal scroll`, for the shell plus every first- and second-wave screen. "No horizontal scroll" is measured as `document.scrollingElement.scrollWidth <= window.innerWidth` after load and after opening the screen's main dialog. It is backed by vitest tests of the pure layout logic.
- **Language in the URL (D5).**
  - Keep inline `tx()` (no locale files; ruling 1).
  - Add `?lang=ar|en` in the hash query (`#/inbox?lang=ar`). It is honoured on load and on `hashchange`, written into the existing tweaks language (`aram.tweaks.v1`), and kept when navigating, so a copied link opens in its language.
  - Public pages (SP-26 accept/reset, SP-27 consent) honour it too.
  - The first-run language, when nothing is stored, comes from the workspace's `lang` instead of a hard-coded `"en"` (ruling 4).
- **Public marketing website (D7).** Out of scope for this repo, per D7's suggested default (ruling 5). The app's login page gains a link to the external site, `VITE_PUBLIC_SITE_URL`, when that variable is set.

**Architecture:**
- **No backend change and no migration** (ruling 6). The reserved timestamp `20261118160000_platform_ux` is unused. If the controller wants the user's language stored server-side (for SP-26 emails), it becomes `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "uiLang" TEXT;` plus `PATCH /auth/me {uiLang}`. That is ruling 4's alternative.
- **Breakpoints** (`src/styles/breakpoints.ts`):
  - Exports `BP = {sm: 640, md: 768, lg: 1024, xl: 1280}` and `layoutFor(width) → "phone" | "tablet" | "desktop" | "wide"`.
  - Exports `shellMode(width, collapsedPref) → "drawer" | "rail" | "full"`. Below `md` it is `drawer`; from `md` to below `xl` it is `rail` unless the user expanded it; otherwise `full` unless the user collapsed it.
  - CSS cannot read custom properties in `@media`, so `tokens.css` documents the four values in a comment block. `breakpoints.test.ts` parses every `@media` in `src/styles/*.css` and in the CSS strings of `src/screens/**/*.css` and fails on any width that is not one of `BP ± 0.02` (the `max-width: 767.98px` form). This keeps one scale.
- **`useViewport()`** (`src/lib/useViewport.ts`) is one `matchMedia` listener per breakpoint, shared through a module-level store. It returns `{width, layout}` and runs in the browser only. Components use it where layout logic cannot be expressed in CSS, for example Inbox pane switching. Everything else uses CSS classes.
- **Inline styles are the main obstacle:** there are about 2,842 `style={{` occurrences, and Inbox alone is 3,466 lines with a fixed three-column grid at `Inbox.tsx:3199`.
  - **Ruling 7:** each first- and second-wave screen moves its **layout** styles (grid templates, fixed widths, overflow) into class names in a per-screen CSS file: `src/styles/screens/{inbox,contacts,pipeline,calendar,dashboard,followups,settings,team}.css`, imported by the screen. Cosmetic inline styles stay.
  - This is a refactor with no behaviour change on desktop. Each task proves that with before/after screenshots at 1440 px.
- **Shell** (`src/App.tsx`, `src/shell/{Sidebar,Topbar}.tsx`, `src/styles/app.css`):
  - `.app` keeps its grid at `md+`.
  - Below `md`, `.app` is one column, and `Sidebar` renders inside `ShellDrawer.tsx`:
    - `position: fixed; inset-block: 0; inset-inline-start: 0; inline-size: min(85vw, 300px)`;
    - `transform` in the inline-start direction, flipped by `[dir=rtl]`;
    - a scrim;
    - `role="dialog"` with `aria-modal`, a focus trap, Escape to close, and `inert` on the main content while open.
  - The collapsed preference is stored in `aram.tweaks.v1` (`sidebarCollapsed`). The forced `collapsed = false` at `tweaks/context.tsx:32` is removed.
  - The record sheet (`RecordSheet.tsx`) is already full-width below 640 px (`app.css:737`); it keeps that and gains safe-area padding.
- **Inbox phone pattern:**
  - `inboxPane(layout, selection) → "list" | "thread" | "details"` is a pure function.
  - The hash keeps the selected conversation (the existing param), so Back returns from the thread to the list through browser history.
  - The details panel opens as a sheet from the thread header.
  - The SP-01 filters move into a bottom sheet on phones.
- **Tables:**
  - `ResponsiveTable` (`src/components/ResponsiveTable.tsx`) wraps a table in `overflow-x: auto` with sticky first-column support and `max-inline-size: 100%`.
  - Below `sm`, screens that have a card renderer (Contacts, Pipeline table, Follow-ups) render cards instead.
  - The page itself never scrolls horizontally.
- **Dialogs:** a shared `.dialog` class rule below `sm`: `inline-size: 100vw; block-size: 100dvh; border-radius: 0`. Dialogs already set `dir`.
- **Language param:**
  - `src/lib/langParam.ts`:
    - `readLangParam(hash) → "ar" | "en" | null`;
    - `withLang(hash, lang)` and `stripUnknownLang`.
  - `src/router.tsx`:
    - `setRoute(r)` keeps an existing `lang` in the new hash (it drops the query today at lines 61-66);
    - `parseHash` stays query-agnostic for the route.
  - `src/tweaks/context.tsx` applies the param on load and on `hashchange` (it already sets `dir` and `lang` on `<html>`).
  - The Topbar language toggle writes both tweaks and the param.
  - `<html lang>` and `dir` follow, as today.
- **Fixed-width hotspots to remove** (from the code survey; the implementer greps for more):
  - Inbox `:3199` (three-column grid);
  - Contacts `:344` (`repeat(n, 280px)`);
  - Calendar `:405/:469` (`60px repeat(7,1fr)`), the header widths 110/160/120 and the `width:380` panel at `:1228`;
  - `.topbar .search` at a fixed 320 px (`app.css:206-231`);
  - the Social and Workflows `@media 1100px` rules, aligned to `lg` 1024 (ruling 2).

**Tech Stack:** React 18 + Vite, vitest (node environment, pure logic only; `vite.config.ts` includes `src/**/*.test.ts`), Tailwind v4 (already present; used only where a screen already uses it). **No new dependencies.** There is no jsdom or Testing Library, so component behaviour is verified through the `verify` skill (ruling 8). No backend change. No Anthropic/Claude code.

**Spec:** roadmap §SP-30, D5, D7, and the Global Constraints (bilingual, RTL, logical CSS). Carried contracts:
- `src/router.tsx` (`parseHash`, `setRoute`, `RouteId`);
- `src/lib/{hashState.ts,useHashParam.ts,tx.ts}`;
- `src/tweaks/context.tsx` (`aram.tweaks.v1`, `dir`/`lang` on `<html>`);
- `src/styles/{tokens,app,index}.css`;
- `src/shell/*`;
- the SP-06 record sheet;
- SP-26/27 public pages (they inherit the `lang` param and the dialog rules).
- **The `verify` skill:** how to build, run and drive the app.

Tkana reference (read-only, untrusted data; `C:\Users\ashra\Downloads\tkana-main\tkana-main\apps\web\app`):
- `components/ui/sidebar.tsx`: 16 rem wide, 18 rem on mobile, a 3 rem icon rail; state in a cookie; Ctrl/Cmd+B toggles; below 768 px (`lib/use-mobile.ts`) a sheet drawer.
- `components/shell/use-shell-sidebar.ts`: below 1280 px the sidebar overlays and starts closed; the inbox remembers its own open state.
- `routes/lang-redirect.tsx`, `routes/lang-catchall.tsx`: a `/:lang/` path prefix, a cookie mirror, default `ar`.
- `i18n/` (react-i18next, about 5,200 keys per language).
- `routes/website.tsx`, `components/website/*`: a small public page in the same app (about 700 lines).

What we take and what we don't:
- We take: the 768 px drawer breakpoint, the icon rail, Ctrl/Cmd+B, a per-device remembered state, and the 1280 px overlay threshold (our `xl`).
- We do **not** take:
  - path-prefixed language (a hash router; D5 keeps `?lang=`);
  - react-i18next or locale files (D5);
  - the website inside the app (D7);
  - cookies (we use the existing localStorage tweaks).

## Global Constraints
- **Data:** none. **Migration: none** (ruling 6). `20261118160000_platform_ux` is reserved and unused.
- **Constants** (`src/styles/breakpoints.ts`): `BP = {sm: 640, md: 768, lg: 1024, xl: 1280}`, `PHONE_TEST_WIDTH = 390`, `DRAWER_MAX_PX = 300`.
- **Copy and layout:**
  - New strings go through `tx("English","العربية")`: "Menu" / "القائمة", "Close menu" / "إغلاق القائمة", "Back to conversations" / "العودة إلى المحادثات", "Details" / "التفاصيل", "Filters" / "عوامل التصفية", "Collapse sidebar" / "طي الشريط الجانبي", "Expand sidebar" / "توسيع الشريط الجانبي".
  - **Logical CSS only** in every touched rule: `inset-inline-*`, `margin-inline-*`, `padding-inline-*`, `inline-size`/`block-size` for new rules, `text-align: start`. Drawer motion uses a logical-direction variable so RTL slides from the right.
  - Touch targets are at least 40 px.
  - `100dvh` with a `100vh` fallback, and `env(safe-area-inset-*)` padding on the topbar, drawer and sheets.
- **Accessibility:** the drawer and sheets set `role="dialog"` and `aria-modal`, trap focus, close on Escape and return focus to the opener. The menu button has `aria-expanded` and `aria-controls`. `prefers-reduced-motion` disables the slide (the rule already exists in `app.css`).
- **Permissions:** no new route, so no `permission-map.ts` change.
- **Tests:**
  - frontend (repo root): `npx vitest run`, `npm run typecheck`, `npm run build` per task. Backend: untouched; `npm test` in `backend/` is run once in Task 1 to confirm it is unaffected.
  - **Named acceptance test (exact name, from the roadmap):** `each screen is verified at 390px width through the verify skill with no horizontal scroll`.
    - It is a **verify-skill checklist**, run in Task 4 and recorded per screen with a screenshot and the measured `scrollWidth`/`innerWidth`.
    - It is backed by the vitest suite `src/styles/responsive.test.ts`, whose top-level `describe` carries that exact name and covers the pure parts: `shellMode`, `inboxPane`, the breakpoint scale lint, and the dialog rule presence.
  - Other vitest names:
    - `shell mode by width and preference`
    - `inbox pane by layout and selection`
    - `css media queries use only the breakpoint scale`
    - `lang param read, kept on navigation and ignored when unknown`
    - `first-run language follows workspace lang`
- **Commits:** selective `git add <paths>`, never `-A`. Trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not stage `.playwright-mcp/`, `.claude/worktrees/` or any untracked file this plan did not create.

## Review Focus
1. **Desktop does not regress.**
   - Moving layout from inline styles to classes must leave 1440 px rendering unchanged.
   - Evidence: before/after screenshots at 1440 px in English and Arabic for every touched screen, compared side by side in each task's report.
   - Tests: the verify-skill desktop pass in Tasks 2–4.
2. **No horizontal page scroll at 390 px.**
   - Wide content (tables, boards, the calendar week) scrolls inside its own container, never the page.
   - Tests: `each screen is verified at 390px width through the verify skill with no horizontal scroll`.
3. **RTL is first-class on phones.**
   - The drawer slides from the inline start (right in Arabic).
   - The back arrows mirror.
   - Sheets and dialogs set `dir`.
   - Mixed-direction values stay in `<bdi>`.
   - Tests: the 390 px pass runs in Arabic as well as English.
4. **The drawer is accessible and does not leak focus or scroll.**
   - The focus trap holds; Escape works; body scroll is locked while open; it closes on route change.
   - Tests: verify-skill keyboard checks; `shell mode by width and preference`.
5. **The language param never fights the stored preference.**
   - A link with `?lang=ar` opens in Arabic and stores it.
   - Navigation keeps it.
   - An unknown value is ignored.
   - The toggle updates both.
   - Tests: `lang param read, kept on navigation and ignored when unknown`.

## Architecture Rulings and Risks
1. **D5: locale files or inline `tx()`.**
   - There are about 3,450 `tx(` calls in 196 files, plus about 158 language ternaries. Moving to locale files is a large mechanical change with high merge-conflict risk against every in-flight SP.
   - **Ruling:** keep `tx()` (D5's suggested default) and add `?lang=` only. A later lint could flag `isAr ?` ternaries.
   - **Alternative:** extract to `src/i18n/{en,ar}.json` with a codemod. **(needs controller ruling)**
2. **One breakpoint scale.**
   - **Ruling:** 640/768/1024/1280, kept honest by a test over every `@media`. The existing 1100 px rules in Social and Workflows move to 1024.
   - **(needs controller ruling, minor)**
3. **What "each screen" means.**
   - There are 18 routes; full phone layouts for all of them are well beyond one sub-project.
   - **Ruling:**
     - the shell plus the first wave (Inbox, Contacts, Pipeline, Calendar) and second wave (Dashboard, Follow-ups, Settings, Team, record sheet, dialogs) get real phone layouts;
     - every other route must pass the 390 px no-horizontal-scroll check (by wrapping wide content) but may stay desktop-shaped;
     - full layouts for Social, Campaigns, Templates, Workflows, Analytics, Ads, Channels, Media, Agent and Admin are listed as follow-ups.
   - **Alternative:** limit acceptance to the first wave only. **(needs controller ruling)**
4. **First-run language.** The workspace `lang` (default `ar`) does not drive the UI today; the UI defaults to `"en"`.
   - **Ruling:** when `aram.tweaks.v1` has no language, use the active workspace's `lang`; afterwards the user's choice wins.
   - **Alternative:** store `User.uiLang` server-side (the reserved migration) so emails and devices agree. **(needs controller ruling)**
5. **D7: public marketing website.**
   - **Ruling:** out of scope; a separate site (D7's default). Add a login-page link via `VITE_PUBLIC_SITE_URL` when set.
   - **Alternative:** a small public route in this app like Tkana's `website.tsx`, which needs a no-auth shell and SEO handling in a hash-routed SPA (poor fit). **(needs controller ruling)**
6. **No migration.**
   - **Ruling:** SP-30 is frontend-only. The reserved `20261118160000_platform_ux` stays unused unless ruling 4's alternative is chosen. **(needs controller ruling, minor)**
7. **Refactoring inline layout styles.**
   - **Ruling:** move only layout properties to per-screen CSS classes on the touched screens, with desktop screenshot parity. There is no Tailwind migration and no visual redesign.
   - Risk: large diffs in `Inbox.tsx` (3,466 lines) and `Calendar.tsx` (2,033), which conflict with any in-flight SP touching them. Mitigation: one screen per commit, rebased just before merge.
   - **(needs controller ruling)**
8. **Component tests.** There is no jsdom or Testing Library.
   - **Ruling:** keep vitest for pure logic (layout functions, the param, the CSS lint), and prove component behaviour through the `verify` skill at 390 px, 768 px and 1440 px.
   - **Alternative:** add `jsdom` and `@testing-library/react` (new dependencies) for drawer/focus tests. **(needs controller ruling)**
9. **Shared files and timing.**
   - SP-30 touches almost every screen, so it conflicts with any concurrently running SP (SP-26 Team/Settings/Login, SP-27 Settings, SP-28 Settings/shell banners, SP-29 Settings/Sidebar).
   - **Ruling:** SP-30 runs **last** in Phase 6, based on the commit that ships SP-29, with the waves merged screen by screen. **(needs controller ruling)**
10. **Verification against production.**
    - Task 4 runs a local frontend build against a local backend (`:4290`) on the production DB, in throwaway workspaces seeded with enough data to fill every screen (long Arabic names, many columns, a full week of bookings), with no provider.
    - No migration to approve.
    - Seeding writes rows only in throwaway workspaces, which needs the user's approval like the earlier SPs.
    - **(needs controller ruling)**
11. **Size.** XL: 3 build tasks (shell and foundations; first wave; second wave and the remaining-route sweep) plus verification. **(needs controller ruling, minor)**

### Controller rulings
*Decided 2026-11-20 by the controller: R1–R11 accepted as proposed. R9: SP-29 has shipped to feat/tkana-parity (merge 88faa2c); base on 4d43fe3. SP-30 has no migration; Task 4 seeding of throwaway workspaces on the production DB still needs explicit user approval.*
- **R1** (keep `tx()`; `?lang=` only; D5): accepted
- **R2** (one breakpoint scale 640/768/1024/1280 with a lint test): accepted
- **R3** (phone layouts for the shell and first and second waves; no-horizontal-scroll for the rest; follow-ups listed): accepted
- **R4** (first-run language from the workspace `lang`; no server-side user language): accepted
- **R5** (public website out of scope; login link via env; D7): accepted
- **R6** (no migration; `20261118160000_platform_ux` reserved and unused): accepted
- **R7** (move only layout styles to per-screen CSS with desktop parity): accepted
- **R8** (pure vitest plus the verify skill; no jsdom): accepted
- **R9** (SP-30 last in Phase 6, base on the SP-29 ship commit, screen-by-screen commits): accepted
- **R10** (verification with a local build on the production DB in throwaway workspaces; seeding needs explicit user approval): accepted
- **R11** (size XL; 3 build tasks + verification): accepted

---

### Task 1: Foundations — breakpoints, viewport hook, responsive shell, language param
**Files:**
- Create:
  - `src/styles/breakpoints.ts` (`BP`, `layoutFor`, `shellMode`);
  - `src/lib/useViewport.ts`;
  - `src/lib/langParam.ts`;
  - `src/shell/ShellDrawer.tsx`, `src/shell/MenuButton.tsx`;
  - `src/styles/responsive.test.ts`, `src/lib/langParam.test.ts`.
- `src/styles/tokens.css` (the breakpoint comment block; safe-area variables), `src/styles/app.css` (`.app` below `md`, the rail at `md–xl`, the topbar search collapse, the `.dialog` phone rule, the drawer and scrim, aligned `@media` widths).
- `src/App.tsx`: the drawer mount and `inert` on main.
- `src/shell/Sidebar.tsx` (a rail toggle button, Ctrl/Cmd+B), `Topbar.tsx` (menu button below `md`, search icon below `lg`).
- `src/tweaks/context.tsx`: the remembered `sidebarCollapsed`, the lang param on load and on `hashchange`, the first-run language from the workspace.
- `src/router.tsx`: `setRoute` keeps `lang`.
- `src/auth/Login.tsx`: the `VITE_PUBLIC_SITE_URL` link.
- `src/screens/Social.tsx:1614`, `src/screens/workflows/workflows.css:210`: 1100 → 1024.

- [ ] Write the failing vitest tests:
  - In `describe("each screen is verified at 390px width through the verify skill with no horizontal scroll")`:
    - `shell mode by width and preference`: 390 → drawer; 800 → rail by default; 800 with an expanded preference → full; 1440 → full; 1440 with a collapsed preference → rail; boundaries 767/768/1279/1280.
    - `css media queries use only the breakpoint scale` (reads `src/styles/*.css` and `src/screens/**/*.css` with `fs`; every `min-width`/`max-width` value ∈ {640, 768, 1024, 1280} or `n - 0.02`).
    - `dialog rule exists for phones` (the `.dialog` rule under `max-width: 639.98px` in `app.css`).
  - `lang param read, kept on navigation and ignored when unknown`:
    - `#/inbox?lang=ar` → ar;
    - `#/inbox?id=1&lang=en` → en;
    - `#/inbox?lang=fr` → null;
    - `withLang("#/contacts?q=x", "ar")` keeps `q`;
    - a `setRoute`-style hash builder keeps `lang`.
  - `first-run language follows workspace lang` (no stored language → the workspace `lang`; a stored language wins).
- [ ] Implement until green.
- [ ] Desktop parity: screenshots of the shell at 1440 px in English and Arabic before and after (verify skill). Phone check of the shell at 390 px (drawer, Escape, focus return, RTL slide).
- [ ] `npx vitest run`, `npm run typecheck`, `npm run build`; `cd backend && npm test` once (unaffected).
- [ ] Commit `feat(ux): breakpoint scale, responsive shell drawer and rail, language in the url`.

### Task 2: First wave — Inbox, Contacts, Pipeline, Calendar
**Depends on:** Task 1. One commit per screen.

**Files:**
- Create `src/styles/screens/{inbox,contacts,pipeline,calendar}.css`; `src/components/ResponsiveTable.tsx`; `src/screens/inbox/inboxPane.ts` + `inboxPane.test.ts`; `src/screens/calendar/calendarView.ts` + test (`defaultCalendarView(layout)`: day below `md`).
- `src/screens/Inbox.tsx` (+ `src/screens/inbox/*`):
  - the three-column grid → classes;
  - the phone single pane through `inboxPane`, with back buttons (mirrored icon in RTL);
  - the details panel as a sheet;
  - filters as a bottom sheet;
  - the composer fixed at the bottom with safe-area padding;
  - the triage strip and number tabs scroll horizontally inside their own row.
- `src/screens/Contacts.tsx` (+ `contacts/*`): the card list below `sm`; `ResponsiveTable` for the table; the bulk bar wraps; the filter chips row scrolls inside itself.
- `src/screens/pipeline/*`: board columns with `scroll-snap-type: x mandatory` inside the board container, `inline-size: min(85vw, 300px)` per column on phones; the table through `ResponsiveTable`/cards; the header filters wrap.
- `src/screens/Calendar.tsx`: day view and agenda by default below `md`; the week grid inside its own scroller from `md`; the side panel (`width:380`) becomes a sheet below `lg`.

- [ ] Write the failing vitest tests:
  - `inbox pane by layout and selection`: phone with no selection → list; phone with a selection → thread; phone with details open → details; tablet and desktop → all panes; a selection cleared by Back → list.
  - `calendar defaults to day view on phones` (with a stored user choice winning on tablet and desktop).
- [ ] Implement screen by screen. After each screen:
  - verify-skill pass at 390 px (English and Arabic: no horizontal scroll, main actions reachable);
  - 768 px;
  - 1440 px parity screenshots.
- [ ] `npx vitest run`, `npm run typecheck`, `npm run build` after each commit.
- [ ] Commits: `feat(ux): phone layout for the inbox`, `… contacts`, `… pipeline`, `… calendar`.

### Task 3: Second wave and the remaining-route sweep
**Depends on:** Task 1 (it can run in parallel with Task 2, in different files).

**Files:**
- `src/styles/screens/{dashboard,followups,settings,team}.css`.
- `src/screens/Dashboard.tsx` (cards stack; charts take the full width), `FollowUps.tsx` (cards below `sm`), `Settings.tsx` (the tab bar scrolls inside itself; the 720 px pane is fluid), every `src/screens/settings/*Tab.tsx` (form rows stack; the SP-29 save bar keeps logical insets), `Team.tsx` (member table → cards), `src/shell/RecordSheet.tsx` (safe-area padding).
- Shared dialogs: every component using the dialog class gets the phone rule. Dialogs with their own fixed widths are listed by grep (`width: 4`, `width: 5`, `minWidth`) and given `max-inline-size: 100%`.
- **Sweep:** for each remaining route (social, campaigns, templates, workflows, analytics, ads, channels, media, agent, admin), wrap wide content in its own scroller so the page never scrolls horizontally. No redesign.

- [ ] Verify-skill pass for every second-wave screen and every swept route at 390 px (English and Arabic), and 1440 px parity for the second-wave screens.
- [ ] `npx vitest run`, `npm run typecheck`, `npm run build`.
- [ ] Commits: `feat(ux): phone layouts for home, follow-ups, settings, team and dialogs`, `fix(ux): no horizontal page scroll on the remaining screens at 390px`.

### Task 4: Verification
There is no migration. Seeding throwaway workspaces on the production DB happens only with explicit user approval (ruling 10). Results go to `.superpowers/sdd/2026-11-18-sp30-platform-ux/live-verification.md` (SP-15 format), with a per-screen table: route, language, width, `scrollWidth`, `innerWidth`, pass/fail and a screenshot path.

**Isolation** (scratchpad `C:\Users\ashra\AppData\Local\Temp\claude\7b75a64029a712a6\ebb2057a-6300-4548-9aec-b98487880afb\scratchpad\`):
- **Backend:** `launch-sp30.js` (from `launch-sp29.js`), **:4290**, outDir `backend/.verify-dist-sp30`, working directory `sp30-run/`. Crons disabled. Every `DO_SPACES_*` is empty.
- **Provider env:** Zernio, Meta, l, OpenAI, Stripe, HJZ, Kewy and email are all empty strings (`EMAIL_PROVIDER=off`). The launcher refuses otherwise. The egress guard stays, and `blocked-egress-sp30.jsonl` must be empty.
- **Frontend:** `npm run build` into `fe-dist-sp30/` in the scratchpad, served by `vite preview` on **:5190** with the API proxied to :4290. The user's :5174 dev server is not touched.
- Test tag `zz-verify-<ts>`.

**Setup** (ids in `verify-created-sp30.json`):
- Seed one workspace with an owner and an agent, through the API where routes exist and raw inserts only for test rows:
  - 60 contacts with long Arabic and English names and several custom fields;
  - 30 conversations across two channel rows (no provider: channel rows only) with Arabic and English messages, labels and an assigned conversation;
  - a pipeline with 7 stages and 40 cards;
  - a week of bookings (SP-10 services and staff);
  - follow-ups in every bucket;
  - tickets with SLA.
- Record before-counts.

**Checks** (verify skill, Playwright driving the preview build):
- **`each screen is verified at 390px width through the verify skill with no horizontal scroll`:**
  - At 390×844, for every route in `RouteId`, in English and Arabic: load the screen, wait for data, and assert `document.scrollingElement.scrollWidth <= window.innerWidth`.
  - Open the screen's primary dialog or sheet (for example new contact, ticket sheet, booking dialog, filters) and assert again.
  - Take a screenshot.
  - The first- and second-wave screens must also pass functional checks:
    - Inbox: list → thread → details → back;
    - Contacts: search and open a contact;
    - Pipeline: scroll the board and open a card;
    - Calendar: day view, agenda, open a booking;
    - Settings: switch tabs and see the save bar;
    - drawer navigation to every route.
- **Tablet 768×1024:** the rail shows, and the same no-scroll check runs for the first-wave screens.
- **Desktop 1440×900:** parity screenshots of every touched screen against the Task 1–3 baselines.
- **Keyboard:** drawer open → Tab stays inside → Escape closes → focus returns to the menu button; Ctrl/Cmd+B toggles the rail.
- **Language param:** opening `#/contacts?lang=ar` renders Arabic and RTL; navigating keeps `lang=ar`; `?lang=fr` is ignored; the toggle updates the hash.
- **Reduced motion:** with `prefers-reduced-motion: reduce` emulated, the drawer opens without a transition.
- **RTL:** in Arabic the drawer slides from the right, and back arrows point right.

**Cleanup:** delete the recorded workspace (the cascade covers seeded rows) and the test users. Residue sweep. Before/after counts: `Workspace`, `User`, `WorkspaceMember`, `Contact`, `Conversation`, `Message`, `Channel`, `Ticket`, `Appointment`, `Activity`. Every count identical. Stop :4290 and :5190; remove the outDir, `fe-dist-sp30/` and `sp30-run/`.

Then tick SP-30's boxes with the rulings and deviations. Add the follow-ups: full phone layouts for the swept routes (ruling 3), locale-file extraction if D5 changes, and the public website (D7).
