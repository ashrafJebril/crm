# SP-26 Members, Invites, Handover and Security: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- **Email invitations.**
  - An owner or admin invites by email with a role. The role travels with the invitation (`Invitation.roleId`).
  - The invitee gets a single-use link. The token is hashed at rest and expires after 7 days (ruling 2). It is accepted on a public accept page (sign up, or sign in and join).
  - The Members list gains an **All / Active / Pending** filter with a pending count, **Resend** and **Revoke**.
  - Roadmap acceptance: `invite token single-use and expires`.
- **Handover on removal.**
  - Removing a member first previews their open work: open conversations, open tickets (deals, leads, support), open follow-ups and owned contacts.
  - If any exists, a `handoverTo` member is required. All the work moves in one transaction, then the membership is deleted.
  - Roadmap acceptance: `delete-member-with-references requires handoverTo when open work > 0` (Review Focus 2).
- **No-workspace page.** A signed-in user with no membership sees a page listing their pending invitations ("Join") and a "Create a workspace" action, instead of being logged out (ruling 6).
- **Activation links by slug.** `#/activate?ws=<slug>&next=<route>` switches to that workspace when the user is a member, or explains they have no access. `next` is limited to a known `RouteId` (no open redirect).
- **Team audit log.**
  - `AuditLog` rows record every member, invitation, role, handover and security event.
  - The Team "Activity" tab reads them, replacing the mock `ACTIVITY` data.
- **Forgot / reset password.**
  - A public "Forgot password" form always returns 202, whether or not the email exists.
  - The emailed link carries a single-use token, hashed at rest, valid for 30 minutes.
  - A reset sets the new password, bumps the user's session version (all old JWTs stop working, ruling 4) and audits.
  - Roadmap acceptance: `reset token hashed and single-use`.
- **2FA (TOTP).**
  - Members enrol from their profile: secret shown once as text plus a QR code (ruling 3), confirm with a code, and receive 10 recovery codes shown once.
  - Once enabled, password login returns a challenge, and only a valid TOTP or recovery code completes it.
  - Owners see who is enrolled. They cannot read or reset anyone's secret; an owner may only **reset** a member's 2FA, which is audited.
  - Roadmap acceptance: `2FA required at login once enabled`.
- **Replace the Team mocks.** `src/screens/Team.tsx` Pending tab, Activity tab, 2FA stat and column, and the InviteModal become real. `src/data/team-extras.ts` loses `PENDING_INVITES` and `ACTIVITY`.
- **Admin-sets-password stays.** `PATCH /workspaces/:id/members/:userId/password` and `POST /workspaces/:id/invite` with `password` keep working (roadmap). Both are now audited.

**Architecture:**
- **Email port** (`backend/src/email/`). The repo has no mail code or mail dependency today.
  - `EmailSender` interface: `send({to, subject, html, text, tag}) → {id}`.
  - `ResendEmailSender` calls the Resend REST API with plain `fetch`, so no SDK dependency. It uses `RESEND_API_BASE` (default `https://api.resend.com`), `RESEND_API_KEY` and `EMAIL_FROM`.
  - `DisabledEmailSender` throws `email.not_configured`, and the UI then shows the link-copy fallback (ruling 1).
  - The provider is picked by `EMAIL_PROVIDER=resend|off` (default `off`). D3 decides the provider; the port keeps that decision to one file.
  - **The email body, the token and the link are never logged.** Logs carry only `{tag, toDomain, providerId}`.
  - Templates live in `backend/src/email/templates/{invite,reset,two-factor-reset}.ts` as pure functions `render(input, lang) → {subject, html, text}`, with English and Arabic (`dir="rtl"`).
  - The layout accepts `brand?: {name, logoUrl?, color?}`. SP-29 fills `logoUrl`/`color`; SP-26 passes `{name}` only.
- **Tokens.**
  - Invite and reset tokens are `randomBytes(32).toString("base64url")`. Only `sha256(token)` hex is stored (`tokenHash @unique`).
  - Lookup is by hash, so there is no timing oracle on the secret. A token is valid when `usedAt/acceptedAt IS NULL AND revokedAt IS NULL AND expiresAt > now()`.
  - Consumption is one conditional `updateMany({where:{id, acceptedAt:null, revokedAt:null, expiresAt:{gt:now}}, data:{acceptedAt:now}})`; `count === 0` → 410 `invitations.invalid`. Two concurrent accepts: exactly one wins.
