# SP-29 Organization Branding: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- **Business logo.**
  - Owners and admins (`settings.update`) upload a logo in General settings (`WorkspaceTab.tsx`).
  - Types: PNG, JPEG or WebP. **No SVG**, which can carry script (ruling 2).
  - Size: at most 2 MB, checked by declared type **and** magic bytes. The 2 MB cap is ruling 2.
  - Remove clears it.
  - Roadmap acceptance: `logo upload validates type/size`.
- **Brand colour.**
  - One `brandColor`, a `#rrggbb` hex set through a swatch plus text field. Shorthand `#rgb` is expanded, and the value is stored lower-case.
  - A contrast hint shows the derived text colour (white or near-black) used on it.
  - Tkana has primary and secondary colours; we keep the roadmap's one (ruling 3).
- **Sticky save bar.**
  - General settings gains a save bar pinned to the bottom of the settings pane (logical insets).
  - It shows "Unsaved changes" with Discard and Save **only when the form is dirty**, plus Saving and Saved states, and an error state that keeps the edits.
  - Leaving the page with unsaved edits asks first (`beforeunload` plus the in-app route change).
  - Roadmap acceptance: `save bar appears only when dirty` (vitest over a pure `saveBarState`).
- **Applied in the shell header.**
  - The sidebar workspace card's empty `ws-mark` (`Sidebar.tsx` L81-95) shows the logo, or initials on the brand colour when there is no logo.
  - The topbar breadcrumb shows the workspace name instead of the hard-coded "Samemha" (`Topbar.tsx` L25).
  - The brand colour tints only these workspace marks; the app accent stays HJZ gold (ruling 4).
- **Applied in the hosted chat page (SP-19).**
  - The page header shows the workspace logo.
  - A webchat channel with no colour of its own uses the workspace brand colour. Today's default `#111827` remains the last fallback.
  - The widget config gains `brand {name, logoUrl, color}`.
- **Applied in emails (SP-26).** The SP-26 email layout's `brand` input gets `logoUrl` (a public absolute URL) and `color`, so invitations and reset emails carry the logo and colour.
- **Fix found while planning.** After saving General settings, the shell refreshes the active workspace in place. This replaces the "Refresh to see the new name" message in `WorkspaceTab.tsx`.

**Architecture:**
- **Data.**
  - `Workspace.logoMediaId String?` is an FK to `Media`, `onDelete: SetNull`.
  - `Workspace.brandColor String?` is lower-case `#rrggbb`.
  - The logo is an ordinary `Media` row with `purpose: "brand_logo"` (ruling 5), which hides it from the media library list.
- **Upload.**
  - `POST /workspaces/:id/logo` (multipart `file`, `settings.update`) uses the existing multer disk storage. `WorkspaceBrandingService.uploadLogo` then:
    1. checks `mimetype ∈ LOGO_TYPES = image/png|image/jpeg|image/webp`, else 400 `media.unsupported_type {allowed}`;
    2. checks `size ≤ LOGO_MAX_BYTES = 2 MB`, else 400 `media.too_large {limit}`;
    3. sniffs the head (`sniff.ts`, `SNIFF_BYTES = 16`); a family that differs from the declared type gives 400 `media.type_mismatch`;
    4. calls `MediaService.finalizeUpload` with `purpose: "brand_logo"`;
    5. in one `$transaction`: `SELECT … FOR UPDATE` the workspace row, set `logoMediaId`, write `AuditLog workspace.branding_updated` (SP-26), and record the previous logo id;
    6. after commit, deletes the previous logo media row and file when nothing else references it.
  - The same error keys as SP-13 are reused (`media-errors.ts`), so the frontend copy already exists.
  - `DELETE /workspaces/:id/logo` (`settings.update`) clears the logo and deletes the media row.
- **Public logo URL** (needed by the hosted chat page and emails; no permanent public media URL exists today).
  - `GET /branding/:workspaceId/logo/:mediaId` is public.
  - It serves the bytes only when `mediaId` equals that workspace's current `logoMediaId`; anything else is 404.
  - It streams through `MediaService.sendResolved`, the SP-09 extraction, so the response is same-origin bytes and never a 302.
  - Headers:
    - `Cache-Control: public, max-age=31536000, immutable`, which is safe because a new logo gets a new `mediaId` and so a new URL;
    - `Content-Type` from the media row;
    - `X-Content-Type-Options: nosniff`;
    - `Content-Security-Policy: default-src 'none'`.
  - The URL exposes the workspace id and logo id. Neither is a secret: the hosted chat link already contains the channel id (ruling 6).
  - The absolute form `${BACKEND_PUBLIC_URL}/api/branding/…` is used in emails. The hosted page uses the relative `/api/branding/…`, which is same-origin with `/api/chat/:channelId`, so the existing CSP `img-src 'self' data:` already allows it.
- **Brand colour.**
  - `PATCH /workspaces/:id` (the existing route, `settings.update`) accepts `brandColor?: string | null`, validated by `^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$`, normalised to lower-case 6-digit, and `null` clears.
  - `UpdateWorkspaceDto` gains the field.
  - The service writes the diff and audits.
- **Workspace shape.** The workspace DTO, built in `workspaces.service.ts` around lines 66-72, gains `logoUrl: string | null` (the relative public URL) and `brandColor`. `GET /auth/workspaces` and `GET /workspaces/:id` carry it, so the shell needs no extra request.
- **Contrast.**
  - `brandInk(hex) → "#ffffff" | "#111111"` uses the WCAG relative luminance and picks whichever gives the higher contrast ratio.
  - It is shared as a pure function in `backend/src/workspaces/brand-color.ts` and `src/lib/brandColor.ts`; a test pins equality on a fixture list.
- **Chat page.**
  - `webchat.service.ts` config adds `brand: {name, logoUrl, color}`.
  - The colour resolves as channel `config.color`, then the workspace `brandColor`, then `#111827`. The existing `color` field keeps today's meaning, the resolved value, so `widget.js` needs no change.
  - `hosted-page.ts` renders the logo in the header as `<img src alt="" width=28 height=28>`, only when `logoUrl` is set. The page title stays the channel display name.
  - `chat-page.js.ts` reads `brand`.
- **Emails.** `backend/src/email/templates/layout.ts` (SP-26) renders `brand.logoUrl` as an `<img>` of at most 120×40, alt = the workspace name, and a 4 px top bar in `brand.color` with `brandInk` for any text on it. Senders build `brand` through `WorkspaceBrandingService.emailBrand(ws)`.
- **Save bar** (frontend, pure model plus a component):
  - `saveBarState({dirty, saving, error, savedAt, now}) → "hidden" | "dirty" | "saving" | "saved" | "error"`.
    - `"hidden"` when not dirty and not saving, with no error, and more than 2 s since `savedAt`.
    - `"saved"` shows for 2 s after a save.
  - `isDirty(form, initial)` compares normalised values (trimmed name; colour lower-cased; a logo change counts).
  - `SaveBar.tsx` sits in `src/screens/settings/form.tsx` beside `SettingsCard`:
    - `position: sticky; inset-block-end: 0`, full width of the 720 px pane;
    - `role="region"` with `aria-live="polite"` for the status text;
    - Discard resets to `initial`; Save calls the existing diff-only `submit()`.
    - With `readOnly` (no `settings.update`) it never renders.
  - Logo upload happens immediately on file choice through its own route, not through the save bar (ruling 7), and shows its own progress and errors.

**Tech Stack:** NestJS 10, Prisma 5 (Postgres/Neon), jest/ts-jest; React 18 + Vite, vitest. **No new dependencies.** No Anthropic/Claude code.

**Spec:** roadmap §SP-29 and the Global Constraints. Carried contracts:
- **SP-13 / SP-09:** `MediaService.finalizeUpload`, `sniff.ts`, `media-errors.ts`, `MediaService.sendResolved`, `lockMediaForReference` / `media.in_use` (a logo in use cannot be deleted from the library: `remove` adds `workspaces: [{id}]` to the 409 body).
- **SP-19:** `channels/webchat/{webchat.controller,webchat.service,hosted-page}.ts`, `assets/chat-page.js.ts`, `WebchatSettingsForm.tsx` (shows "Using workspace colour" when the channel colour is empty).
- **SP-26:** the email layout `brand` input, `AuditService.record`.
- **SP-25:** `permission-map.ts`, `system-role-decisions.spec.ts`.
- Existing:
  - `workspaces.{controller,service,dto}.ts` (`PATCH /workspaces/:id` → `settings.update`; `authorize()`);
  - `src/screens/settings/{WorkspaceTab,form}.tsx`;
  - `src/shell/{Sidebar,Topbar,WorkspaceSwitcher}.tsx`;
  - `src/auth/context.tsx` (active workspace);
  - `src/embed/skin.ts` (`skinToCssVars`, the colour-mix pattern).