- **Invitations** (`backend/src/members/invitations.service.ts`).
  - `create(ws, actor, {email, roleId, lang})`:
    - normalises the email (trim and lower-case);
    - refuses an existing member (409 `invitations.already_member`);
    - refuses a role above the actor's own (`PermissionService.assertCanGrant`), and only an owner may invite into the owner role;
    - refuses a second pending invite for the same email (409 `invitations.pending_exists`, checked under `pg_advisory_xact_lock(hashtext(workspaceId || email))`);
    - stores the row, sends the email, and audits `invitation.created`.
  - The response never contains the token, unless email is `off`, in which case it returns `{link}` once for the inviter to copy (ruling 1).
  - `resend`: rotates the token (new hash, new `expiresAt`), at most 5 sends per invitation and 1 per minute (429 `invitations.resend_limited`).
  - `revoke`: sets `revokedAt` and is idempotent.
  - `preview(token)` (public): `{workspaceName, roleName, emailMasked, expiresAt, existingAccount: boolean}`. An invalid, expired, revoked or used token gives one 410 `invitations.invalid`.
  - `accept(token, {name?, password?}, signedInUser?)`:
    - Signed out with no account → creates the user (bcrypt 10, like `auth.service.ts`).
    - Signed out with an existing account → 409 `invitations.sign_in_required` (the page then shows sign-in with the email locked).
    - Signed in → the user's email must equal the invitation's, else 403 `invitations.email_mismatch`.
    - In one transaction it consumes the token, upserts the `WorkspaceMember` with `roleId` plus the legacy `role` string (the role's `key` for system roles, `agent` for custom roles, as SP-25 does), and audits `invitation.accepted`.
    - If the role was deleted before acceptance, the member gets the system `viewer` role and the audit meta says `rolePending: true` (Tkana precedent).
    - It returns the normal login payload (`issue()`), with the active workspace set to the invited one.
- **Handover** (`backend/src/members/handover.service.ts`).
  - `openWork(ws, userId) → {conversations, tickets: {deals, leads, support}, followUps, contacts, bookings}`, counted with:
    - `Conversation.assigneeId = userId AND status NOT IN ('resolved','closed','spam')`;
    - `Ticket.ownerId = userId AND closedAt IS NULL`, split by `Pipeline.kind`;
    - `Activity.assigneeId = userId AND doneAt IS NULL`;
    - `Contact.ownerId = userId`;
    - `bookings` (info only, ruling 7): `Appointment.staffId = userId AND status IN ('pending','confirmed') AND startAt >= now()`.
  - `canReceive(ws, recipientId, kinds)`:
    - The recipient is a member, not the leaver, and not blocked.
    - Their role holds `conversations.update` (if conversations > 0), `tickets.update` (if tickets > 0) and `contacts.update` (if contacts > 0).
    - Otherwise 409 `members.handover_refused {reason: "not_member"|"same_member"|"missing_permission", resource}`.
    - Reassignment makes conversations visible to an `assigned`-visibility recipient, so visibility is not a refusal reason.
  - `removeWithHandover(ws, actor, userId, handoverTo?)` runs one Serializable `$transaction` (the existing `removeMember` isolation level):
    1. Re-check the actor (`assertCanActOn`, `assertAnotherOwner`).
    2. Recount open work inside the transaction.
    3. If the count > 0 and there is no `handoverTo` → 409 `members.handover_required {openWork}`.
    4. Otherwise:
       - `UPDATE … SET assigneeId|ownerId = handoverTo` for each kind (conversations also bump `version`, the SP-01 contract);
       - delete the membership;
       - write one `AuditLog` `member.removed` with `{handoverTo, moved: counts}`.
  - After commit:
    - one `NotificationsService.notify([handoverTo], {type:"assignment", title:"Work handed over to you", body: counts})` (one summary, not one per item);
    - realtime `inbox.activity` for the workspace;
    - `PermissionService.invalidate`.
  - `DELETE /workspaces/:id/members/:userId` keeps its path and gains the optional body `{handoverTo}`. With no open work it behaves as today.
  - `handOver(ws, actor, userId, handoverTo)` moves work **without** removing the member, for an "On leave" case. It uses the same transaction minus the delete.
- **Audit log** (`backend/src/audit/audit.service.ts`, a global module).
  - `record(tx | prisma, {workspaceId, actorId?, actorKind: "user"|"system"|"api_key", action, targetKind, targetId?, meta?})`. It is called **inside** the writer's transaction where one exists, so a rolled-back change leaves no row.
  - `meta` never contains secrets, tokens, passwords or full emails of non-members (`emailMasked` only).
  - Actions:
    - invitations: `invitation.created|resent|revoked|accepted`;
    - members: `member.added|role_changed|removed|work_handed_over|password_set_by_admin`;
    - roles: `role.created|updated|deleted`;
    - workspace: `workspace.settings_updated`;
    - security: `security.2fa_enabled|2fa_disabled|2fa_reset_by_owner|password_reset`.
  - User-level security events are written to **every** workspace the user belongs to (ruling 8).
  - `GET /workspaces/:id/audit?cursor&action&actorId&from&to` returns 50 rows per page, ordered `(createdAt desc, id desc)`, with the actor name.
- **Password reset** (`backend/src/auth/password-reset.service.ts`).
  - `POST /auth/password/forgot {email, lang}` is public and always 202.
    - Only a user with a local password gets a link: `password IS NOT NULL` and not Kewy-managed (ruling 5).
    - At most 3 live reset rows per user; older ones get `usedAt = now()`.
    - Rate limits: 5 per hour per email hash and 20 per hour per IP (`SlidingWindowLimiter`, `common/rate-limit.ts`).
  - `POST /auth/password/reset {token, password}` is public.
    - The password is at least 8 characters (the existing `LoginDto` min 6 stays for login).
    - It consumes the token with the conditional `updateMany`, sets the bcrypt hash and increments `User.sessionVersion`, all in one transaction.
    - It also clears `rememberedPassword` client-side (Task 3) and audits `security.password_reset`.
    - It does **not** log in automatically; the user signs in, and 2FA still applies.
  - `POST /auth/change-password` also bumps `sessionVersion` and returns a fresh token.
- **Session version (ruling 4).**
  - The JWT gains `sv` (the user's `sessionVersion`).
  - `AuthGuard` compares `payload.sv ?? 0` with the user's current value, through a per-process 30 s cache (the `PermissionService` pattern). A mismatch gives 401.
  - The cache is invalidated in-process on bump; other processes catch up within 30 s (accepted).
  - Tokens issued by the deployed `main` carry no `sv` and read as 0, so they stay valid until the first bump.
  - Impersonation and SSO tokens carry `sv` too.
- **TOTP** (`backend/src/auth/totp.ts`, `two-factor.service.ts`).
  - RFC 6238 (SHA-1, 6 digits, 30 s, ±1 step window), written on `node:crypto` HMAC with a base32 codec (ruling 3: no `otplib`). It is tested against the RFC 6238 Appendix B vectors.
  - Replay guard: `User.totpLastStep` stores the last accepted step; a code for a step ≤ it is refused.
  - **Enrol:**
    - `POST /auth/2fa/setup` (authenticated) creates a 20-byte secret, stores it encrypted as `User.totpPendingEnc` (`encryptSecret`, the SP-19 R5 pattern), and returns `{secret (base32), otpauthUrl}` once.
    - `POST /auth/2fa/enable {code}`:
      - verifies against the pending secret;
      - moves it to `totpSecretEnc`, sets `twoFA = true` (the existing column) and `totpEnabledAt`;
      - generates 10 recovery codes (`xxxx-xxxx`, base32), stores bcrypt hashes in `totpRecoveryHashes`, and returns them once;
      - audits.
    - In production, setup refuses with 503 `auth.encryption_unavailable` when `TOKEN_ENC_KEY` is not set (as `channel-credentials.ts` does).
  - **Disable:** `POST /auth/2fa/disable {password, code}` clears every TOTP field, sets `twoFA = false`, bumps `sessionVersion` and audits.
  - **Login:**
    - `finishLogin` checks `twoFA`. When true, it returns `{twoFactorRequired: true, challenge}` instead of the session.
    - `challenge` is a JWT `{sub, purpose:"2fa", sv, exp: 5 min}`, signed with the normal secret and **refused by `AuthGuard`** (purpose check).
    - `POST /auth/2fa/verify {challenge, code | recoveryCode}` (public, 10 tries per challenge `sub` per 15 min) issues the normal login payload.
    - A recovery code is single-use: its hash is removed in the same conditional update.
  - **Owner reset:**
    - `POST /workspaces/:id/members/:userId/2fa/reset` (`members.manage`) clears 2FA only when the target belongs to no other workspace (the `resetMemberPassword` rule; super-admin bypass).
    - It bumps `sessionVersion`, sends the `two-factor-reset` email and audits.
  - **SSO logins** (HJZ, Kewy, Tiremall) do not ask for TOTP (ruling 9). The identity provider is trusted, as today.
- **No-workspace page.**
  - `finishLogin` today auto-creates a workspace when a user has no membership (`auth.service.ts` L208-226).
    - That stays for `POST /auth/register`.
    - For **login**, a user who has a pending invitation, or who had memberships before (any `AuditLog member.removed` with `targetId = user`), now gets a session with `activeWorkspaceId: null` instead (ruling 6).
  - `GET /auth/invitations` (authenticated, membership-exempt) lists pending invitations for the user's email.
  - `POST /auth/invitations/:id/accept` (authenticated) accepts by id for a signed-in user whose email matches. It goes through the same `accept` code.
  - The frontend renders `NoWorkspace.tsx` when `workspaces` is empty, instead of clearing the token (`src/auth/context.tsx` L109-113).
- **Activation link.**
  - `GET /auth/workspaces/by-slug/:slug` (authenticated, membership-exempt) → `{id, name, member: boolean}`. A non-member gets `member: false` and a **404 for an unknown slug**; a non-member never sees the name of a workspace they do not belong to (ruling 10).
  - The frontend `#/activate?ws=<slug>&next=<RouteId>` calls it, then `POST /auth/switch-workspace`, then navigates to `next` when it is a known `RouteId` (else `dashboard`).

**Tech Stack:** NestJS 10, Prisma 5 (Postgres/Neon), jest/ts-jest; React 18 + Vite, vitest. **New dependency, needs approval:** `qrcode` (frontend, renders the otpauth QR locally; ruling 3). No email SDK (plain `fetch`), no `otplib`.

**Spec:** roadmap §SP-26, D3 (email provider), D9 (TOTP library), the Global Constraints, and Review Focus 1 and 2. Carried contracts:
- **SP-25:** `Role`, `WorkspaceMember.roleId`, `PermissionService.{effective, can, assertCanGrant, assertOwner, invalidate, membersWith}`, `permission-map.ts` + `permission-map.spec.ts` (every route mapped; `@Public()` routes exactly `"public"`), `system-role-decisions.spec.ts`, `permission-sidedoors.spec.ts`, `membershipExempt()` (`/auth/*`, `/admin/*`, `GET/POST /workspaces`).
- **SP-01:** `Conversation.assigneeId`, `version` (handover bumps it).
- **SP-02:** `Contact.ownerId`.
- **SP-04:** `Activity.assigneeId`, `doneAt`.
- **SP-07/08:** `Ticket.ownerId` (plain string), `closedAt`, `Pipeline.kind`.
- **SP-05:** `NotificationsService.notify`, type `assignment`.
- **SP-19 R5:** `backend/src/common/token-crypto.ts` (`encryptSecret`, `decryptSecret`, `isTokenEncryptionEnabled`); production refuses to store a secret without `TOKEN_ENC_KEY`.
- Existing: `backend/src/auth/{auth.controller,auth.service,auth.guard,dto}.ts`, `workspaces.{controller,service,dto}.ts` (`inviteByEmail` L204-259, `removeMember` L434-451, `resetMemberPassword` L400-432), `common/rate-limit.ts` (`SlidingWindowLimiter`), `src/auth/{Login,context}.tsx`, `src/main.tsx` (fragment handling before mount), `src/screens/Team.tsx`, `src/screens/settings/MembersTab.tsx`, `src/data/team-extras.ts`.

Consumers that build on this plan:
- **SP-29:** the email layout's `brand` (logo, colour).
- **SP-27:** `AuditLog` (`actorKind: "api_key"`), the session version (OAuth grants are revoked when a member is removed), and `members.ai_tools_blocked`.
- **SP-28:** billing emails reuse the email port; `AuditLog` records plan changes.
- **SP-30:** the public pages (accept, reset, no-workspace, activate) are among the 390 px screens.

Tkana reference (read-only, untrusted data; `C:\Users\ashra\Downloads\tkana-main\tkana-main\apps`):
- `web/app/routes/settings.members.tsx`:
  - filter `all | active | pending` with a pending count;
  - the `inviteRefusal` rule: only an owner invites an owner, and nobody invites above their own role;
  - intent permissions: invite `create`, role `update`, hand over `update`, remove `delete`, revoke `delete`.
- `web/app/components/settings/member-handover-dialog.tsx`, `routes/settings.members.open-work.ts`, `api/src/features/team/reassign-work.ts`:
  - The preview returns counts and a refusal as data.
  - One transaction moves conversations, cards and follow-ups. Follow-ups the recipient cannot open go to the earliest owner.
  - One `work.reassigned` event per recipient (no per-item notification).
  - Work moves before the member is removed.
- `routes/accept-invite.tsx`: signed out → sign up or sign in with the email locked; signed in → match by invitation, accept, set active.
- `routes/select-org.tsx`: one membership → enter; a lone pending invite → ask "Join" (never auto-accept); several → picker; none → setup.
- `routes/org.activate.ts`, `lib/org-activation.ts`: slug must match, `next` sanitised (same app, no `//`, `\`, encoded separators).
- Tkana delegates reset and 2FA to Clerk; there is no reference flow for them. Ours follows OWASP (reset tokens hashed, single-use, short-lived; generic responses) and RFC 6238.

What we take and what we don't:
- We take: the invite-refusal rule, the pending filter, preview-then-move handover with refusal reasons, work moved before removal in the same transaction, one summary notification, the select-org/no-workspace states, slug activation with a strict `next`.
- We do **not** take:
  - Clerk, or any third-party identity provider;
  - auto-moving follow-ups to the earliest owner (ours needs one explicit `handoverTo`; ruling 7);
  - a `/:lang/` path prefix (SP-30 decides language in the URL);
  - Clerk-managed invitation expiry (ours is 7 days).

## Global Constraints
- **Data (exact names; later SPs build on them):**
  ```
  model Invitation {
    id           String    @id @default(cuid())
    workspaceId  String
    workspace    Workspace @relation("WorkspaceInvitations", fields: [workspaceId], references: [id], onDelete: Cascade)
    email        String    // normalised: trimmed, lower-case
    roleId       String?
    role         Role?     @relation("RoleInvitations", fields: [roleId], references: [id], onDelete: SetNull)
    lang         String    @default("ar") // "ar" | "en": email and accept-page language
    tokenHash    String    @unique // sha256 hex of the emailed token
    expiresAt    DateTime
    acceptedAt   DateTime?
    acceptedById String?
    acceptedBy   User?     @relation("InvitationAcceptedBy", fields: [acceptedById], references: [id], onDelete: SetNull)
    revokedAt    DateTime?
    invitedById  String?
    invitedBy    User?     @relation("InvitationInvitedBy", fields: [invitedById], references: [id], onDelete: SetNull)
    sendCount    Int       @default(1)
    lastSentAt   DateTime  @default(now())
    createdAt    DateTime  @default(now())

    @@index([workspaceId, email])
    @@index([email])
  }

  model AuditLog {
    id          String    @id @default(cuid())
    workspaceId String
    workspace   Workspace @relation("WorkspaceAuditLogs", fields: [workspaceId], references: [id], onDelete: Cascade)
    actorId     String?   // no FK: the log outlives the user
    actorKind   String    @default("user") // "user" | "system" | "api_key"
    action      String
    targetKind  String    // "member" | "invitation" | "role" | "workspace" | "user"
    targetId    String?
    meta        Json?
    createdAt   DateTime  @default(now())

    @@index([workspaceId, createdAt])
    @@index([workspaceId, action, createdAt])
  }

  model PasswordReset {
    id          String    @id @default(cuid())
    userId      String
    user        User      @relation("UserPasswordResets", fields: [userId], references: [id], onDelete: Cascade)
    tokenHash   String    @unique
    expiresAt   DateTime
    usedAt      DateTime?
    requestedIp String?
    createdAt   DateTime  @default(now())

    @@index([userId, createdAt])
  }

  model User {
    // … existing fields unchanged (twoFA Boolean stays and now means "TOTP enabled") …
    totpSecretEnc      String?   // enc:v1:… (token-crypto); never returned
    totpPendingEnc     String?   // enrolment in progress
    totpEnabledAt      DateTime?
    totpLastStep       Int?      // replay guard (Int fits until year 6053 at 30 s steps)
    totpRecoveryHashes String[]  @default([])
    sessionVersion     Int       @default(0)
  }
  ```
  - Back-relations on `Workspace` (`invitations`, `auditLogs`), `Role` (`invitations`) and `User` (`passwordResets`, `invitationsSent`, `invitationsAccepted`) are Prisma-only.
  - **Roadmap names kept:** `Invitation {email, roleId, tokenHash, expiresAt, acceptedAt?, revokedAt?}`, `AuditLog {actorId, action, target, meta, createdAt}` (`target` is split into `targetKind`/`targetId`; ruling 8), `User.totpSecretEnc?`, `PasswordReset {userId, tokenHash, expiresAt}`.
  - `Workspace.slug @unique` **already exists**, so there is no change.
- **Constants** (`backend/src/members/members-constants.ts`):
  - `INVITE_TTL_MS = 7 d`, `INVITE_RESEND_MAX = 5`, `INVITE_RESEND_GAP_MS = 60 s`;
  - `RESET_TTL_MS = 30 min`, `RESET_LIVE_MAX = 3`, `PASSWORD_MIN = 8`;
  - `TOTP_STEP_S = 30`, `TOTP_WINDOW = 1`, `RECOVERY_CODES = 10`, `TWO_FA_CHALLENGE_TTL_S = 300`;
  - `AUDIT_PAGE = 50`.
- **DTOs:**
  - `CreateInvitationDto {email: IsEmail, roleId: string, lang?: "ar"|"en"}`.
  - `AcceptInvitationDto {token: string (43 chars base64url), name?: string ≤ 80, password?: string ≥ 8}`.
  - `RemoveMemberDto {handoverTo?: string}` and `HandoverDto {handoverTo: string}`.
  - `ForgotPasswordDto {email, lang?}`, `ResetPasswordDto {token, password ≥ 8}`.
  - `TwoFaEnableDto {code: /^\d{6}$/}`, `TwoFaVerifyDto {challenge, code? | recoveryCode?}` (exactly one), `TwoFaDisableDto {password, code}`.
  - `InvitationDto = {id, email, role: {id, name, nameAr} | null, status: "pending"|"accepted"|"revoked"|"expired", invitedBy: {id, name} | null, expiresAt, lastSentAt, sendCount, createdAt}`. It never includes `tokenHash`.
  - `OpenWorkDto = {conversations, tickets: {deals, leads, support}, followUps, contacts, bookings, total}`; `total` excludes `bookings`.
  - `AuditEntryDto = {id, action, actor: {id, name} | null, actorKind, targetKind, targetId, targetLabel, meta, createdAt}`.
  - `GET /team` rows gain `twoFA: boolean` and `joinedAt` (from `WorkspaceMember.createdAt`).
- **API** (every route workspace-scoped unless public; a foreign id gives **404**; `:id` must equal the JWT workspace, the existing `authorize()`):
  - `GET /workspaces/:id/invitations?status=pending|accepted|revoked|expired|all` (`members.view`) → `{items: InvitationDto[], counts}`.
  - `POST /workspaces/:id/invitations` (`members.create`) → `{invitation, link?}`. `link` is present only when email is `off`.
  - `POST /workspaces/:id/invitations/:invId/resend` (`members.create`) → `{invitation, link?}`.
  - `DELETE /workspaces/:id/invitations/:invId` (`members.delete`) → `{ok: true}`.
  - `GET /invitations/preview?token=` (**public**) → the preview, or 410.
  - `POST /invitations/accept` (**public**) body `AcceptInvitationDto` → the login payload.
  - `GET /auth/invitations` (authenticated) and `POST /auth/invitations/:invId/accept` (authenticated) → the login payload.
  - `GET /workspaces/:id/members/:userId/open-work?handoverTo=` (`members.delete`) → `OpenWorkDto & {refusal?: {reason, resource?}}`.
  - `POST /workspaces/:id/members/:userId/handover` (`members.update`) body `{handoverTo}` → `{moved: OpenWorkDto}`.
  - `DELETE /workspaces/:id/members/:userId` (`members.delete`) body `{handoverTo?}` → `{ok, moved}`, or 409 `members.handover_required {openWork}`.
  - `POST /workspaces/:id/members/:userId/2fa/reset` (`members.manage`) → `{ok: true}`.
  - `GET /workspaces/:id/audit?cursor&action&actorId&from&to` (`members.manage`; ruling 8) → `{items: AuditEntryDto[], nextCursor}`.
  - `GET /auth/workspaces/by-slug/:slug` (authenticated) → `{id, name, member}` or 404.
  - `POST /auth/password/forgot` (**public**) → 202 `{ok: true}`.
  - `POST /auth/password/reset` (**public**) → `{ok: true}`, or 410 `auth.reset_invalid`.
  - `POST /auth/2fa/setup`, `/auth/2fa/enable`, `/auth/2fa/disable` (authenticated); `POST /auth/2fa/verify` (**public**).
  - **Changed:** `POST /auth/login` may return `{twoFactorRequired: true, challenge}` (HTTP 200). `POST /auth/change-password` returns `{token}`. `POST /workspaces/:id/invite` (admin create-with-password) is unchanged but audited.
  - **Route order:** `invitations/preview` and `invitations/accept` are declared in their own `PublicInvitationsController`; `members/:userId/open-work`, `/handover` and `/2fa/reset` sit before any `:userId` catch-all.
- **Error keys** (`backend/src/members/member-errors.ts`, `backend/src/auth/auth-errors.ts`, `{statusCode, message: key, …extra}` like `channelError`):
  - 400: `invitations.invalid_email`, `auth.password_too_short`, `auth.2fa_code_invalid`;
  - 401: `auth.session_expired` (session version), `auth.2fa_challenge_invalid`;
  - 403: `invitations.email_mismatch`, `invitations.role_above_actor`;
  - 404: `invitations.not_found`, `members.not_found`, `workspaces.slug_not_found`;
  - 409: `invitations.already_member`, `invitations.pending_exists`, `invitations.sign_in_required`, `members.handover_required`, `members.handover_refused`, `auth.2fa_already_enabled`, `auth.2fa_not_enabled`;
  - 410: `invitations.invalid`, `auth.reset_invalid`;
  - 429: `invitations.resend_limited`, `auth.rate_limited`;
  - 503: `email.not_configured`, `auth.encryption_unavailable`.
  - Frontend `src/screens/team/memberErrors.ts` has `tx` copy for every key, with a test covering every key.
- **Copy and layout:**
  - Every string through `tx("English","العربية")` with real Arabic. Examples:
    - status: "Pending" / "بانتظار القبول", "Active" / "نشط", "Expired" / "منتهية", "Revoked" / "ملغاة";
    - "Resend invite" / "إعادة إرسال الدعوة", "Revoke" / "إلغاء الدعوة";
    - "Hand over work" / "تسليم العمل", "Remove member" / "إزالة العضو", "Open work" / "عمل مفتوح";
    - "Forgot password?" / "نسيت كلمة المرور؟";
    - "Two-step verification" / "التحقق بخطوتين", "Recovery codes" / "رموز الاسترداد";
    - "You're not in any workspace yet" / "لست عضوًا في أي مساحة عمل بعد".
  - The emails are bilingual by `Invitation.lang` / `ForgotPasswordDto.lang`: one language per email, `dir` on `<html>`, logical CSS (`padding-inline`, `text-align: start`).
  - Logical CSS only in the app. Emails, codes and slugs sit in `<bdi>` / `dir="ltr"` (the TOTP code input is `dir="ltr"`, `inputMode="numeric"`, `autoComplete="one-time-code"`). Dialogs set `dir`.
  - Times in the workspace timezone with Latin digits (`ar-SA-u-nu-latn`), as SP-04 does.
- **Permissions (SP-25).** No catalogue change (`members`, `roles` exist). `permission-map.ts` adds:
  - `GET /workspaces/:id/invitations`: `members.view`
  - `POST /workspaces/:id/invitations`: `members.create`
  - `POST /workspaces/:id/invitations/:invId/resend`: `members.create`
  - `DELETE /workspaces/:id/invitations/:invId`: `members.delete`
  - `GET /invitations/preview`: `public`
  - `POST /invitations/accept`: `public`
  - `GET /auth/invitations`: `authenticated`
  - `POST /auth/invitations/:invId/accept`: `authenticated`
  - `GET /workspaces/:id/members/:userId/open-work`: `members.delete`
  - `POST /workspaces/:id/members/:userId/handover`: `members.update`
  - `POST /workspaces/:id/members/:userId/2fa/reset`: `members.manage`
  - `GET /workspaces/:id/audit`: `members.manage`
  - `GET /auth/workspaces/by-slug/:slug`: `authenticated`
  - `POST /auth/password/forgot`, `POST /auth/password/reset`, `POST /auth/2fa/verify`: `public`
  - `POST /auth/2fa/setup`, `POST /auth/2fa/enable`, `POST /auth/2fa/disable`: `authenticated`

  `system-role-decisions.spec.ts` adds an `SP-26 member routes` block:
  - Owner: everything.
  - Admin: invite, resend, revoke, open-work, handover, remove, audit and 2FA reset, but cannot invite into the owner role (403 `invitations.role_above_actor`).
  - Agent and viewer: list invitations only when they hold `members.view` (viewer yes, agent per the system role); 403 on every write and on audit.
  - Impersonation: may read, but `POST …/2fa/reset` and `DELETE …/members` are blocked for impersonators (add to `blockedForImpersonation`, ruling 11).

  `permission-sidedoors.spec.ts` adds:
  - `audit log of workspace A is 404 from workspace B`;
  - `open-work of a foreign member id is 404`;
  - `by-slug lookup does not reveal a workspace the user is not in` (unknown slug → 404; a real slug of another workspace → `{member: false}` without a name, ruling 10).
- **Rate limits** (in memory, per process, `SlidingWindowLimiter`):
  - forgot: 5/h per email hash, 20/h per IP;
  - reset: 10/h per IP;
  - 2FA verify: 10 per 15 min per challenge `sub`, 30 per 15 min per IP;
  - invitation preview/accept: 30 per 15 min per IP.
  - IP from `Fly-Client-IP`, as `auth.controller.ts` does.
- **Secrets:** TOTP secrets are encrypted with `TOKEN_ENC_KEY` (`encryptSecret`) and never logged or returned after setup. Invite and reset tokens are stored only as sha256. Recovery codes are stored only as bcrypt. No token, code, password or email body appears in any log line; a spec asserts this over a captured `Logger`.
- **Outbound email:** every spec uses `FakeEmailSender` (in memory). No spec calls Resend. Verification points `RESEND_API_BASE` at a loopback stub.
- **Migration:**
  - File: `backend/prisma/migrations/20261118120000_members_security/migration.sql`. The timestamp is after SP-11's `20261116140000_insights_home`. **Every applied migration is never edited.** Hand-written, LF line endings; apply with `npx prisma migrate deploy` only.
  - **Additive and idempotent:**
    ```sql
    CREATE TABLE IF NOT EXISTS "Invitation" (
      "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "email" TEXT NOT NULL, "roleId" TEXT,
      "lang" TEXT NOT NULL DEFAULT 'ar', "tokenHash" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
      "acceptedAt" TIMESTAMP(3), "acceptedById" TEXT, "revokedAt" TIMESTAMP(3), "invitedById" TEXT,
      "sendCount" INTEGER NOT NULL DEFAULT 1, "lastSentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id"));
    CREATE UNIQUE INDEX IF NOT EXISTS "Invitation_tokenHash_key" ON "Invitation"("tokenHash");
    CREATE INDEX IF NOT EXISTS "Invitation_workspaceId_email_idx" ON "Invitation"("workspaceId","email");
    CREATE INDEX IF NOT EXISTS "Invitation_email_idx" ON "Invitation"("email");
    CREATE TABLE IF NOT EXISTS "AuditLog" (
      "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "actorId" TEXT, "actorKind" TEXT NOT NULL DEFAULT 'user',
      "action" TEXT NOT NULL, "targetKind" TEXT NOT NULL, "targetId" TEXT, "meta" JSONB,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id"));
    CREATE INDEX IF NOT EXISTS "AuditLog_workspaceId_createdAt_idx" ON "AuditLog"("workspaceId","createdAt");
    CREATE INDEX IF NOT EXISTS "AuditLog_workspaceId_action_createdAt_idx" ON "AuditLog"("workspaceId","action","createdAt");
    CREATE TABLE IF NOT EXISTS "PasswordReset" (
      "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "tokenHash" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
      "usedAt" TIMESTAMP(3), "requestedIp" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "PasswordReset_pkey" PRIMARY KEY ("id"));
    CREATE UNIQUE INDEX IF NOT EXISTS "PasswordReset_tokenHash_key" ON "PasswordReset"("tokenHash");
    CREATE INDEX IF NOT EXISTS "PasswordReset_userId_createdAt_idx" ON "PasswordReset"("userId","createdAt");
    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "totpSecretEnc" TEXT,
                       ADD COLUMN IF NOT EXISTS "totpPendingEnc" TEXT,
                       ADD COLUMN IF NOT EXISTS "totpEnabledAt" TIMESTAMP(3),
                       ADD COLUMN IF NOT EXISTS "totpLastStep" INTEGER,
                       ADD COLUMN IF NOT EXISTS "totpRecoveryHashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
                       ADD COLUMN IF NOT EXISTS "sessionVersion" INTEGER NOT NULL DEFAULT 0;
    -- FKs, each in DO $$ BEGIN … EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    --  Invitation_workspaceId_fkey (CASCADE), Invitation_roleId_fkey (SET NULL),
    --  Invitation_acceptedById_fkey (SET NULL), Invitation_invitedById_fkey (SET NULL),
    --  AuditLog_workspaceId_fkey (CASCADE), PasswordReset_userId_fkey (CASCADE); all ON UPDATE CASCADE.
    ```
  - **Prisma-conformant names** as listed. `prisma migrate diff --from-schema-datamodel <base schema> --to-schema-datamodel prisma/schema.prisma --script` (no DB) must equal the file apart from `IF NOT EXISTS` and the `DO` wrappers. Note that Prisma emits `totpRecoveryHashes TEXT[]` with `DEFAULT ARRAY[]::TEXT[]`; record the diff output in the report as SP-13/14 did.
  - **Safe for the deployed `main`:**
    - New tables are unknown to `main`.
    - New `User` columns are nullable or have constant defaults (metadata-only on Postgres 11+, no rewrite). `main`'s `User` inserts omit them.
    - `main`'s `findUnique` on `User` selects all mapped columns of **its** client only.
    - `main` keeps issuing tokens without `sv`, which read as 0 (still valid).
    - `main` does not write `twoFA`.
    - No `UPDATE`, `DELETE`, `DROP` or `ALTER … TYPE`. No existing column, constraint or index changes.
    - **Locks:** `ALTER TABLE "User"` takes a brief `ACCESS EXCLUSIVE` lock, with no rewrite. Task 4 sets `SET lock_timeout = '5s'` at the top of the migration (the SP-10 precedent), so a busy table fails fast instead of queueing logins.
  - **No backfill.**
- **Tests:**
  - backend: `npx jest src/members src/auth src/audit src/email src/workspaces src/permissions src/team` plus `npx tsc --noEmit -p tsconfig.json`; the full `npm test` once per task. Known unrelated failure: `hjz-client-sync › is inert when HJZ is not configured`.
  - frontend (repo root): `npx vitest run` plus `npm run typecheck`; `npm run build` once in Task 3.
  - **Named acceptance tests (exact names):**
    - `delete-member-with-references requires handoverTo when open work > 0` (backend jest, `src/members/handover.service.spec.ts`)
    - `invite token single-use and expires` (backend jest, `src/members/invitations.service.spec.ts`)
    - `reset token hashed and single-use` (backend jest, `src/auth/password-reset.service.spec.ts`)
    - `2FA required at login once enabled` (backend jest, `src/auth/two-factor.service.spec.ts`)
  - No email provider is called in any spec (`FakeEmailSender`). No Anthropic/Claude code is involved in SP-26.
- **Commits:** selective `git add <paths>`, never `-A`. Trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not stage `.playwright-mcp/`, `.claude/worktrees/` or any untracked file this plan did not create.

## Review Focus
1. **Tokens are secrets.**
   - Invite and reset tokens are stored only as sha256; they are single-use under concurrency, expire, and are never logged or returned by list routes.
   - A reset ends every existing session (session version). The 2FA challenge cannot be used as a session token.
   - Tests:
     - `invite token single-use and expires`
     - `reset token hashed and single-use`
     - `concurrent accept: exactly one succeeds`
     - `reset bumps session version and old jwt is 401`
     - `2fa challenge token is refused by AuthGuard`
     - `no token, code or password in any log line`
2. **Removing a member never orphans work (Review Focus 2).**
   - Open conversations, tickets, follow-ups and owned contacts move to `handoverTo` in the same transaction as the delete. Nothing moves when the delete is refused.
   - A recipient without the needed permission is refused, never silently skipped.
   - Tests:
     - `delete-member-with-references requires handoverTo when open work > 0`
     - `handover moves every open kind and leaves closed work`
     - `handover to a member without tickets.update is refused`
     - `remove refused leaves work unmoved`
3. **Enumeration and brute force.**
   - "Forgot password" answers 202 for unknown, SSO-only and real emails alike, within the same order of time; the email is sent after the response.
   - Preview/accept give one 410 for every invalid token.
   - 2FA verify is rate-limited, and a code cannot be replayed within its step.
   - Tests:
     - `forgot password is 202 for unknown and known emails alike`
     - `totp code replay in the same step is refused`
     - `2fa verify is rate limited`
4. **Privilege boundaries.**
   - Nobody invites above their own role; only an owner invites an owner.
   - An admin cannot remove or hand over from the last owner (the existing `assertAnotherOwner`).
   - A 2FA reset by an owner is refused for a user in another workspace.
   - Impersonators cannot remove members or reset 2FA.
   - Tests:
     - `admin cannot invite an owner`
     - `owner 2fa reset refused for user in another workspace`
     - `impersonator cannot remove a member`
5. **Login paths stay whole.**
   - Local login with 2FA requires the second step.
   - SSO logins (HJZ, Kewy, Tiremall) and the Kewy `AUTH_SOURCE` path are unchanged.
   - Admin-sets-password still works and is audited.
   - A removed user with no workspace lands on the no-workspace page instead of getting a fresh auto-created workspace.
   - Tests:
     - `2FA required at login once enabled`
     - `sso login does not ask for totp`
     - `admin set password still works and is audited`
     - `login with no membership after removal returns no active workspace`

## Architecture Rulings and Risks
Each item names the risk, then the recommended ruling. Items marked **(needs controller ruling)** are repeated under Controller rulings, where the controller fills in the decision.

1. **Email provider (D3) and "no email configured".** There is no mail code or dependency. Sending email for real is out of scope for every test and verification run.
   - **Ruling:**
     - An `EmailSender` port with a Resend REST implementation over `fetch` (no SDK, no new dependency), selected by `EMAIL_PROVIDER=resend|off`, default `off`.
     - When `off`, invite create/resend returns the accept link once to the inviter (owner/admin), who can copy it. This is the same trust level as today's `tempPassword`.
     - The forgot-password flow shows "Email is not set up for this workspace; ask your owner to reset your password" (the existing admin-sets-password), because returning a reset link to an anonymous caller would be account takeover.
     - Before release, the user sets `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM` and verifies the sending domain (SPF/DKIM). That is a user action.
   - **Alternative:** SES via `@aws-sdk/client-sesv2` (a new dependency). **(needs controller ruling)**
2. **Invite expiry and rotation.**
   - **Ruling:** 7 days; resend rotates the token (the old link dies); at most 5 sends, 1 per minute; a revoked or accepted invite cannot be resent.
   - **Alternative:** 72 h like Clerk's default. **(needs controller ruling, minor)**
3. **TOTP library (D9) and QR code.**
   - **Ruling:**
     - Hand-written RFC 6238 on `node:crypto` (~60 lines plus a base32 codec), proven by the RFC Appendix B vectors (SHA-1). This avoids `otplib`, a dependency for a few lines of well-specified maths.
     - The QR is rendered client-side by `qrcode` (a new frontend dependency, about 30 kB gz) from the `otpauth://` URL, so the secret never leaves the browser to a third-party QR service. The secret is also shown as text.
   - **Alternatives:** `otplib` (D9's suggested default) on the backend; or no QR (text-only secret entry). **(needs controller ruling)**
4. **Ending sessions after reset, disable and owner reset.** JWTs live 7 days with no revocation today, so a reset would not log out an attacker holding a token.
   - **Ruling:**
     - `User.sessionVersion` is carried as `sv` in the JWT and checked by `AuthGuard` through a 30 s per-process cache (one indexed read per user per 30 s).
     - It is bumped on reset, change-password, 2FA disable and owner 2FA reset.
     - Old tokens without `sv` count as 0, so the deploy logs nobody out.
   - **Alternative:** no revocation (document that a reset does not end other sessions). **(needs controller ruling)**
5. **Reset for Kewy-managed and SSO-only users.**
   - `AUTH_SOURCE=kewy|kewy_with_fallback` users authenticate against Kewy, and SSO-only users have `password = NULL`.
   - **Ruling:** reset applies only to users with a local password when `AUTH_SOURCE=local`, or with `kewy_with_fallback` for users Kewy does not know. Others get the same 202 and no email (no enumeration). The Kewy flow keeps its own reset.
   - **Alternative:** reset locally and sync to Kewy (as `resetMemberPassword` does). It needs a Kewy call in tests and verification (stubbed), and a contract we have not verified. **(needs controller ruling)**
6. **Users with no workspace.**
   - Today `finishLogin` auto-creates a workspace for any user without a membership, and the frontend clears the token when `/auth/workspaces` is empty. A removed member who logs in gets a new empty workspace.
   - **Ruling:**
     - `register` keeps auto-creating.
     - `login` returns `activeWorkspaceId: null` when the user has a pending invitation or an `AuditLog member.removed` record. The frontend shows `NoWorkspace.tsx`: pending invitations (Join, never auto-accepted), plus "Create a workspace", which calls the existing `POST /workspaces`.
     - Other users keep today's auto-create.
   - **Alternative:** never auto-create on login. That changes behaviour for SSO bridges that rely on it. **(needs controller ruling)**
7. **What counts as open work, and booking ownership.**
   - **Ruling:**
     - conversations not resolved/closed/spam;
     - tickets with `closedAt IS NULL` (deals, leads and support alike; leads = tickets in `kind: leads` pipelines);
     - activities not done;
     - owned contacts.
     - All go to one `handoverTo`.
     - Upcoming bookings with `staffId = user` are **shown but not moved**. Staff assignment is SP-10's staff resource and needs a schedule fit, so the dialog links to the bookings board.
   - **Alternatives:** split per kind (a different recipient per kind); or Tkana's "follow-ups the recipient cannot open go to the earliest owner". **(needs controller ruling)**
8. **Audit scope, shape and access.**
   - **Ruling:**
     - `targetKind` + `targetId` instead of the roadmap's single `target` (filterable).
     - Read with `members.manage` (owner and admin), because the log names people and actions.
     - User-level security events are copied into each of the user's workspaces.
     - Retention is unlimited for now.
     - Writes happen inside the writer's transaction.
   - **Alternative:** `members.view`. **(needs controller ruling, minor)**
9. **2FA and SSO.**
   - **Ruling:** SSO logins (HJZ, Kewy, Tiremall), admin impersonation and the Joteck server path do not ask for TOTP. The bridge's identity provider is trusted, as today. The Team 2FA column says "Password sign-in only".
   - **Alternative:** require TOTP after SSO too. That breaks embedded HJZ/Tiremall sessions, which have no UI for it. **(needs controller ruling)**
10. **Activation by slug and existence leaks.**
    - **Ruling:** an unknown slug → 404; the slug of a workspace the user is not in → `{member: false}` with no name. That reveals only that some workspace has that slug, which is already true of slug generation. `next` must be a `RouteId`.
    - **Alternative:** 404 for both. **(needs controller ruling, minor)**
11. **Security fixes found while planning.**
    - `src/auth/Login.tsx` stores the **plaintext password** in localStorage for "remember me" (`REMEMBER_PW_KEY`, L27-52).
    - **Ruling:** remember the email only. Task 3 deletes `REMEMBER_PW_KEY` on boot (one-time cleanup in `main.tsx`).
    - Also add `DELETE …/members` and `…/2fa/reset` to `blockedForImpersonation`.
    - **(needs controller ruling)**
12. **Shared files with SP-27, SP-28 and SP-29** (same phase): `schema.prisma`, `permission-map.ts`, `system-role-decisions.spec.ts`, `permission-sidedoors.spec.ts`, `auth.guard.ts` (SP-27 adds API keys), `Settings.tsx`, `App.tsx`, `src/api/client.ts`.
    - **Ruling:**
      - SP-26 bases on the commit that ships SP-11 (or the then-current `feat/tkana-parity` head; today 3f2f41d) and records that SHA.
      - Task 1 owns `schema.prisma` and the migration.
      - Migrations apply in timestamp order SP-26 → SP-27 → SP-28 → SP-29.
      - SP-27 rebases its `auth.guard.ts` hunk onto SP-26's session-version check.
    - **(needs controller ruling)**
13. **Verification touches production** (as SP-09 R12).
    - Task 4 runs against the production DB in throwaway workspaces, with a local **email stub** (`RESEND_API_BASE=http://127.0.0.1:4249`) and no other provider.
    - The migration needs the user's **explicit approval**; earlier approvals do not carry over.
    - The deployed app is unaffected (new tables and default columns only).
    - **(needs controller ruling)**
14. **Size.** The roadmap says L. The plan has 3 build tasks plus verification. **(needs controller ruling, minor)**

### Controller rulings
*Pending. The controller fills in each decision below before Task 1 starts. The migration `20261118120000_members_security` needs explicit user approval before it runs.*
- **R1** (email port over Resend REST, default `off` with a copy-link fallback for invites only; D3): _pending_
- **R2** (7-day invites, rotate on resend, 5 sends max): _pending_
- **R3** (hand-written RFC 6238, no `otplib`; `qrcode` frontend dependency; D9): _pending_
- **R4** (`User.sessionVersion` in the JWT, 30 s cache): _pending_
- **R5** (reset only for local-password users; Kewy keeps its own): _pending_
- **R6** (no-workspace page for removed/invited users; register still auto-creates): _pending_
- **R7** (open work = conversations, tickets, follow-ups, owned contacts → one recipient; bookings shown, not moved): _pending_
- **R8** (audit `targetKind/targetId`, `members.manage` to read, unlimited retention): _pending_
- **R9** (SSO logins skip TOTP): _pending_
- **R10** (slug lookup: unknown 404, non-member `{member:false}`): _pending_
- **R11** (stop storing the plaintext password; impersonation blocks for remove and 2FA reset): _pending_
- **R12** (base on the SP-11 ship commit; Task 1 owns the schema; migration order SP-26 → SP-29): _pending_
- **R13** (verification on the production DB with throwaway workspaces and an email stub; migration needs explicit user approval): _pending_
- **R14** (size L; 3 build tasks + verification): _pending_

---

### Task 1: Backend — schema, migration, email port, audit log, invitations, handover
**Owns:** `schema.prisma` and the migration for all of SP-26. Tasks 2 and 3 depend on this contract.

**Files:**
- `backend/prisma/schema.prisma`: Global Constraints → Data.
- `backend/prisma/migrations/20261118120000_members_security/migration.sql` and `backend/src/members/members-security-migration.spec.ts`.
- Create `backend/src/email/`:
  - `email.module.ts` (global);
  - `email-sender.ts` (port and token);
  - `resend-email-sender.ts`, `disabled-email-sender.ts`, `fake-email-sender.ts` (tests);
  - `templates/layout.ts` (`brand?`), `templates/invite.ts`, each with a spec.
- Create `backend/src/audit/`: `audit.module.ts` (global), `audit.service.ts` (`record`, `list`), `audit.controller.ts`, specs.
- Create in `backend/src/members/`, each with a spec:
  - `members-constants.ts`, `member-errors.ts`, `token-hash.ts` (`newToken()`, `hashToken()`);
  - `invitations.service.ts`, `invitations.controller.ts` (workspace routes), `public-invitations.controller.ts` (preview, accept);
  - `handover.service.ts` (`openWork`, `canReceive`, `handOver`, `removeWithHandover`);
  - `members.module.ts`.
- `backend/src/workspaces/workspaces.controller.ts` / `.service.ts`:
  - `DELETE …/members/:userId` delegates to `removeWithHandover`;
  - `open-work`, `handover`;
  - audit calls in `addMember`, `inviteByEmail`, `updateMemberRole`, `resetMemberPassword`, `update` (settings).
- `backend/src/roles/roles.service.ts`: audit `role.*`.
- `backend/src/auth/auth.controller.ts` + `auth.service.ts`: `GET /auth/invitations`, `POST /auth/invitations/:invId/accept`, `GET /auth/workspaces/by-slug/:slug`; `finishLogin` no-workspace rule (ruling 6).
- `backend/src/team/team.module.ts`: `GET /team` adds `twoFA`, `joinedAt`.
- `backend/src/permissions/permission-map.ts` + `permission-map.spec.ts`, `impersonation.ts`, `system-role-decisions.spec.ts` (`SP-26 member routes`), `permission-sidedoors.spec.ts`.
- `backend/.env.example`: `EMAIL_PROVIDER`, `RESEND_API_BASE`, `RESEND_API_KEY`, `EMAIL_FROM`, `APP_PUBLIC_URL` (link base; existing).
- Test doubles (`backend/src/pipelines/test-prisma.ts`, `channels/test-prisma.ts`): `invitation`, `auditLog`, the new `User` columns.

**Produces (contract for Tasks 2 and 3):** every invitation, handover, audit and slug route, DTO and error key in Global Constraints; `AuditService.record`; `EmailSender`.

- [ ] Write the failing tests:
  - `migration is additive, idempotent and Prisma-named (SP-26)` (reads the SQL):
    - every `CREATE TABLE`, `ADD COLUMN` and `CREATE INDEX` has `IF NOT EXISTS`; every FK is in a `duplicate_object` block; `lock_timeout` is set;
    - there is no `UPDATE`, `DELETE`, `DROP`, `ALTER COLUMN` or `TYPE`;
    - the folder name is greater than `20261116140000`;
    - the sha256 of `20261116120000_support_tickets` and `20261116130000_bookings_catalog` are pinned (unchanged);
    - the `prisma migrate diff` statements match.
  - **`invite token single-use and expires`**:
    - create → the email sent to the fake contains a link whose token's sha256 equals `tokenHash`, and the DB never contains the raw token;
    - accept → member created with `roleId`;
    - the same token again → 410 `invitations.invalid`;
    - a fresh invite at `expiresAt + 1 ms` (fake clock) → 410;
    - a revoked invite → 410;
    - a resend rotates (the old token 410, the new works).
  - `concurrent accept: exactly one succeeds` (two parallel accepts through the conditional update → one member, one 410).
  - `admin cannot invite an owner`; `invite above own role is 403`; `existing member is 409`; `second pending invite for the same email is 409` (case-insensitive).
  - `accept signed in with another email is 403`; `accept for an existing account while signed out is 409 sign_in_required`; `deleted role falls back to viewer with rolePending`.
  - `email off returns the link to the inviter once and never logs it`.
  - **`delete-member-with-references requires handoverTo when open work > 0`**:
    - a member with 1 open conversation, 1 open deal ticket, 1 open lead ticket, 1 open follow-up and 1 owned contact;
    - `DELETE` without `handoverTo` → 409 `members.handover_required` with exact counts, and the membership is still present;
    - with `handoverTo` → every row moved, membership deleted, one `AuditLog member.removed` with `moved`, one notification to the recipient;
    - a member with no open work → deleted without `handoverTo`.
  - `handover moves every open kind and leaves closed work` (resolved conversations, closed tickets and done activities untouched; conversation `version` bumped).
  - `handover to a member without tickets.update is refused` (custom role) → 409 `members.handover_refused {reason:"missing_permission", resource:"tickets"}`; nothing moved.
  - `remove refused leaves work unmoved` (`assertAnotherOwner` fails after the counts → the transaction rolls back).
  - `audit log of workspace A is 404 from workspace B`; `open-work of a foreign member id is 404`; `by-slug lookup does not reveal a workspace the user is not in`.
  - `audit list pages by createdAt desc and filters by action`.
  - `login with no membership after removal returns no active workspace`; `register still auto-creates a workspace`.
  - `admin set password still works and is audited`.
  - `no token, code or password in any log line` (captured `Logger` over create, resend, accept).
  - `permission map covers SP-26 routes`, plus the `SP-26 member routes` system-role block and `impersonator cannot remove a member`.
- [ ] Implement until green.
- [ ] `npx tsc --noEmit -p tsconfig.json`, the listed jest paths, then the full `npm test` once. Run `npx prisma generate` (an EPERM on the engine DLL while the dev watcher runs is harmless; restart the watcher). **Do not run `migrate`** (ruling 13). Existing `workspaces.*.spec.ts`, `auth.*.spec.ts`, `roles.*.spec.ts` stay green, extended only.
- [ ] Commit `feat(members): email invitations, handover on removal, audit log and email port`.

### Task 2: Backend — password reset, TOTP 2FA, session version
**Depends on:** Task 1 (schema, email port, audit).

**Files:**
- Create in `backend/src/auth/`, each with a spec:
  - `auth-errors.ts`;
  - `totp.ts` (`base32Encode/Decode`, `totpAt(secret, step)`, `verifyTotp(secret, code, nowMs, lastStep) → step | null`);
  - `recovery-codes.ts`;
  - `password-reset.service.ts`, `two-factor.service.ts`;
  - `session-version.service.ts` (cache, bump, invalidate).
- `backend/src/email/templates/reset.ts`, `two-factor-reset.ts`.
- `auth.controller.ts`: forgot, reset, 2FA setup/enable/disable/verify. `auth.service.ts`:
  - `finishLogin` returns the challenge when `twoFA`;
  - `issue()` adds `sv`;
  - `change-password` bumps and returns `{token}`.
- `auth.guard.ts`:
  - refuse `purpose: "2fa"` tokens;
  - compare `sv`.
  - SSO services (`sso.service.ts`, `kewy-sso.service.ts`, `tiremall-sso.service.ts`) and `admin.service.ts` impersonation add `sv`.
- `workspaces.controller.ts`: `POST …/members/:userId/2fa/reset`.
- `permission-map.ts` entries (Global Constraints), `system-role-decisions.spec.ts`.

**Produces:** the reset and 2FA routes, the login challenge shape `{twoFactorRequired, challenge}`, and `sv`.

- [ ] Write the failing tests:
  - `totp matches RFC 6238 vectors` (SHA-1 seed `12345678901234567890`, times 59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000 → the 6-digit tails of the Appendix B 8-digit values); `base32 round-trips`.
  - **`2FA required at login once enabled`**:
    - setup → enable with a valid code;
    - login with the right password now returns `{twoFactorRequired: true, challenge}` and **no** `token`;
    - verify with a wrong code → 400 `auth.2fa_code_invalid`;
    - with the right code → the login payload;
    - with a recovery code → the payload, and the same recovery code again → 400;
    - a user without 2FA logs in in one step.
  - `totp code replay in the same step is refused`; `2fa verify is rate limited` (the 11th try → 429).
  - `2fa challenge token is refused by AuthGuard` (as a Bearer → 401).
  - `totp secret stored encrypted and never returned` (`totpSecretEnc` starts `enc:v1:`; `GET /auth/me` and `/team` expose only `twoFA`); `setup refuses without TOKEN_ENC_KEY in production` (503).
  - `disable needs password and code and bumps session version`.
  - `owner 2fa reset refused for user in another workspace`; on success it is audited, the email is sent through the fake, and the session version is bumped.
  - **`reset token hashed and single-use`**:
    - forgot for a local user → one `PasswordReset` row with `tokenHash = sha256(emailed token)` (raw token absent from the DB);
    - reset → password changed;
    - the same token → 410 `auth.reset_invalid`;
    - an expired token (fake clock +31 min) → 410;
    - the 4th forgot leaves at most 3 live rows.
  - `reset bumps session version and old jwt is 401`; `tokens without sv still work until the first bump`.
  - `forgot password is 202 for unknown and known emails alike` (unknown, SSO-only `password NULL`, Kewy-managed, and local: all 202; only local gets an email).
  - `sso login does not ask for totp` (Kewy, Tiremall and HJZ exchange specs extended).
  - `no token, code or password in any log line` (reset and 2FA paths).
- [ ] Implement until green.
- [ ] `npx tsc --noEmit -p tsconfig.json`, `npx jest src/auth src/members src/workspaces src/permissions src/admin`, then the full `npm test` once.
- [ ] Commit `feat(auth): password reset, totp two-step verification and session version`.

### Task 3: Frontend — members, invitations, handover, audit, accept/reset/2FA pages
**Depends on:** Tasks 1–2 contracts (it can start from the contract while they are in review).

**Files:**
- **F1 Model (pure):**
  - `src/screens/team/inviteModel.ts`: status chips, filter counts, `canResend`.
  - `src/screens/team/handoverModel.ts`: `openWorkSummary(dto, tx)`, `needsHandover(dto)`.
  - `src/screens/team/auditModel.ts`: `auditLine(entry, tx)` for every action.
  - `src/screens/team/memberErrors.ts`.
  - `src/auth/publicRoutes.ts`: `parsePublicFragment(hash) → {kind:"accept"|"reset"|"activate", token|slug, next?}`, `safeNext(next)` (only a `RouteId`).
  - Tests: `inviteModel.test.ts`, `handoverModel.test.ts`, `auditModel.test.ts`, `memberErrors.test.ts`, `publicRoutes.test.ts`.
- **F2 Team screen** (`src/screens/Team.tsx`):
  - the real `InviteModal` (email, role from `GET /roles`, language; shows the copy-link panel when the response has `link`);
  - the Pending tab from `GET /workspaces/:id/invitations` (filter All/Active/Pending with counts, Resend, Revoke with confirm);
  - the Activity tab from `/audit` (filters, paging, `members.manage` only);
  - 2FA stat and column from `twoFA`, with "Reset 2FA" in the row menu (`members.manage`);
  - Joined from `joinedAt`;
  - remove the "Avg response" mock card and the dead header "Activity" button (or wire it to the Activity tab).
  - `src/data/team-extras.ts` loses `PENDING_INVITES`, `ACTIVITY` (and `PERM_MATRIX` if unused after SP-25).
- **F3 Handover:** `src/screens/team/MemberHandoverDialog.tsx` (`dir` set):
  - modes `handover | remove`;
  - loads `open-work?handoverTo=` as the recipient changes and shows counts per kind plus the refusal reason;
  - the bookings count links to the bookings board;
  - it is used by both `Team.tsx` and `settings/MembersTab.tsx` (its delete button goes through the dialog).
- **F4 Public pages** (rendered by `App.tsx` before the auth gate, chosen by `parsePublicFragment` in `src/main.tsx`; each reads `?lang=`, falling back to the stored language):
  - `src/auth/AcceptInvite.tsx`: preview, then sign up (name, password) or "Sign in to join" (email locked), then enter the workspace;
  - `src/auth/ForgotPassword.tsx`, `src/auth/ResetPassword.tsx`;
  - `src/auth/TwoFactorStep.tsx` (code / recovery code; shown by `Login.tsx` on `twoFactorRequired`);
  - `src/auth/NoWorkspace.tsx`;
  - `src/auth/Activate.tsx`.
- **F5 Login and context:**
  - `Login.tsx`: a "Forgot password?" link; remember the email only (ruling 11); `main.tsx` removes `REMEMBER_PW_KEY` once.
  - `src/auth/context.tsx`: an empty workspace list → the `noWorkspace` state, not logout; a 401 `auth.session_expired` → logout with a toast.
- **F6 Profile:** `src/screens/settings/ProfileTab.tsx` gains "Two-step verification":
  - setup (QR through `qrcode` plus the text secret in `<bdi dir="ltr">`);
  - confirm the code;
  - recovery codes shown once with copy/download;
  - disable (password + code).
  - Change-password stores the new returned token.
- **F7 Types:** `src/lib/types.ts`: `Invitation`, `OpenWork`, `AuditEntry`, `TeamMember.twoFA`, `joinedAt`.
- **Permission gating** with `usePermissions().can(...)`:
  - invite/resend need `members.create`;
  - revoke and remove need `members.delete`;
  - handover needs `members.update`;
  - Activity and 2FA reset need `members.manage`.
  - Hidden actions are not rendered; a 403 shows the shared no-permission toast.

**Produces:** the real Team screen and the public account pages in English and Arabic (RTL).

- [ ] Write the failing vitest tests:
  - `invite status and filter counts`: pending/accepted/revoked/expired derived from the dates (expired = pending past `expiresAt`); the counts match the filter.
  - `handover summary lists only non-zero kinds and needs a recipient when total > 0` (bookings never count toward `total`).
  - `audit line text covers every SP-26 action in both languages`.
  - `member error copy covers every SP-26 key in both languages`.
  - `public fragment parsing and safe next`:
    - `#/accept-invite?token=…`, `#/reset-password?token=…` and `#/activate?ws=acme&next=inbox` parse;
    - `next=//evil.com`, `next=https:…`, `next=%2F%2F…` and unknown routes → `dashboard`;
    - a missing token → null.
- [ ] Implement until green, then build the components.
- [ ] `npx vitest run`, `npm run typecheck` and `npm run build` clean.
- [ ] Commit `feat(team): real invitations, handover dialog, audit tab, reset and two-step pages`.

### Task 4: Verification
Apply `20261118120000_members_security` with `npx prisma migrate deploy`, only when the controller and the user explicitly approve it (ruling 13). Record the results in `.superpowers/sdd/2026-11-18-sp26-members-security/live-verification.md`, in the format of SP-15's: summary, a results table with evidence, DB-side checks, findings, cleanup, pending items. If the harness refuses the write, put the tables in the scratchpad and say so; do not reroute.

**Before approval (read-only, production):**
- `SELECT count(*) FROM "User"`, `SELECT count(*) FROM "WorkspaceMember"`.
- `SELECT reltuples FROM pg_class WHERE relname = 'User'`.
- `SELECT count(*) FROM pg_stat_activity WHERE state = 'active'` (lock risk of `ALTER TABLE "User"`).

**Isolation** (no repo code changed; scripts derived from SP-09's in the session scratchpad `C:\Users\ashra\AppData\Local\Temp\claude\7b75a64029a712a6\ebb2057a-6300-4548-9aec-b98487880afb\scratchpad\`):
- **Own instance:** `launch-sp26.js`, derived from `launch-sp09.js`. Backend on **:4250**, compiled with `tsc -p tsconfig.build.json` into `backend/.verify-dist-sp26` (never `backend/dist`), working directory `sp26-run/`. The user's :4100 process is not touched.
- **Crons:** all `@nestjs/schedule` jobs disabled (the SP-13 `lookupSchedulers` patch).
- **Storage:** every `DO_SPACES_*` is an **empty string**.
- **No external call, ever:**
  - **Email:**
    - `EMAIL_PROVIDER=resend`, `RESEND_API_BASE=http://127.0.0.1:4249`, `RESEND_API_KEY=zz-verify-stub`, `EMAIL_FROM=verify@zz-verify.invalid`.
    - `email-stub-sp26.js` accepts `POST /emails`, records `{to, subject, tag}` and the **link** to `email-stub-sp26-calls.jsonl` in the scratchpad (test tokens only; the file is deleted at cleanup), and returns `{id}`.
  - **Kewy/SSO:** `AUTH_SOURCE=local`; every `KEWY_*`, `TIREMALL_*` and HJZ URL/secret is an empty string.
  - **Zernio, Meta, l, OpenAI, Stripe:** every key and base URL an empty string (SP-19 finding E2: empty, not deleted).
  - **`TOKEN_ENC_KEY`** is a 48-character test value (only the throwaway users' TOTP secrets are encrypted with it; they are deleted at cleanup).
  - **The launcher refuses to start** unless `RESEND_API_BASE` begins with `http://127.0.0.1`, `RESEND_API_KEY` equals `zz-verify-stub`, `AUTH_SOURCE=local`, and every `DO_SPACES_*`, `KEWY_*`, `STRIPE_*` and `ZERNIO_API_KEY` is empty.
  - The SP-13 egress guard (fetch/http/https to any non-loopback host throws and is logged to `blocked-egress-sp26.jsonl`) stays. Before cleanup the script asserts the file is empty.
- Test tag `zz-verify-<ts>` on every name; emails `zz-verify-<ts>-<n>@zz-verify.invalid` (an `.invalid` TLD, so nothing is ever deliverable).

**Setup** (writes only rows of throwaway workspaces and users; every id recorded in `verify-created-sp26.json`):
1. Register an owner (workspace A) and a foreign owner (workspace B).
2. Create, through the existing routes, an admin and an agent with `assigned` visibility, plus a custom role without `tickets.update`.
3. Create a contact, conversation (assigned to the agent), deal ticket and lead ticket (owner = agent), a follow-up (assignee = agent), a contact owned by the agent, and one upcoming booking with `staffId = agent` (no `externalTenantId`, so no HJZ push).
4. Record the before-counts listed under Cleanup.

**Checks:**
- **Migration:** tables, indexes, FKs and `User` columns exist (`information_schema`, `pg_indexes`); `SELECT count(*) FROM "User" WHERE "sessionVersion" <> 0` = 0 right after apply.
- **`invite token single-use and expires` (live):**
  - invite `zz…-new@…` as admin with the agent role → the stub received one email; the DB row has `tokenHash = sha256(link token)`;
  - preview shows the masked email and role;
  - accept with name and password → member with the role;
  - accept again → 410;
  - a second invite with `expiresAt` moved into the past (raw `UPDATE` of the test row) → 410;
  - revoke → 410; resend rotates;
  - the admin inviting into the owner role → 403;
  - the Pending filter counts match.
- **`delete-member-with-references requires handoverTo when open work > 0` (live):**
  - open-work for the agent shows the 1/1/1/1/1 counts (bookings 1, info);
  - `DELETE` without `handoverTo` → 409 with counts, membership intact;
  - `handoverTo` = the custom-role member → 409 `handover_refused tickets`;
  - `handoverTo` = admin → 200, every row now owned by the admin (DB), one `AuditLog`, one notification;
  - the booking's `staffId` is unchanged.
- **No-workspace page:** the removed agent logs in → `activeWorkspaceId: null`, and `GET /auth/invitations` lists a fresh pending invite; accept by id → back in.
- **`reset token hashed and single-use` (live):**
  - forgot for the owner → stub email; `PasswordReset.tokenHash = sha256(token)`;
  - an old JWT still works before the reset;
  - reset → the old JWT is 401 `auth.session_expired`; login with the new password works;
  - the same token → 410;
  - forgot for an unknown email → 202 and no stub call.
- **`2FA required at login once enabled` (live):**
  - setup and enable (the TOTP is computed in the script from the returned secret);
  - login → challenge; verify with a wrong code → 400; with the right code → token;
  - the same code again in the same step → 400;
  - a recovery code works once;
  - `totpSecretEnc` begins `enc:v1:`;
  - an owner reset of the admin's 2FA → audited, admin's sessions 401.
- **Activation:** `by-slug` for A as A's member → `{member:true}`; for B's slug → `{member:false}` with no name; an unknown slug → 404.
- **Audit:** `GET /audit` lists every action above in order; from workspace B → 404; as the agent → 403.
- **Roles:** agent and viewer per the `SP-26 member routes` block (403 where expected); an impersonation token → 403 on `DELETE …/members`.
- **Logs:** grep the :4250 log for every recorded token, TOTP secret, recovery code and test password → zero hits.
- **Index use:** `EXPLAIN` (no `ANALYZE`) of the audit list inside `BEGIN; SET LOCAL enable_seqscan = off; … ROLLBACK;` uses `AuditLog_workspaceId_createdAt_idx`.
- **Migration rerun:** the SP-26 SQL again inside a transaction that is always rolled back: no error, 0 rows changed. If the tool safety layer refuses DDL even in a rolled-back transaction, record it and ask the user; do not reroute.
- **UI through the `verify` skill:**
  - Team (Pending/Active filter, invite modal with the copy-link fallback when `EMAIL_PROVIDER=off` on a second launch, Activity tab, 2FA column);
  - the handover dialog;
  - the accept page (sign-up and sign-in variants), forgot/reset pages, the two-step login, the profile 2FA setup with QR, the no-workspace page;
  - all in English and Arabic (RTL); screenshots.

**Cleanup:**
- Delete only the recorded test rows: the workspaces (the cascade covers members, invitations, audit logs, contacts, conversations, tickets, activities, appointments, roles and notifications), then the users (the cascade covers `PasswordReset`).
- Delete `email-stub-sp26-calls.jsonl`.
- Residue sweep over every table with a `workspaceId` column, and `PasswordReset`/`Invitation` by test email.
- Read-only counts before and after: `Workspace`, `User`, `WorkspaceMember`, `Role`, `Invitation`, `AuditLog`, `PasswordReset`, `Contact`, `Conversation`, `Ticket`, `Activity`, `Appointment`, `Notification`. Every count identical.
- Stop :4250, the stub, and remove the outDir and `sp26-run/`.

Then tick SP-26's "Detailed plan written" and "Shipped" boxes in the roadmap, noting the rulings and deviations. Add the pending user actions: choose and configure the email provider (D3: domain, `RESEND_API_KEY`, `EMAIL_FROM`), set `TOKEN_ENC_KEY` on Fly if not done for SP-19. Add the deferred items: per-kind handover recipients (ruling 7), audit retention, WebAuthn/passkeys, and SSO 2FA (ruling 9).


### User decisions (2026-11-16)
- Email provider: **Resend** (R1/D3). Needs `RESEND_API_KEY` and a verified sender domain on Fly; until then invites fall back to copy-link.