Consumers:
- **SP-27:** the OAuth consent page shows the logo.
- **SP-30:** the mobile topbar shows the logo mark.

Tkana reference (read-only, untrusted data; `C:\Users\ashra\Downloads\tkana-main\tkana-main\apps\web\app`):
- `routes/settings.general.tsx`:
  - the logo is an `accept="image/*"` upload, with server-side limits only, stored as `logoUrl`; Remove sets `""`;
  - `primaryColor`/`secondaryColor` default `#5B2D8E`/`#B794D4` and are validated by `/^#([0-9a-f]{3}|[0-9a-f]{6})$/i`;
  - dirty = JSON compare of the normalised form.
- `components/shell/settings-section.tsx`: `SaveState = clean|dirty|saving|saved|error`; a footer bar with Discard/Save disabled unless dirty or error; "Unsaved changes" / "Saving…" / "Saved"; `readOnly` swaps the buttons for a lock message.

What we take and what we don't:
- We take: the hex rule, normalised dirty compare, the five save states and the read-only behaviour.
- We do **not** take:
  - two colours (ruling 3);
  - `image/*` (SVG refused);
  - an always-visible bar (ours appears only when dirty, per the roadmap acceptance);
  - storing a raw URL (ours stores a media id).

## Global Constraints
- **Data:**
  ```
  model Workspace {
    // … existing …
    /// SP-29: the business logo (a Media row with purpose "brand_logo").
    logoMediaId String?
    logoMedia   Media?  @relation("WorkspaceLogo", fields: [logoMediaId], references: [id], onDelete: SetNull)
    /// SP-29: "#rrggbb", lower-case; null = default.
    brandColor  String?
  }
  model Media {
    // … existing …
    /// SP-29: null = a library file; "brand_logo" = a workspace logo (hidden from the library list).
    purpose        String?
    workspaceLogos Workspace[] @relation("WorkspaceLogo") // Prisma-only
  }
  ```
  - `Media` has no column today that hides a file from the library (checked in `schema.prisma`: there are only the SP-17 detail fields and back-relations), so SP-29 adds `Media.purpose` (ruling 5). The library list (`MediaService.list`) and the agent's `list_photos` filter on `purpose IS NULL`.
  - **Roadmap names kept:** `Workspace.logoMediaId?`, `brandColor?`.
- **Constants** (`backend/src/workspaces/brand-constants.ts`, mirrored in `src/screens/settings/brand.ts`):
  - `LOGO_TYPES = ["image/png","image/jpeg","image/webp"]`;
  - `LOGO_MAX_BYTES = 2 * 1024 * 1024`;
  - `BRAND_COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i`;
  - `DEFAULT_CHAT_COLOR = "#111827"`;
  - `SAVED_FLASH_MS = 2000`.
- **API** (workspace-scoped; `:id` must equal the JWT workspace, otherwise **404**, the existing `authorize()`):
  - `POST /workspaces/:id/logo` (`settings.update`) → the workspace DTO;
  - `DELETE /workspaces/:id/logo` (`settings.update`) → the workspace DTO;
  - `PATCH /workspaces/:id` (`settings.update`, existing) with `brandColor?`;
  - `GET /branding/:workspaceId/logo/:mediaId` (`public`) → bytes, or 404 for any mismatch, missing or foreign id.
- **Error keys:** the SP-13 `media.unsupported_type`, `media.too_large`, `media.type_mismatch`, `media.no_file`; new `workspaces.invalid_brand_color` (400). The frontend `tx` copy covers the new key.
- **Copy and layout:**
  - `tx("English","العربية")`:
    - "Logo" / "الشعار", "Upload logo" / "رفع الشعار", "Remove" / "إزالة";
    - "PNG, JPG or WebP, up to 2 MB" / "PNG أو JPG أو WebP، حتى 2 ميغابايت";
    - "Brand colour" / "لون العلامة التجارية";
    - "Unsaved changes" / "تغييرات غير محفوظة", "Discard" / "تجاهل", "Save" / "حفظ", "Saving…" / "جارٍ الحفظ…", "Saved" / "تم الحفظ";
    - "Couldn't save. Your changes are kept." / "تعذّر الحفظ. تغييراتك محفوظة.";
    - "You have unsaved changes. Leave anyway?" / "لديك تغييرات غير محفوظة. هل تريد المغادرة؟".
  - Logical CSS (`inset-inline`, `padding-inline`, `margin-inline-start`). The hex value sits in `<bdi dir="ltr">`. The save bar's buttons sit at the inline end in both directions.
- **Permissions (SP-25).** No catalogue change. `permission-map.ts` adds:
  - `POST /workspaces/:id/logo`: `settings.update`
  - `DELETE /workspaces/:id/logo`: `settings.update`
  - `GET /branding/:workspaceId/logo/:mediaId`: `public`

  `system-role-decisions.spec.ts` adds `SP-29 branding routes`:
  - owner and admin can upload, delete and set the colour;
  - agent and viewer get 403;
  - the public logo route answers everyone.
- **Migration:**
  - `backend/prisma/migrations/20261118150000_org_branding/migration.sql`, after SP-28's `20261118140000_billing_portal`. Hand-written, LF, `SET lock_timeout = '5s'`, `migrate deploy` only; never edit an applied migration.
  - The SQL:
    ```sql
    SET lock_timeout = '5s';
    ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "logoMediaId" TEXT,
                            ADD COLUMN IF NOT EXISTS "brandColor" TEXT;
    CREATE INDEX IF NOT EXISTS "Workspace_logoMediaId_idx" ON "Workspace"("logoMediaId"); -- only if Prisma emits it; see below
    DO $$ BEGIN
      ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_logoMediaId_fkey" FOREIGN KEY ("logoMediaId")
        REFERENCES "Media"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    ALTER TABLE "Media" ADD COLUMN IF NOT EXISTS "purpose" TEXT;
    ```
  - The file contains exactly what `prisma migrate diff` emits. Prisma does not add an index for a plain FK, so the index line is dropped unless the diff shows it. Task 1 records the diff.
  - **Safe for the deployed `main`:**
    - nullable columns only;
    - `main` never reads or writes them;
    - a `main` media delete of a logo nulls the column through the FK (`SET NULL`), so there is no 500;
    - `ADD CONSTRAINT … FOREIGN KEY` on an all-null column validates instantly;
    - no `UPDATE`, `DELETE`, `DROP` or `ALTER … TYPE`.
  - **No backfill.**
- **Tests:**
  - backend: `npx jest src/workspaces src/media src/channels/webchat src/email src/permissions` + `npx tsc --noEmit -p tsconfig.json`; the full `npm test` once per task.
  - frontend: `npx vitest run`, `npm run typecheck`, `npm run build`.
  - **Named acceptance tests (exact names):**
    - `logo upload validates type/size` (backend jest, `src/workspaces/workspace-branding.service.spec.ts`)
    - `save bar appears only when dirty` (frontend vitest, `src/screens/settings/saveBar.test.ts`)
  - No external call in any spec. The email layout is tested as a pure render.
- **Commits:** selective `git add <paths>`, never `-A`. Trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not stage `.playwright-mcp/`, `.claude/worktrees/` or any untracked file this plan did not create.

## Review Focus
1. **A logo can never carry script or bloat.**
   - Only PNG, JPEG or WebP whose bytes match the declared type, at most 2 MB.
   - Served with `nosniff` and a `default-src 'none'` CSP, never as HTML or SVG.
   - Tests:
     - `logo upload validates type/size`
     - `svg and html-as-png are refused`
     - `public logo served with nosniff and immutable cache`
2. **The public route serves only the current logo.**
   - Any other media id, an old logo id, or another workspace's pairing is 404, so the public URL cannot read a library file.
   - Tests:
     - `public logo route 404 for non-logo media`
     - `old logo id is 404 after replace`
3. **Replacing a logo never orphans or breaks.**
   - Concurrent uploads leave exactly one current logo.
   - The old file is deleted only after commit and only when it is unreferenced.
   - A library delete of the current logo is refused with `media.in_use`.
   - Tests:
     - `concurrent logo uploads leave one current logo`
     - `deleting the current logo from the library is 409`
4. **Colours stay readable.**
   - Text on the brand colour uses `brandInk` (contrast ≥ 4.5 against one of the two choices for any colour).
   - The chat page keeps the channel colour when set.
   - Tests:
     - `brand ink picks the higher-contrast text colour`
     - `chat colour precedence channel > workspace > default`
5. **The save bar is honest.**
   - It is hidden when clean, shown while dirty, kept on error with the edits, and never shown read-only.
   - Tests:
     - `save bar appears only when dirty`
     - `save error keeps edits and shows error state`

## Architecture Rulings and Risks
1. **One colour or two.**
   - The roadmap says "brand colours"; Tkana has primary and secondary.
   - **Ruling:** one `brandColor`. Nothing in our shell, chat page or emails uses a second colour, and the derived ink covers text contrast.
   - **Alternative:** add `brandColorSecondary` now. **(needs controller ruling, minor)**
2. **Logo limits.**
   - **Ruling:** PNG, JPEG or WebP; 2 MB; no SVG (stored-XSS risk on a public route); no GIF (animation in the shell).
   - Dimensions are not enforced. The UI renders the logo with `object-fit: contain` in fixed boxes.
   - **Alternative:** sanitised SVG (needs a sanitiser dependency). **(needs controller ruling)**
3. **Where the brand colour applies in the app.**
   - **Ruling:** only the workspace marks (the sidebar card and switcher avatars). The app's accent stays HJZ gold, because overriding `--accent` for every screen risks low-contrast UI with an arbitrary customer colour.
   - **Alternative:** override `--accent`/`--accent-soft`/`--accent-ring` app-wide with `skinToCssVars` (the embed precedent) behind a "Use brand colour in the app" toggle. **(needs controller ruling)**
4. **Shell header.**
   - **Ruling:** the logo in the sidebar workspace card and the switcher. The topbar breadcrumb shows the workspace name (fixing the hard-coded "Samemha"). The Kewy product logo (`BrandLogo`) stays at the top of the sidebar, because the product brand and the business brand are different things.
   - **(needs controller ruling, minor)**
5. **How the logo media is hidden from the library.**
   - `Media` has no "hidden" column today.
   - **Ruling:** add `Media.purpose String?` (nullable, additive), and filter `purpose IS NULL` in the library list and in `list_photos`, so a logo is never offered to the agent.
   - The deployed `main` would list a logo in the library, but logos can only exist once SP-29 is deployed, so there is no overlap.
   - **Alternative:** keep logos outside `Media`, with their own storage path and table. That duplicates storage code. **(needs controller ruling, minor)**
6. **A public, unauthenticated logo URL.**
   - **Ruling:** `GET /branding/:workspaceId/logo/:mediaId`, which serves only the current logo, cached as immutable. The workspace id becomes visible to anyone who sees the chat page or an email. Accepted: ids are not secrets, and the route reveals nothing else.
   - **Alternative:** a long-lived signed token in the URL (`mintPublicToken` with a far expiry). That breaks the immutable cache and needs rotation. **(needs controller ruling)**
7. **The logo saves on choose, not through the save bar.**
   - **Ruling:** upload immediately, with its own progress and errors, because multipart files do not fit the JSON diff patch. Remove asks for confirmation. The save bar covers name, timezone, language and colour.
   - **Alternative:** stage the file and upload on Save. **(needs controller ruling, minor)**
8. **Order with SP-26 emails.**
   - SP-26 ships the email layout with `brand?: {name}`. SP-29 fills `logoUrl` and `color`.
   - If SP-29 lands first, emails do not exist yet and Task 1 skips the email hook, noting it in the roadmap.
   - **(needs controller ruling, minor)**
9. **Shared files** with SP-26/27/28: `schema.prisma`, `permission-map.ts`, `system-role-decisions.spec.ts`, `media.service.ts` (`remove` gains `workspaces` in `media.in_use`), `Settings.tsx`, `Sidebar.tsx`.
   - **Ruling:** base on the SP-28 ship commit. Task 1 owns the schema. The migration applies after SP-28's. **(needs controller ruling)**
10. **Verification touches production.**
    - Task 3 runs on the production DB in throwaway workspaces with local storage and no provider.
    - The migration needs the user's **explicit approval**.
    - **(needs controller ruling)**
11. **Size.** S: 2 build tasks plus verification. **(needs controller ruling, minor)**

### Controller rulings
*Decided 2026-11-17 by the controller: R1–R11 accepted as proposed. R8: SP-26 has shipped, so fill its email brand. R9: SP-28 is still in review, so base on the current feat/tkana-parity head; the migration name already sorts after SP-28’s 20261118140000 and pins only folders present in the base (SHA in the ledger). The migration `20261118150000_org_branding` needs explicit user approval before it runs.*
- **R1** (one brand colour): accepted
- **R2** (PNG/JPEG/WebP ≤ 2 MB, no SVG/GIF): accepted
- **R3** (brand colour on workspace marks only; app accent unchanged): accepted
- **R4** (logo in the sidebar card and switcher; breadcrumb shows the workspace name): accepted
- **R5** (add `Media.purpose`; library and `list_photos` show only `purpose IS NULL`): accepted
- **R6** (public current-logo route, immutable cache): accepted
- **R7** (logo uploads on choose; save bar for the other fields): accepted
- **R8** (fill the SP-26 email brand; skip if SP-26 has not shipped): accepted
- **R9** (base on the SP-28 ship commit; Task 1 owns the schema): accepted
- **R10** (verification on the production DB, local storage; migration needs explicit user approval): accepted
- **R11** (size S; 2 build tasks + verification): accepted

---

### Task 1: Backend — schema, migration, logo upload and public serving, brand colour, chat page and email brand
**Owns:** `schema.prisma` and the migration for all of SP-29.

**Files:**
- `backend/prisma/schema.prisma`; `migrations/20261118150000_org_branding/migration.sql`; `backend/src/workspaces/org-branding-migration.spec.ts`.
- Create in `backend/src/workspaces/`, each with a spec:
  - `brand-constants.ts`, `brand-color.ts` (`normalizeBrandColor`, `brandInk`, `contrastRatio`);
  - `workspace-branding.service.ts` (`uploadLogo`, `removeLogo`, `serveLogo`, `emailBrand`);
  - `branding-public.controller.ts` (`@Public`).
- `workspaces.controller.ts` (logo routes, before any `:id` catch-all), `workspaces.dto.ts` (`brandColor`), `workspaces.service.ts` (DTO shape `logoUrl`, `brandColor`; audit).
- `backend/src/media/media.service.ts`:
  - `remove` refuses when the media is a current logo (409 `media.in_use {workspaces}`);
  - the library list and `list_photos` exclude non-null `purpose` (ruling 5), with a spec `logo is not in the library or the agent photos`.
- `backend/src/channels/webchat/{webchat.service,hosted-page}.ts`, `assets/chat-page.js.ts`: `brand` and the colour precedence.
- `backend/src/email/templates/layout.ts` (if SP-26 shipped) and its callers: `emailBrand`.
- `permission-map.ts` + spec; `system-role-decisions.spec.ts` (`SP-29 branding routes`).

- [ ] Write the failing tests:
  - `migration is additive, idempotent and Prisma-named (SP-29)` (the folder name is greater than `20261118140000`; earlier sha256 values pinned; matches the `prisma migrate diff` output).
  - **`logo upload validates type/size`**:
    - a real PNG of 10 KB → stored, `logoMediaId` set, DTO `logoUrl` = `/api/branding/<ws>/logo/<media>`;
    - a JPEG and a WebP → accepted;
    - an SVG → 400 `media.unsupported_type`;
    - a GIF → 400 `media.unsupported_type`;
    - a 2 MB + 1 byte PNG → 400 `media.too_large {limit: 2097152}`;
    - HTML bytes declared `image/png` → 400 `media.type_mismatch`;
    - no file → 400 `media.no_file`;
    - nothing is stored on any refusal (the storage fake records zero writes).
  - `svg and html-as-png are refused` (also through the controller with the multer limits).
  - `public logo served with nosniff and immutable cache`; `public logo route 404 for non-logo media` (a library image of the same workspace, a foreign workspace's logo id with this workspace id, an unknown id); `old logo id is 404 after replace`.
  - `concurrent logo uploads leave one current logo` (two uploads through the row lock → one current; the other's media deleted after commit); `deleting the current logo from the library is 409`.
  - `brand colour normalised and validated` (`#ABC` → `#aabbcc`; `red`, `#12345`, `#gggggg` → 400 `workspaces.invalid_brand_color`; `null` clears).
  - `brand ink picks the higher-contrast text colour` (fixture: `#ffffff` → `#111111`, `#000000` → `#ffffff`, `#c9a55a`, `#5b2d8e`, `#ffff00`; each chosen pair ≥ 4.5:1).
  - `chat colour precedence channel > workspace > default`; `hosted page shows the logo only when set`.
  - `email layout renders logo and colour bar` (pure render; alt = workspace name; absolute URL from `BACKEND_PUBLIC_URL`).
  - `permission map covers SP-29 routes`; the system-role block.
- [ ] Implement until green; tsc; jest; the full `npm test` once; `npx prisma generate`. **Do not run `migrate`.**
- [ ] Commit `feat(branding): workspace logo and brand colour, public logo route, chat page and email branding`.

### Task 2: Frontend — General settings branding, sticky save bar, shell
**Depends on:** Task 1's contract.

**Files:**
- **F1 Model (pure):**
  - `src/screens/settings/saveBar.ts` (`saveBarState`, `isDirty`, `normalizeForm`);
  - `src/screens/settings/brand.ts` (constants, `validateLogoFile(file) → error key | null` for name/type/size before upload);
  - `src/lib/brandColor.ts` (mirror of `normalizeBrandColor`, `brandInk`).
  - Tests: `saveBar.test.ts`, `brand.test.ts`, `brandColor.test.ts`.
- **F2** `src/screens/settings/form.tsx`: `SaveBar` (sticky, logical insets, `aria-live`, `dir` inherited).
- **F3** `src/screens/settings/WorkspaceTab.tsx`:
  - a Branding card: logo preview in a 64 px box with `object-fit: contain`, Upload (`accept="image/png,image/jpeg,image/webp"`), Remove with confirm, progress, the media error copy;
  - a brand colour swatch (`input type=color`) plus a hex text field with an inline error and a preview of the ink;
  - the save bar replaces the card-footer Save;
  - `beforeunload` and a route-change confirm while dirty;
  - after a save, update the active workspace in `src/auth/context.tsx` (a new `refreshWorkspace()`), so the name, logo and colour update without a reload.
- **F4 Shell:**
  - `Sidebar.tsx` `ws-mark`: the logo `<img alt="">`, or initials on `brandColor` with `brandInk`;
  - `WorkspaceSwitcher.tsx`: the same mark per workspace;
  - `Topbar.tsx`: the breadcrumb shows the workspace name.
- **F5** `src/screens/channels/WebchatSettingsForm.tsx`: when the channel colour is empty, show "Uses the workspace brand colour" / "يستخدم لون العلامة التجارية لمساحة العمل".
- **F6 Types:** `src/lib/types.ts` `Workspace` gains `logoUrl`, `brandColor`.

- [ ] Write the failing vitest tests:
  - **`save bar appears only when dirty`**:
    - clean → `hidden`;
    - after a name edit → `dirty`;
    - editing back to the original value (including whitespace-only differences and colour case `#ABCDEF` vs `#abcdef`) → `hidden`;
    - saving → `saving`;
    - success → `saved` for 2 s, then `hidden`;
    - read-only → always `hidden`.
  - `save error keeps edits and shows error state` (error with dirty form → `error`; after Discard → `hidden`).
  - `logo file validated before upload` (type, 2 MB boundary, the SVG refusal, mirroring the backend keys).
  - `brand colour mirror matches the backend fixtures`.
- [ ] Implement; `npx vitest run`, `npm run typecheck`, `npm run build` clean.
- [ ] Commit `feat(branding): logo and colour in general settings, sticky save bar, branded shell`.

### Task 3: Verification
Apply `20261118150000_org_branding` only with explicit controller and user approval (ruling 10). Results go to `.superpowers/sdd/2026-11-18-sp29-org-branding/live-verification.md` (SP-15 format).

**Before approval (read-only):** `SELECT count(*) FROM "Workspace"`, `SELECT count(*) FROM "Media"`.

**Isolation** (scratchpad `C:\Users\ashra\AppData\Local\Temp\claude\7b75a64029a712a6\ebb2057a-6300-4548-9aec-b98487880afb\scratchpad\`):
- `launch-sp29.js` (from `launch-sp28.js`): backend **:4280**, outDir `backend/.verify-dist-sp29`, working directory `sp29-run/` (`LocalStorage` writes to `sp29-run/uploads`). Crons disabled.
- Every `DO_SPACES_*` is empty, so nothing reaches the real bucket.
- Email (SP-26): `EMAIL_PROVIDER=resend` with the loopback stub `RESEND_API_BASE=http://127.0.0.1:4279` (`email-stub-sp29.js`, from SP-26's), to check the branded invite email body.
- Zernio, Meta, l, OpenAI, Stripe, HJZ, Kewy: every key and base URL is an empty string.
- The launcher refuses to start otherwise. The egress guard stays, and `blocked-egress-sp29.jsonl` must be empty.
- Test tag `zz-verify-<ts>`.

**Setup** (ids in `verify-created-sp29.json`): workspace A (owner, admin, agent, viewer) with a webchat channel with no colour and a second one with `#0ea5e9`; workspace B (foreign owner). Record before-counts.

**Checks:**
- **Migration:** the columns and FK exist; every pre-existing workspace has null branding.
- **`logo upload validates type/size` (live):**
  - PNG, JPEG and WebP are accepted;
  - SVG, GIF, 2 MB + 1 byte and HTML-as-PNG are refused with the exact keys;
  - after each refusal, `sp29-run/uploads` holds no new file.
- **Public route:**
  - `GET /api/branding/<A>/logo/<id>` → bytes (hash equal), `nosniff`, `immutable`, no auth;
  - B's id with A's logo → 404; A's library image id → 404;
  - after a replace, the old id → 404.
- **Concurrency:** two uploads in parallel → one `logoMediaId`, and the other media row is gone.
- **Library:** the logo is absent from `GET /media`; `DELETE /media/<logo>` → 409 `media.in_use` with the workspace.
- **Colour:** `#ABC` → stored `#aabbcc`; `red` → 400.
- **Chat page:**
  - `GET /api/chat/<channel without colour>` shows the logo `<img>` and `--wc` equal to the brand colour;
  - the second channel keeps `#0ea5e9`;
  - the CSP header is unchanged, and the image loads with no CSP violation in the browser console (verify skill).
- **Email:** an SP-26 invite → the stub body contains the absolute logo URL and the colour bar.
- **Roles:** agent and viewer get 403 on upload, delete and colour.
- **Migration rerun** in an always-rolled-back transaction.
- **UI through the `verify` skill:**
  - General settings with the save bar appearing only after an edit, Discard, Save → "Saved" → hidden;
  - leave-with-unsaved prompt;
  - logo upload and remove;
  - the sidebar mark and switcher, the topbar workspace name;
  - English and Arabic (RTL), with the save bar's buttons at the inline end;
  - screenshots.

**Cleanup:** delete the recorded workspaces (the cascade covers media rows, channels and members), the test users, `sp29-run/uploads` and the stub log. Residue sweep. Before/after counts: `Workspace`, `User`, `WorkspaceMember`, `Media`, `Channel`, `AuditLog`, `Invitation`. Every count identical. Stop :4280 and the stub; remove the outDir and `sp29-run/`.

Then tick SP-29's boxes with rulings and deviations. Deferred: a second brand colour, an app-wide brand accent (ruling 3), SVG logos.
