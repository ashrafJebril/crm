# SP-28 Billing Portal: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- **Plans and add-ons.**
  - A code catalogue keeps the existing plan keys `free | starter | growth | pro` (the values `Workspace.plan` already holds) and adds add-ons. Each has monthly and annual prices and a feature/limit table.
  - Owners subscribe, change plan or cycle, add or remove add-ons, and cancel at period end through Stripe Billing.
  - **Only workspaces billed by Stripe** use this flow. Workspaces billed through Kewy/Joteck keep today's behaviour and see their plan read-only, with the existing "Go to billing" link (ruling 1).
- **Prepaid wallet.**
  - The existing `AdsWallet` becomes the workspace wallet (ruling 2). Ads AI is one usage meter on it.
  - Top-up uses Stripe Checkout (hosted, the existing pattern; embedded per ruling 5).
  - A ledger lists every credit and debit.
  - Debits are atomic and the balance never goes negative.
  - Roadmap acceptance: `wallet never goes negative under concurrent debits`.
- **Usage metering.**
  - `UsageEvent` rows record AI replies, campaign messages and ads AI, idempotent per source.
  - A usage panel (period totals per meter against plan allowances) and a usage drawer (daily breakdown, recent events).
  - Charging overage to the wallet is off by default (ruling 6).
- **Payment methods.** Managed in the Stripe Customer Portal (a hosted session; ruling 5). The billing page shows the default card's brand, last 4 digits and expiry.
- **Tax invoices with PDF.** Stripe invoices (D4) are listed with number, date, total and status, plus links to Stripe's `invoice_pdf` and `hosted_invoice_url`. No PDF generator is added (ruling 7).
- **Banners.**
  - A trial reminder banner from 7 days before `trialEndsAt` (days 7, 3 and 1; dismissible per day).
  - A renewal-grace banner while the subscription is `past_due`, counting down to the payment lock.
  - The existing full-screen `PaymentLocked` once locked.
- **Live credit status.** `GET /billing/status` is polled every 60 s and pushed over realtime `billing.updated` on any wallet or subscription change. It drives a small sidebar credit chip and the banners.
- **"Not in plan" gating.**
  - `@RequirePlanFeature(key)` on gated routes returns **402** `{code: "PLAN_REQUIRED", feature, requiredPlan}`.
  - The UI shows an in-place upgrade card instead of the feature (Tkana `not-in-plan.tsx`), never an error page.
  - Roadmap acceptance: `feature gated by plan returns 402 PLAN_REQUIRED and UI shows upgrade`.
- **Stripe webhook.**
  - A new endpoint handles subscription, invoice, checkout and customer events.
  - It is idempotent by Stripe `event.id` (a `StripeEvent` table), on top of the existing per-session `externalRef` idempotency for top-ups.
  - Roadmap acceptance: `webhook idempotent on replay`.
- **Payment lock driven by the subscription.**
  - For Stripe-billed workspaces, `past_due` maps to `applyBillingState("due")` and `unpaid`/`canceled` (after grace) to `"ended"`, through the existing `payment-lock.ts`.
  - Kewy/Joteck workspaces keep the Joteck `billing-state` call.
- **Admin overrides remain.**
  - Super-admin `PATCH /admin/workspaces/:id {plan}` keeps working. It now also sets `Workspace.planOverriddenAt`, and while that is set the Stripe webhook does not overwrite `plan` (ruling 8).
  - A "Clear override" action returns the workspace to its subscription's plan.

**Architecture:**
- **Billing source (ruling 1).**
  - `Workspace.billingSource`: `"kewy" | "stripe"`, default `"kewy"`, so every existing workspace stays as it is.
  - A workspace becomes `stripe` when its owner starts a subscription checkout (only allowed when `BILLING_STRIPE_ENABLED=1` and the workspace is not Kewy-provisioned, i.e. `kewyWorkspaceId IS NULL`), or when a super-admin flips it.
  - `JoteckService.setBillingState` ignores `stripe` workspaces (it logs and returns `{ignored: true}`), so two systems never fight over the lock.
- **Catalogue** (`backend/src/billing/plan-catalog.ts`, pure, mirrored in `src/screens/billing/planCatalog.ts`; a test pins equality):
  ```ts
  export const PLANS = {
    free:    { rank: 0, prices: { monthly: 0, annual: 0 }, features: {...}, limits: {...} },
    starter: { rank: 1, prices: { monthly: P, annual: P*10 }, ... },
    growth:  { rank: 2, ... },
    pro:     { rank: 3, ... },
  } as const;
  export const ADD_ONS = { extra_number: {...}, copilot: {...}, extra_ai_replies: {...} } as const;
  export const FEATURES = ["campaigns","smart_audiences","insights","api_access","webhooks","ai_tools","bookings_catalog_import","copilot"] as const;
  ```
  - `limits.whatsappNumbers` **imports** `CHANNEL_LIMITS` from `channels/channel-limits.ts` (one source).
  - `limits.aiRepliesPerPeriod`, `limits.campaignMessagesPerPeriod`, `limits.seats` are allowances shown in the usage panel. **Prices, allowances and which plan holds which feature are business inputs** (ruling 3). The plan fills them from env-free constants agreed with the user; Stripe price ids come from env `STRIPE_PRICE_<PLAN>_<CYCLE>` and `STRIPE_PRICE_ADDON_<KEY>_<CYCLE>`.
  - `effectivePlan(ws) = ws.planOverriddenAt ? ws.plan : (subscription active|trialing|past_due ? subscription.planKey : ws.plan)`.
  - `planIncludes(plan, addOns, feature)`.
  - **Grandfathering (ruling 4):** in v1 every existing plan key includes every feature a workspace on it can use today. Only `free` is gated (features new in Phase 3–6), so no paying workspace loses access on deploy.
- **Stripe** (`backend/src/billing/stripe/`):
  - Reuse `ads/stripe.provider.ts`'s lazy client. Add `stripeClient()` with `apiVersion` pinned and optional `host/port/protocol` from `STRIPE_API_HOST|PORT|PROTOCOL`. Those are unset in production and point at the loopback stub in verification; the Stripe SDK supports them natively.
  - `BillingCustomerService.ensureCustomer(ws)` creates the Customer once (`metadata.workspaceId`) and stores `Workspace.stripeCustomerId`. It is serialised by `pg_advisory_xact_lock(hashtext('stripe-customer:'||wsId))` so two clicks make one customer.
  - `POST /billing/checkout/subscription {planKey, cycle, addOns}` → a Checkout Session `mode: "subscription"` with `customer`, line items from the env price ids, `subscription_data.metadata.workspaceId`, `client_reference_id`, and success/cancel URLs `#/settings?tab=billing&checkout=success|cancel`. It refuses while a Stripe subscription is already active (that case uses change-plan).
  - `POST /billing/subscription/change {planKey?, cycle?, addOns?}` → `subscriptions.update` with `proration_behavior: "create_prorations"`. A downgrade takes effect at period end (`schedule` via `cancel_at_period_end` + a new price at renewal is deferred; v1 applies immediately with proration, ruling 9).
  - `POST /billing/subscription/cancel` → `cancel_at_period_end: true`; `/resume` reverts it.
  - `POST /billing/portal` → a Customer Portal session URL (payment methods, billing details).
  - `POST /billing/wallet/topup {amount}` replaces the ads-only route. `POST /ads/wallet/topup` stays as an alias calling the same service (the ads screen and deployed `main` keep working). It uses a Checkout Session `mode: "payment"` with `customer` set and `metadata.kind = "wallet_topup"`. The ads webhook keeps accepting `ads_wallet_topup`.
  - `GET /billing/invoices?cursor` → `stripe.invoices.list({customer, limit: 12, starting_after})` mapped to `{id, number, createdAt, total, currency, status, pdfUrl, hostedUrl}`. Nothing is stored and nothing is cached across requests. A workspace without a customer gets `{items: []}`.
- **Webhook** (`POST /billing/webhook/stripe`, `@Public`, raw body, `STRIPE_BILLING_WEBHOOK_SECRET`; ruling 10):
  - `constructEvent` failure → 400.
  - In one `$transaction`:
    1. `INSERT INTO "StripeEvent"(id, type) … ON CONFLICT DO NOTHING`. Zero rows means a replay → 200 `{duplicate: true}` with no side effect.
    2. Dispatch inside the same transaction:
       - `checkout.session.completed` (`mode=subscription`) → link `stripeSubscriptionId` (the subscription itself is read via `subscriptions.retrieve` **before** the transaction opens, so no network call happens inside it);
       - `checkout.session.completed` (`mode=payment`, `kind=wallet_topup|ads_wallet_topup`, `payment_status=paid`) → `WalletService.credit` (the existing `externalRef = session.id` idempotency stays as a second guard);
       - `checkout.session.async_payment_succeeded` → the same credit (closes the TODO at `stripe.provider.ts:97-105`);
       - `customer.subscription.created|updated|deleted` → upsert `Subscription` from the event object (status, planKey from the price id map, cycle, `currentPeriodEnd`, `cancelAtPeriodEnd`, `trialEndsAt`, addOns), then set `Workspace.plan` unless overridden, then the payment-lock mapping;
       - `invoice.payment_failed` → status `past_due` and `graceEndsAt = now + BILLING_GRACE_DAYS`;
       - `invoice.paid` → clear grace and `applyBillingState("ok")`.
    3. Set `processedAt`.
  - **Ordering:** each subscription event carries the full object. The upsert keeps a monotonic `stripeEventCreated` and ignores an older event than the stored one (out-of-order delivery).
  - Unknown event types are recorded and 200'd.
  - After commit: `PaymentLockService` cache invalidation, realtime `billing.updated` to the workspace, and `AuditLog` (SP-26) `billing.plan_changed|subscription_status|wallet_topup`.
- **Payment-lock mapping** (`billing/subscription-lock.ts`, pure):
  - `active|trialing` → `ok`;
  - `past_due` → `due` (the lock clock starts; the existing `isPaymentLocked` locks after `PAYMENT_GRACE_DAYS`);
  - `unpaid|canceled` with no other active subscription → `ended`; but `canceled` because the owner downgraded to free → `ok` with plan `free`.
  - `BILLING_GRACE_DAYS` defaults to the existing `PAYMENT_GRACE_DAYS = 2`. Tkana uses 10 (ruling 11).
- **Wallet** (`backend/src/billing/wallet.service.ts`, wrapping the `AdsWallet` tables; ruling 2):
  - `debit(ws, {meter, amountJod, sourceKind, sourceId, idempotencyKey})`.
    - In one `$transaction`:
      1. insert a `UsageEvent` with a unique `idempotencyKey` (a replay → return the earlier result);
      2. `UPDATE "AdsWallet" SET "balanceJod" = "balanceJod" - $amt WHERE "workspaceId" = $ws AND "balanceJod" >= $amt RETURNING "balanceJod"`;
      3. no row → throw 402 `{code: "WALLET_EMPTY"}` and roll back. No drain-to-zero for new meters.
      4. insert an `AdsWalletTransaction` `type: "DEBIT"` with `meter`.
    - The DB `CHECK ("balanceJod" >= 0)` stays as the backstop.
    - The **ads** meter keeps its current drain-to-zero semantics in `ads-wallet.service.ts` (unchanged code path; ruling 2).
  - `credit(...)` is the existing `AdsWalletService.credit`, moved behind the wallet facade.
  - `balance(ws)` reads the balance; `ledger(ws, cursor)` lists 50 rows per page.
- **Usage** (`backend/src/billing/usage.service.ts`):
  - `record(ws, {meter, qty, sourceKind, sourceId})` inserts a `UsageEvent` with `idempotencyKey = meter:sourceKind:sourceId` (`ON CONFLICT DO NOTHING`). It is called **after** the source write commits:
    - `ai_reply`: where `Message.from = "ai"` is written (`integrations/ai-reply.controller.ts`, `l-outbound.service.ts`, `l-webhooks.service.ts`);
    - `campaign_message`: on `CampaignRecipient → sent` (`campaign-send.service.ts`, `campaign-launch-runner.service.ts`);
    - `ads_ai`: in `AdsWalletService.debit`.
  - A failure to record usage is logged and **never** fails the send (metering is not on the critical path).
  - `summary(ws, periodStart, periodEnd)` → per-meter totals vs allowances. `daily(ws, meter, from, to)` uses `date_trunc('day', at AT TIME ZONE ws.timezone)`.
  - **Overage charging** (`meteredBilling` per plan, default **off**; ruling 6): when on and the allowance is used up, `debit` is called with the meter's unit price, and `WALLET_EMPTY` makes AI replies return `{delivered:false, reason:"wallet_empty"}` (the `payment_overdue` pattern). v1 ships it off for every plan.
- **Plan gating** (`backend/src/billing/plan-feature.guard.ts`):
  - `@RequirePlanFeature("campaigns")` metadata. The guard runs after `PermissionGuard` (registered as the third `APP_GUARD`), reads `effectivePlan` (a 60 s cache like `PaymentLockService`), and throws `HttpException({statusCode: 402, code: "PLAN_REQUIRED", feature, requiredPlan}, 402)`.
  - Super-admins and impersonators bypass it, as the payment lock does.
  - Gated routes are listed in `plan-feature-map.ts`, and a spec checks every entry's route exists in `permission-map.ts`.
  - The frontend `client.ts` `errorFromBody` maps a 402 `PLAN_REQUIRED` to `ApiError.code`. `usePlan()` (from `GET /billing/status`) lets screens render `<NotInPlan feature>` up front instead of waiting for a 402.
- **Credit status** (`GET /billing/status`, membership `authenticated`, small and cached 30 s per workspace):
  ```
  {billingSource, plan, effectivePlan, overridden, subscription: {status, cycle, currentPeriodEnd, cancelAtPeriodEnd, trialEndsAt, graceEndsAt} | null,
   wallet: {balanceJod, lowBalance}, usage: {meter, used, allowance}[], features: string[], banners: ("trial"|"grace"|"low_balance")[]}
  ```
  `wallet` and `usage` are omitted for members without `billing.view`. `features` and `banners` are always present (the UI needs them to gate).

**Tech Stack:** NestJS 10, Prisma 5 (Postgres/Neon), jest/ts-jest, `stripe@22.5.0` (already installed); React 18 + Vite, vitest. **No new dependencies** under the recommended rulings (hosted Checkout and Customer Portal; Stripe PDFs). Ruling 5's alternative would add `@stripe/stripe-js`. No Anthropic/Claude API code is involved.

**Spec:** roadmap §SP-28, D4, plus the Global Constraints. Carried contracts:
- **Ads wallet:**
  - `ads/{stripe.provider,payment-gateway.port,ads-wallet.service,ads-webhook.controller,ads.controller,ads.exceptions,ads-pricing}.ts`;
  - `AdsWallet`/`AdsWalletTransaction` with the `AdsWallet_balanceJod_non_negative` CHECK (`20260825120000_ads_assistant`);
  - `rawBody: true` in `main.ts`.
- **Payment lock:** `billing/{payment-lock,payment-lock.service}.ts` (`applyBillingState`, `PAYMENT_GRACE_DAYS`, `PAYMENT_OVERDUE`), `joteck.service.ts:120-152`, `src/auth/PaymentLocked.tsx`, `src/lib/paymentLock.ts`, `src/api/client.ts:64-69,152-166`.
- **Admin:** `admin/{admin.controller,admin.service,admin.dto}.ts` (`PATCH workspaces/:id {plan}`), `src/screens/Admin.tsx:679-720,894-910`.
- **SP-19:** `channels/channel-limits.ts` (`CHANNEL_LIMITS`, `assertWhatsappCapacity`).
- **SP-25:** `billing` resource (owner all; admin without `manage`; agent none; viewer hidden); `impersonation.ts` blocks `billing.*`.
- **SP-26:** `AuditService.record`, the email port (trial reminders by email are deferred, ruling 12).
- **SP-05:** realtime `emitToWorkspace`.

Consumers: SP-22/SP-23 gate skills/connectors with `@RequirePlanFeature`; SP-18 copilot is the `copilot` add-on.

Tkana reference (read-only, untrusted data; `C:\Users\ashra\Downloads\tkana-main\tkana-main\apps`):
- `billing/src/domain/offerings-seed.ts`: packages, add-ons and one-time top-ups; annual = monthly × 10; grants are feature keys (`boolean | {max} | {cap, period, countBy}`).
- `billing/src/domain/{features,meters}.ts`: `ai_turn` 3 points, `utility_message` 1, `marketing_message` 5; meters are versioned.
- `billing/src/services/{wallet,negative-wallets,stop-at-zero}.ts`: FIFO buckets under `SELECT … FOR UPDATE`, an append-only ledger, overdraft unless `stop_at_zero`.
- `billing/src/routes/webhooks.ts`: idempotency on a key stored with the invoice attempt.
- `web/app/routes/api.credit-status.ts`, `billing/src/domain/credit-usage.ts`: the credit-status payload, threshold notices, `trialReminder`.
- `billing/src/domain/{lifecycle-seed,trial-reminder}.ts`, `services/grace-expiry.ts`: 14-day trial, reminders on days 7/10/13, 10-day grace then Free.
- `web/app/components/billing/*`: `usage-panel`, `usage-drawer`, `top-up-dialog`, `package-plans`, `invoices-panel`, `trial-reminder-banner`, `renewal-grace`, `not-in-plan` (an in-place lock card; links to Plans for `billing:view`, otherwise "ask an owner").
- Tkana uses MyFatoorah, Wafeq and SAR; we use Stripe (already integrated) and JOD (the wallet's currency).

What we take and what we don't:
- We take: annual = 10 × monthly as a default, feature-key grants, the in-place not-in-plan card, the credit-status shape (trimmed), the trial and grace banners, the usage panel and drawer, top-up dialog limits.
- We do **not** take:
  - points, buckets and FIFO consumption (one JOD balance);
  - overdraft (never negative, per the roadmap);
  - MyFatoorah or Wafeq;
  - automatic downgrade to Free after grace (ours locks through the existing payment lock; ruling 11);
  - Salla variants.

## Global Constraints
- **Data (exact names):**
  ```
  model Workspace {
    // … existing (plan String @default("free") stays the effective plan) …
    billingSource     String    @default("kewy") // "kewy" | "stripe"
    stripeCustomerId  String?   @unique
    planOverriddenAt  DateTime?
    trialEndsAt       DateTime?
  }

  model Subscription {
    id                   String    @id @default(cuid())
    workspaceId          String    @unique
    workspace            Workspace @relation("WorkspaceSubscription", fields: [workspaceId], references: [id], onDelete: Cascade)
    planKey              String
    cycle                String    // "monthly" | "annual"
    status               String    // "trialing" | "active" | "past_due" | "unpaid" | "canceled" | "incomplete" | "incomplete_expired"
    currentPeriodEnd     DateTime?
    cancelAtPeriodEnd    Boolean   @default(false)
    addOns               Json      @default("[]") // [{key, qty}]
    stripeSubscriptionId String?   @unique
    trialEndsAt          DateTime?
    graceEndsAt          DateTime?
    stripeEventCreated   Int?      // unix seconds of the last applied event (ordering guard)
    createdAt            DateTime  @default(now())
    updatedAt            DateTime  @updatedAt
  }

  model UsageEvent {
    id             String    @id @default(cuid())
    workspaceId    String
    workspace      Workspace @relation("WorkspaceUsageEvents", fields: [workspaceId], references: [id], onDelete: Cascade)
    meter          String    // "ai_reply" | "campaign_message" | "ads_ai"
    qty            Int       @default(1)
    at             DateTime  @default(now())
    sourceKind     String
    sourceId       String
    idempotencyKey String    @unique
    walletTxId     String?   // the AdsWalletTransaction it charged, if any (no FK)

    @@index([workspaceId, meter, at])
  }

  model StripeEvent {
    id          String    @id // Stripe event id evt_…
    type        String
    receivedAt  DateTime  @default(now())
    processedAt DateTime?
  }

  model AdsWalletTransaction {
    // … existing …
    meter String? // SP-28: "ads_ai" | "ai_reply" | "campaign_message" for DEBIT; null for TOPUP/GRANT/ADJUST
  }
  ```
  - **Roadmap names kept:** `Subscription {planKey, cycle, status, currentPeriodEnd, addOns}`, `UsageEvent {meter, qty, at}`. The roadmap's `Wallet` is the existing `AdsWallet` table behind a `WalletService` facade (ruling 2), with no second balance.
- **Constants** (`billing/billing-constants.ts`):
  - `BILLING_GRACE_DAYS = PAYMENT_GRACE_DAYS` (ruling 11);
  - `TRIAL_REMINDER_DAYS = [7, 3, 1]`;
  - `TOPUP_MIN_JOD = ADS_MIN_TOPUP_JOD`, `TOPUP_MAX_JOD = ADS_TOPUP_MAX_JOD` (existing env);
  - `LOW_BALANCE_JOD = ADS_MIN_BALANCE_JOD`;
  - `STATUS_CACHE_MS = 30_000`.
- **API** (workspace-scoped; a foreign id gives **404**; every route in `permission-map.ts`):
  - `GET /billing/status`: `authenticated` (membership checked in the service; reduced payload without `billing.view`).
  - `GET /billing/catalog`: `billing.view` → plans, add-ons and prices with the env price availability.
  - `POST /billing/checkout/subscription`: `billing.manage`.
  - `POST /billing/subscription/change`, `/cancel`, `/resume`: `billing.manage`.
  - `POST /billing/portal`: `billing.manage`.
  - `GET /billing/payment-method`: `billing.view` → `{brand, last4, expMonth, expYear} | null` (from the Customer's default payment method).
  - `GET /billing/invoices`: `billing.view`.
  - `GET /billing/wallet`, `GET /billing/wallet/ledger?cursor`: `billing.view`.
  - `POST /billing/wallet/topup`: `billing.update` (the same as today's `POST /ads/wallet/topup`).
  - `GET /billing/usage?from&to`, `GET /billing/usage/daily?meter&from&to`: `billing.view`.
  - `POST /billing/webhook/stripe`: `public`.
  - `PATCH /admin/workspaces/:id` (existing, super-admin): sets `planOverriddenAt` with `plan`. `POST /admin/workspaces/:id/plan-override/clear` and `PATCH /admin/workspaces/:id/billing-source {source}` (super-admin; membership-exempt `/admin/*`).
- **Error keys** (`billing/billing-errors.ts`):
  - 400: `billing.invalid_plan`, `billing.invalid_cycle`, `billing.invalid_addon`, `billing.invalid_amount`, `billing.price_not_configured`;
  - 402: `PLAN_REQUIRED {feature, requiredPlan}` (flat `code`, like `ADS_INSUFFICIENT_BALANCE`), `WALLET_EMPTY`;
  - 409: `billing.kewy_managed` (a Stripe action on a Kewy workspace), `billing.subscription_exists`, `billing.no_subscription`;
  - 503: `billing.stripe_not_configured`.
  - Frontend `src/screens/billing/billingErrors.ts` has `tx` copy for every key.
- **Copy and layout:**
  - `tx("English","العربية")` everywhere: "Plans" / "الباقات", "Monthly" / "شهري", "Annual (2 months free)" / "سنوي (شهران مجانًا)", "Wallet" / "المحفظة", "Top up" / "شحن الرصيد", "Usage" / "الاستهلاك", "Invoices" / "الفواتير", "Payment method" / "طريقة الدفع", "Not in your plan" / "غير متاح في باقتك", "Upgrade" / "ترقية", "Ask an owner to upgrade" / "اطلب من المالك الترقية", "Your trial ends in {n} days" / "تنتهي فترتك التجريبية خلال {n} أيام", "Payment failed: update your card by {date}" / "فشل الدفع: حدّث بطاقتك قبل {date}".
  - Money: `Intl.NumberFormat(lang === "ar" ? "ar-JO-u-nu-latn" : "en-JO", {style: "currency", currency: "JOD", minimumFractionDigits: 3})` in `<bdi>`.
  - Logical CSS; dialogs set `dir`; dates in the workspace timezone.
- **Permissions (SP-25).** No catalogue change. `system-role-decisions.spec.ts` adds an `SP-28 billing routes` block:
  - Owner: everything.
  - Admin: view and top-up (`billing.update`), but 403 on subscription changes and portal (`billing.manage`).
  - Agent and viewer: only `/billing/status` (reduced).
  - Impersonation blocked on every `billing.*` (already).
- **Secrets and money:**
  - `STRIPE_SECRET_KEY`, `STRIPE_BILLING_WEBHOOK_SECRET` and Customer Portal URLs are never logged.
  - Card data never touches our servers (Stripe-hosted pages only).
  - Amounts are `Decimal`; JOD is sent to Stripe in fils (×1000, the existing convention).
- **Outbound calls:** every spec uses a fake `PaymentGateway`/Stripe client. No spec calls Stripe. Verification points the SDK at a loopback stub (`STRIPE_API_HOST=127.0.0.1`).
- **Migration:**
  - `backend/prisma/migrations/20261118140000_billing_portal/migration.sql`, after SP-27's `20261118130000_api_keys_webhooks`. Hand-written, LF, `SET lock_timeout = '5s'` first, `migrate deploy` only; never edit an applied migration.
  - **Additive and idempotent:**
    ```sql
    ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "billingSource" TEXT NOT NULL DEFAULT 'kewy',
                            ADD COLUMN IF NOT EXISTS "stripeCustomerId" TEXT,
                            ADD COLUMN IF NOT EXISTS "planOverriddenAt" TIMESTAMP(3),
                            ADD COLUMN IF NOT EXISTS "trialEndsAt" TIMESTAMP(3);
    CREATE UNIQUE INDEX IF NOT EXISTS "Workspace_stripeCustomerId_key" ON "Workspace"("stripeCustomerId");
    CREATE TABLE IF NOT EXISTS "Subscription" (… as modelled …, CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id"));
    CREATE UNIQUE INDEX IF NOT EXISTS "Subscription_workspaceId_key" ON "Subscription"("workspaceId");
    CREATE UNIQUE INDEX IF NOT EXISTS "Subscription_stripeSubscriptionId_key" ON "Subscription"("stripeSubscriptionId");
    CREATE TABLE IF NOT EXISTS "UsageEvent" (…, CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id"));
    CREATE UNIQUE INDEX IF NOT EXISTS "UsageEvent_idempotencyKey_key" ON "UsageEvent"("idempotencyKey");
    CREATE INDEX IF NOT EXISTS "UsageEvent_workspaceId_meter_at_idx" ON "UsageEvent"("workspaceId","meter","at");
    CREATE TABLE IF NOT EXISTS "StripeEvent" ("id" TEXT NOT NULL, "type" TEXT NOT NULL,
      "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "processedAt" TIMESTAMP(3),
      CONSTRAINT "StripeEvent_pkey" PRIMARY KEY ("id"));
    ALTER TABLE "AdsWalletTransaction" ADD COLUMN IF NOT EXISTS "meter" TEXT;
    -- FKs in DO $$ … duplicate_object blocks: Subscription_workspaceId_fkey (CASCADE), UsageEvent_workspaceId_fkey (CASCADE).
    ```
  - `prisma migrate diff` (no DB) equals the file apart from `IF NOT EXISTS`, the `DO` wrappers and `lock_timeout`.
  - **Safe for the deployed `main`:**
    - `billingSource` has a constant default (metadata-only), and the other columns are nullable;
    - `main`'s `AdsWalletTransaction` inserts omit `meter`;
    - the existing `/ads/webhook/stripe` keeps working (unchanged until SP-28 ships, then an alias);
    - the unique index on `stripeCustomerId` covers an all-null column (instant);
    - no `UPDATE`, `DELETE`, `DROP` or `ALTER … TYPE`.
  - **No backfill.** Every workspace starts `kewy` with no `Subscription`.
- **Tests:**
  - backend: `npx jest src/billing src/ads src/admin src/joteck src/channels/channel-limits src/permissions src/campaigns src/integrations/ai-reply` + `npx tsc --noEmit -p tsconfig.json`; the full `npm test` once per task.
  - frontend: `npx vitest run`, `npm run typecheck`; `npm run build` once in Task 3.
  - **Named acceptance tests (exact names):**
    - `webhook idempotent on replay` (backend jest, `src/billing/billing-webhook.spec.ts`)
    - `feature gated by plan returns 402 PLAN_REQUIRED and UI shows upgrade`: two halves under the same name. The backend jest half is `src/billing/plan-feature.guard.spec.ts` (the 402 body). The frontend vitest half is `src/screens/billing/planGate.test.ts` (`gateFor(status, feature)` returns `{kind: "upgrade", canManage}`, and the `PLAN_REQUIRED` `ApiError` maps to the same upgrade state).
    - `wallet never goes negative under concurrent debits` (backend jest, `src/billing/wallet.service.spec.ts` over the in-memory double with the conditional decrement, **and** `src/billing/wallet.db.spec.ts` against real Postgres, skipped without `BILLING_TEST_DATABASE_URL`; Task 4 runs it)
- **Commits:** selective `git add <paths>`, never `-A`. Trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not stage `.playwright-mcp/`, `.claude/worktrees/` or any untracked file this plan did not create.

## Review Focus
1. **Money never goes wrong under concurrency or replay.**
   - Concurrent debits never take the balance below zero.
   - A replayed or out-of-order webhook never credits twice nor moves a subscription backwards.
   - A double-click on checkout makes one Stripe customer.
   - Tests:
     - `wallet never goes negative under concurrent debits`
     - `webhook idempotent on replay`
     - `older subscription event does not overwrite newer state`
     - `one stripe customer per workspace under concurrent checkout`
     - `topup credited once across ads and billing webhooks`
2. **Two billing systems never fight.**
   - Kewy workspaces ignore Stripe actions (409 `billing.kewy_managed`).
   - Stripe workspaces ignore Joteck `billing-state`.
   - Admin overrides survive webhooks until cleared.
   - Tests:
     - `joteck billing-state ignored for stripe workspaces`
     - `stripe checkout refused for kewy workspace`
     - `admin override survives subscription webhook`
3. **Gating never takes away what a customer has today.**
   - On deploy, every existing workspace's effective plan includes everything it uses today.
   - A 402 is used only for plan gating, never for permissions (403) or the payment lock (403 `PAYMENT_OVERDUE`).
   - Tests:
     - `feature gated by plan returns 402 PLAN_REQUIRED and UI shows upgrade`
     - `grandfathered plans keep every current feature`
     - `super-admin and impersonator bypass plan gate`
4. **Metering never breaks sending.**
   - Usage recording is idempotent per source and outside the send's critical path; a metering failure does not fail an AI reply or a campaign send.
   - Tests:
     - `usage recorded once per message`
     - `usage failure does not fail the ai reply`
5. **Lock mapping.**
   - `past_due` starts the existing grace clock, `paid` clears it, and `canceled` by downgrade does not lock.
   - Tests:
     - `subscription status drives payment lock`
     - `downgrade to free does not lock`

## Architecture Rulings and Risks
Each item names the risk, then the recommended ruling. Items marked **(needs controller ruling)** are repeated under Controller rulings.

1. **Who bills a workspace.**
   - Today Kewy/Joteck drive the payment lock (`POST /joteck/workspaces/:id/billing-state`), and the lock screen links to the external Kewy billing page (`VITE_KEWY_BILLING_URL`). The roadmap wants Stripe Billing in-app.
   - **Ruling:** `Workspace.billingSource` (default `kewy`).
     - Stripe flows are available only for `stripe` workspaces, and only when `BILLING_STRIPE_ENABLED=1`.
     - Kewy-provisioned workspaces (`kewyWorkspaceId` set) stay `kewy` unless a super-admin flips them.
     - Joteck's `billing-state` is ignored for `stripe` workspaces.
   - **Alternatives:** Stripe for all workspaces (needs a migration plan with Kewy); or keep Kewy as the only biller and make SP-28 a read-only portal over Kewy data (needs a Kewy billing API we have not seen). **(needs controller ruling)**
2. **One wallet.** The roadmap says "one `Wallet` generalises `AdsWallet`". Copying balances into a new table while the deployed `main` keeps debiting `AdsWallet` would split the money.
   - **Ruling:** keep the `AdsWallet` tables as the single wallet store, add `AdsWalletTransaction.meter`, and put a `WalletService` facade over them. New meters use refuse-on-insufficient; the ads meter keeps its drain-to-zero behaviour (unchanged code). A table rename is deferred to a cleanup after `main` no longer uses the old code.
   - **Alternative:** a new `Wallet` table plus a one-off balance move during a maintenance window. **(needs controller ruling)**
3. **Prices, allowances and feature placement** are business decisions not present in the repo.
   - **Ruling:** the plan ships the catalogue structure with placeholder values flagged `TODO(user)`, Stripe price ids from env, and `GET /billing/catalog` hiding any plan or cycle whose price id is unset. Task 1 cannot be marked done until the user supplies the table (prices in JOD, allowances, feature placement). Annual = 10 × monthly is the default (Tkana).
   - **(needs controller ruling, user input)**
4. **Grandfathering.**
   - **Ruling:** v1 gates only features new in Phase 3–6 and only on `free`. `starter|growth|pro` include every feature. Narrower gating needs the user's per-plan table and a customer notice.
   - **Alternative:** full gating per the user's table from day one. **(needs controller ruling)**
5. **Embedded checkout and card management.** The roadmap says "embedded checkout". That needs `@stripe/stripe-js` (a new dependency) and a CSP change for `js.stripe.com`.
   - **Ruling:** v1 uses hosted Checkout (the existing ads pattern) for top-ups and subscriptions, and the hosted Customer Portal for payment methods. No new dependency and no card data in our origin. Embedded Checkout (`ui_mode: "embedded"`) is a follow-up behind approval of `@stripe/stripe-js`.
   - **Alternative:** add `@stripe/stripe-js` now. **(needs controller ruling)**
6. **Charging usage to the wallet.**
   - Metering AI replies and campaign messages is safe. Charging them, and stopping AI replies when the wallet is empty, changes what customers pay and receive.
   - **Ruling:** record usage for every meter; `meteredBilling` is off for every plan in v1; the usage panel shows usage against allowances. Turning charging on is a per-plan constant change after the user approves prices.
   - **(needs controller ruling)**
7. **Tax invoices (D4).**
   - **Ruling:** Stripe invoices with Stripe's PDF and hosted page links, with no PDF library.
     - Tax setup (Stripe Tax, or fixed tax rates such as Jordan GST 16% / KSA VAT 15%) is a Stripe Dashboard configuration and a user action.
     - Legal e-invoicing (ZATCA/JoFotara) is not covered; Wafeq is deferred per D4.
   - **(needs controller ruling)**
8. **Admin overrides vs webhooks.**
   - **Ruling:** the admin plan PATCH sets `planOverriddenAt`. While it is set, webhooks update `Subscription` but not `Workspace.plan`. `effectivePlan` = the override. "Clear override" returns to the subscription's plan. The override is audited.
   - **(needs controller ruling, minor)**
9. **Plan changes.**
   - **Ruling:** upgrade and downgrade apply immediately with Stripe proration. Cancel = at period end. Cycle switches apply immediately with proration.
   - **Alternative:** downgrades at period end via Subscription Schedules (more code, more Stripe states). **(needs controller ruling, minor)**
10. **One webhook endpoint or two.**
    - **Ruling:** a new `/billing/webhook/stripe` with its own secret (`STRIPE_BILLING_WEBHOOK_SECRET`) for subscription and invoice events and new top-ups. The existing `/ads/webhook/stripe` stays for in-flight ads checkouts, and both credit through one `WalletService.credit` with the `externalRef` guard (no double credit). The user registers the new endpoint in the Stripe Dashboard.
    - **(needs controller ruling)**
11. **Grace length and what happens after.**
    - **Ruling:** reuse `PAYMENT_GRACE_DAYS = 2` and the existing lock (data kept, full-screen lock with a "Fix payment" button that opens the Customer Portal). No automatic downgrade to Free.
    - **Alternative:** Tkana's 10 days then Free. **(needs controller ruling)**
12. **Trial.**
    - **Ruling:** trials come from Stripe (`trial_period_days` on the checkout, from a catalogue constant). `Workspace.trialEndsAt` mirrors it. The banner shows from 7 days before the end. Trial reminder emails (SP-26 port) are deferred. Kewy's `trialEndsAt` (received at login, unused) is not imported.
    - **(needs controller ruling, minor)**
13. **Currency.** The wallet is in JOD and Stripe JOD is a 3-decimal currency.
    - **Ruling:** subscriptions are priced in JOD too (one currency per customer is a Stripe constraint).
    - **Alternative:** USD subscriptions with a separate Customer, rejected because Stripe customers are single-currency. **(needs controller ruling)**
14. **Shared files** with SP-26/27/29: `schema.prisma`, `permission-map.ts`, `system-role-decisions.spec.ts`, `Settings.tsx`, `App.tsx`, `src/api/client.ts`, `admin.*`, `auth.module.ts` (a third APP_GUARD).
    - **Ruling:** base on the SP-27 ship commit; Task 1 owns the schema; the migration applies after SP-27's. **(needs controller ruling)**
15. **Verification touches production** (as SP-09 R12).
    - Task 4 runs against the production DB in throwaway workspaces, with a **loopback Stripe stub** (`STRIPE_API_HOST=127.0.0.1`, `STRIPE_API_PROTOCOL=http`, `STRIPE_SECRET_KEY=sk_test_zz_verify_stub`) and webhook events signed locally with a test secret.
    - No request reaches Stripe, and no real payment is made.
    - The migration needs the user's **explicit approval**.
    - **(needs controller ruling)**
16. **Size.** XL: 3 build tasks plus verification, plus a user-input dependency (ruling 3). **(needs controller ruling, minor)**

### Controller rulings
*Pending. The controller fills in each decision below before Task 1 starts. The migration `20261118140000_billing_portal` needs explicit user approval before it runs.*
- **R1** (`billingSource` kewy|stripe; Stripe only for opted-in workspaces; Joteck ignored for Stripe ones): _pending_
- **R2** (AdsWallet tables are the single wallet; `meter` column; ads keeps drain-to-zero): _pending_
- **R3** (prices, allowances and feature placement from the user; placeholders hidden until set): _pending_
- **R4** (grandfathering: gate only new features on free in v1): _pending_
- **R5** (hosted Checkout and Customer Portal; no `@stripe/stripe-js` in v1): _pending_
- **R6** (meter everything, charge nothing in v1): _pending_
- **R7** (Stripe invoices and PDFs; tax configured in Stripe by the user; e-invoicing deferred; D4): _pending_
- **R8** (admin override flag survives webhooks): _pending_
- **R9** (immediate prorated plan changes; cancel at period end): _pending_
- **R10** (a separate billing webhook endpoint and secret; ads endpoint kept): _pending_
- **R11** (2-day grace, existing lock, no auto-downgrade): _pending_
- **R12** (Stripe trials; banner only; reminder emails deferred): _pending_
- **R13** (JOD for subscriptions): _pending_
- **R14** (base on the SP-27 ship commit; Task 1 owns the schema): _pending_
- **R15** (verification with a loopback Stripe stub on the production DB; migration needs explicit user approval): _pending_
- **R16** (size XL; 3 build tasks + verification): _pending_

---

### Task 1: Backend — schema, migration, catalogue, Stripe customer and subscription, webhook, lock mapping
**Owns:** `schema.prisma` and the migration for all of SP-28.

**Files:**
- `backend/prisma/schema.prisma`; `migrations/20261118140000_billing_portal/migration.sql`; `backend/src/billing/billing-portal-migration.spec.ts`.
- Create in `backend/src/billing/`, each with a spec:
  - `plan-catalog.ts` (`PLANS`, `ADD_ONS`, `FEATURES`, `effectivePlan`, `planIncludes`, `priceIdFor`, `planForPriceId`);
  - `billing-constants.ts`, `billing-errors.ts`;
  - `stripe/stripe-client.ts` (pinned `apiVersion`, optional host/port/protocol);
  - `billing-customer.service.ts`, `subscription.service.ts` (checkout, change, cancel, resume, portal, invoices, payment method);
  - `subscription-lock.ts` (pure mapping);
  - `billing-webhook.controller.ts` + `billing-webhook.service.ts` (`StripeEvent` dedupe, the ordering guard);
  - `billing.controller.ts`.
  - The test doubles extend `channels/test-prisma.ts` with `subscription`, `usageEvent`, `stripeEvent`.
- `backend/src/joteck/joteck.service.ts`: ignore `stripe` workspaces. `backend/src/admin/*`: `planOverriddenAt`, clear override, billing source.
- `backend/src/billing/billing.module.ts`: no longer only `PaymentLockService`; still `@Global()`.
- `permission-map.ts` + spec, `system-role-decisions.spec.ts` (`SP-28 billing routes`).
- `backend/.env.example`: `BILLING_STRIPE_ENABLED`, `STRIPE_BILLING_WEBHOOK_SECRET`, `STRIPE_PRICE_*`, `STRIPE_API_HOST|PORT|PROTOCOL` (documented as test-only).

- [ ] Write the failing tests:
  - `migration is additive, idempotent and Prisma-named (SP-28)` (the SP-26 checklist; the folder name is greater than `20261118130000`; earlier sha256 values pinned).
  - **`webhook idempotent on replay`**:
    - the same signed `customer.subscription.updated` delivered twice → one `Subscription` write, one `AuditLog`, the second response `{duplicate: true}`;
    - the same `checkout.session.completed` top-up twice → one credit;
    - a bad signature → 400 and no `StripeEvent` row.
  - `older subscription event does not overwrite newer state` (created 200 then 100 → state of 200 stays).
  - `topup credited once across ads and billing webhooks` (the same session id through both endpoints → one credit).
  - `one stripe customer per workspace under concurrent checkout` (two parallel `ensureCustomer` with the fake gateway → one `customers.create`).
  - `subscription status drives payment lock` (`active` → ok; `past_due` → due clock; `unpaid` → ended; `invoice.paid` → ok); `downgrade to free does not lock`.
  - `joteck billing-state ignored for stripe workspaces`; `stripe checkout refused for kewy workspace` (409 `billing.kewy_managed`).
  - `admin override survives subscription webhook`; `clear override restores subscription plan`.
  - `catalog hides plans without price ids`; `invoices map stripe fields and never cache`.
  - `no stripe secret or portal url in any log line`.
  - `permission map covers SP-28 routes`; the `SP-28 billing routes` block.
- [ ] Implement until green; tsc; the jest paths; the full `npm test` once; `npx prisma generate`. **Do not run `migrate`.**
- [ ] Commit `feat(billing): stripe subscriptions, plan catalogue, idempotent billing webhook and lock mapping`.

### Task 2: Backend — wallet facade, usage metering, plan gating, credit status
**Depends on:** Task 1.

**Files:**
- Create in `backend/src/billing/`, each with a spec:
  - `wallet.service.ts`;
  - `wallet.db.spec.ts` (skipped without `BILLING_TEST_DATABASE_URL`; creates and deletes its own workspace);
  - `usage.service.ts`;
  - `plan-feature.decorator.ts`, `plan-feature.guard.ts`, `plan-feature-map.ts`;
  - `billing-status.service.ts`.
- `backend/src/ads/ads-wallet.service.ts`: write `meter: "ads_ai"` on debits and record `UsageEvent`; `ads.controller.ts` topup delegates to `WalletService`.
- Usage hooks: `integrations/ai-reply.controller.ts`, `l-outbound.service.ts`, `l-webhooks.service.ts`, `campaigns/campaign-send.service.ts`, `campaigns/sending/campaign-launch-runner.service.ts` (after commit, try/catch, logged).
- `backend/src/auth/auth.module.ts`: the third `APP_GUARD` `PlanFeatureGuard` (after `PermissionGuard`; ordering comment).
- Gated controllers per `plan-feature-map.ts` (only the routes ruling 4 allows).
- `realtime`: `billing.updated` emits from the wallet and subscription services.

- [ ] Write the failing tests:
  - **`wallet never goes negative under concurrent debits`**:
    - balance 1.000 JOD; 20 parallel debits of 0.100 → exactly 10 succeed, 10 get 402 `WALLET_EMPTY`; final balance 0.000; ledger sum equals −1.000; no `UsageEvent` for the refused ones;
    - the DB spec repeats it against Postgres with real concurrency (separate connections) and also asserts the CHECK rejects a raw `UPDATE` below zero.
  - `debit is idempotent per idempotencyKey` (a replay returns the first result and does not charge again).
  - `ads meter keeps drain-to-zero` (existing `ads-wallet.service.spec.ts` stays green).
  - **`feature gated by plan returns 402 PLAN_REQUIRED and UI shows upgrade`** (backend half):
    - a `free` workspace on a gated route → 402 body `{statusCode: 402, code: "PLAN_REQUIRED", feature, requiredPlan: "starter"}`;
    - `starter` → passes;
    - the 402 is raised only after `PermissionGuard` (a member lacking the permission still gets 403).
  - `grandfathered plans keep every current feature` (every route existing before SP-28 passes for `starter|growth|pro`); `super-admin and impersonator bypass plan gate`; `plan feature map routes exist in the permission map`.
  - `usage recorded once per message` (an AI reply recorded twice through webhook retry → one `UsageEvent`); `usage failure does not fail the ai reply` (`usage.record` throws → the reply is still delivered).
  - `usage summary buckets by workspace timezone`.
  - `credit status reduced without billing.view` (no wallet/usage keys); `banners computed from trial and grace dates`.
- [ ] Implement until green; tsc; jest; the full `npm test` once.
- [ ] Commit `feat(billing): wallet facade, usage metering, plan gating and credit status`.

### Task 3: Frontend — billing tab, usage, wallet, invoices, banners, not-in-plan
**Depends on:** Tasks 1–2 contracts.

**Files:**
- **F1 Model (pure):**
  - `src/screens/billing/planCatalog.ts` (mirror);
  - `planGate.ts` (`gateFor(status, feature) → {kind:"ok"} | {kind:"upgrade", requiredPlan, canManage}`, `fromApiError(err)`);
  - `bannerModel.ts` (`bannersFor(status, now, dismissed)`: trial days 7/3/1, grace countdown, low balance);
  - `money.ts` (JOD formatting);
  - `billingErrors.ts`.
  - Tests: `planGate.test.ts`, `bannerModel.test.ts`, `money.test.ts`, `billingErrors.test.ts`, `planCatalog.test.ts`.
- **F2** `src/api/client.ts`: 402 handling (`ApiError.code = "PLAN_REQUIRED"` with `data.feature`); a `onPlanRequired` hook like `onPaymentOverdue`.
- **F3 Billing tab** (`Settings.tsx`: `billing` tab, gated `can("billing.view")`):
  - `src/screens/settings/BillingTab.tsx`:
    - current plan card;
    - `PlanPicker.tsx` (cycle switch, plans, add-ons; Kewy workspaces show read-only plus the external link);
    - `WalletCard.tsx` + `TopUpDialog.tsx` (amount limits; redirects to Checkout; handles `?checkout=success|cancel` and `?topup=`);
    - `UsagePanel.tsx` + `UsageDrawer.tsx` (daily breakdown);
    - `PaymentMethodCard.tsx` ("Manage" → portal);
    - `InvoicesPanel.tsx` (PDF / view links, `rel="noopener noreferrer"`).
- **F4 Shell:**
  - `src/shell/BillingBanner.tsx` under the topbar (trial / grace / low balance; dismiss per day in localStorage);
  - the sidebar credit chip (`billing.view` only);
  - `useBillingStatus()` (poll 60 s plus the realtime `billing.updated`).
  - `PaymentLocked.tsx`: Stripe workspaces get "Fix payment" (portal); Kewy ones keep the external link.
- **F5** `src/components/NotInPlan.tsx`: an in-place card with Upgrade (to `#/settings?tab=billing`) or "Ask an owner to upgrade". It is used by the gated screens listed in `plan-feature-map.ts` and by any 402 caught through `onPlanRequired`.
- **F6 Admin:** `Admin.tsx` shows "Overridden" with "Clear override", and the billing source switch.
- **F7 Types** in `src/lib/types.ts`.

- [ ] Write the failing vitest tests:
  - **`feature gated by plan returns 402 PLAN_REQUIRED and UI shows upgrade`** (frontend half):
    - `gateFor` returns `upgrade` with `canManage` true for `billing.manage` and false otherwise;
    - `fromApiError` of a 402 `PLAN_REQUIRED` gives the same state;
    - any other 402 (`WALLET_EMPTY`) is not an upgrade.
  - `trial banner on days 7, 3 and 1 only`; `grace banner counts down to the lock`; `dismissed banner stays hidden that day`.
  - `money formats JOD with three decimals and Latin digits in Arabic`.
  - `billing error copy covers every SP-28 key in both languages`; `plan catalogue mirrors the backend keys`.
- [ ] Implement; `npx vitest run`, `npm run typecheck`, `npm run build` clean.
- [ ] Commit `feat(billing): billing tab, wallet and usage, invoices, banners and not-in-plan card`.

### Task 4: Verification
Apply `20261118140000_billing_portal` only with explicit controller and user approval (ruling 15). Results go to `.superpowers/sdd/2026-11-18-sp28-billing-portal/live-verification.md` (SP-15 format).

**Before approval (read-only, production):**
- `SELECT count(*) FROM "Workspace"`, `SELECT plan, count(*) FROM "Workspace" GROUP BY plan`.
- `SELECT count(*), sum("balanceJod") FROM "AdsWallet"`, `SELECT count(*) FROM "AdsWalletTransaction"`.
- These record the wallet totals so that it can be shown they are unchanged.

**Isolation** (scratchpad `C:\Users\ashra\AppData\Local\Temp\claude\7b75a64029a712a6\ebb2057a-6300-4548-9aec-b98487880afb\scratchpad\`):
- **Own instance:** `launch-sp28.js` (from `launch-sp27.js`), backend **:4270**, outDir `backend/.verify-dist-sp28`, working directory `sp28-run/`. Crons disabled. Storage env empty.
- **Stripe stub:**
  - `stripe-stub-sp28.js` on `http://127.0.0.1:4269` implements the endpoints the code calls: `customers` create/retrieve, `checkout/sessions` create, `billing_portal/sessions` create, `subscriptions` retrieve/update, `invoices` list, `payment_methods` retrieve.
  - It returns fixed-shape objects and records every call to `stripe-stub-sp28-calls.jsonl`.
  - Env: `STRIPE_API_HOST=127.0.0.1`, `STRIPE_API_PORT=4269`, `STRIPE_API_PROTOCOL=http`, `STRIPE_SECRET_KEY=sk_test_zz_verify_stub`, `STRIPE_BILLING_WEBHOOK_SECRET=whsec_zz_verify`, `STRIPE_WEBHOOK_SECRET=whsec_zz_verify_ads`, `STRIPE_PRICE_*` test ids, `BILLING_STRIPE_ENABLED=1`.
  - Webhook events are built by the script and signed with `stripe.webhooks.generateTestHeaderString` using the test secret.
- **No external call, ever:** Zernio, Meta, l, OpenAI, HJZ, Kewy, email: every key and base URL is an empty string.
- **The launcher refuses to start** unless `STRIPE_API_HOST=127.0.0.1`, `STRIPE_SECRET_KEY` starts with `sk_test_zz_verify`, and the other provider variables are empty.
- The egress guard stays, and `blocked-egress-sp28.jsonl` must be empty.
- Test tag `zz-verify-<ts>`.

**Setup** (ids in `verify-created-sp28.json`):
1. Workspace S (switched to `stripe` by the script through the super-admin route with a test super-admin user created for the run, then deleted) and workspace K (`kewy`), each with an owner, an admin and an agent.
2. Record before-counts.

**Checks:**
- **Migration:** columns, tables and indexes exist; `SELECT count(*) FROM "Workspace" WHERE "billingSource" <> 'kewy'` = 0 right after apply; the `AdsWallet` sum is unchanged.
- **Subscription:**
  - checkout as S's owner → the stub received one customer and one session;
  - replaying the signed `checkout.session.completed` + `customer.subscription.created` → `Subscription` active, `Workspace.plan = growth`;
  - replaying both again → `{duplicate:true}` and no change (**`webhook idempotent on replay`, live**);
  - an older event → ignored;
  - `invoice.payment_failed` → `past_due`, `paymentDueSince` set, the grace banner in status;
  - `invoice.paid` → cleared;
  - K's owner checkout → 409 `billing.kewy_managed`;
  - Joteck `billing-state ended` for S (with the Joteck test secret) → ignored.
- **Admin override:** set `pro` → a subscription event leaves `pro`; clear → `growth`.
- **`wallet never goes negative under concurrent debits` (live):** run `wallet.db.spec.ts` with `BILLING_TEST_DATABASE_URL` = production, confined to its own throwaway workspace (green). Then, via the API: top-up 1.000 JOD through the signed webhook, 20 parallel debits of 0.100 on the test hook → 10 succeed; balance 0.000; the CHECK holds.
- **`feature gated by plan returns 402 PLAN_REQUIRED and UI shows upgrade` (live):** S moved to `free` by a signed `customer.subscription.updated` → a gated route → 402 body as specified; an agent lacking the permission → 403 (not 402); the UI shows the NotInPlan card (verify skill).
- **Usage:**
  - The AI-reply and campaign paths need providers that are stubbed out, so the script calls the compiled `UsageService.record` (from `.verify-dist-sp28`) for S twice with the same source → one `UsageEvent`.
  - `GET /billing/usage` shows it against the plan allowance.
  - The hook wiring itself is proven by the Task 2 specs. The report says so.
- **Invoices and portal:** `GET /billing/invoices` maps the stub's two invoices; portal returns the stub URL; nothing is logged (grep for `sk_test`, `whsec_` and the portal URL → 0).
- **Roles:** the `SP-28 billing routes` block (admin 403 on change/portal; agent only status).
- **Migration rerun** in an always-rolled-back transaction.
- **UI through the `verify` skill:** the billing tab (plans, wallet, usage drawer, invoices, payment method), the banners, the NotInPlan card, Admin override badge, in English and Arabic (RTL); screenshots.

**Cleanup:**
- Delete the recorded workspaces (the cascade covers the subscription, usage events, `AdsWallet` and its transactions; `AdsWalletTransaction.wallet` is `Restrict`, so delete transactions first, then wallets, then workspaces), the test users and the run's `StripeEvent` rows (by recorded ids).
- Delete the stub logs.
- Residue sweep over every table with a `workspaceId` column, plus `StripeEvent`.
- Before/after counts: `Workspace`, `User`, `WorkspaceMember`, `Subscription`, `UsageEvent`, `StripeEvent`, `AdsWallet`, `AdsWalletTransaction`, `AuditLog`. Every count and the `AdsWallet` sum identical.
- Stop :4270 and the stub; remove the outDir and `sp28-run/`.

Then tick SP-28's boxes with rulings and deviations. Pending user actions:
- supply the catalogue values (ruling 3);
- create the Stripe products and prices and set the `STRIPE_PRICE_*` env;
- register `…/api/billing/webhook/stripe` in the Stripe Dashboard and set `STRIPE_BILLING_WEBHOOK_SECRET`;
- configure the Customer Portal and tax;
- set `BILLING_STRIPE_ENABLED=1` when ready.

Deferred: embedded checkout, usage charging, trial emails, e-invoicing (D4) and the wallet table rename.


### User decisions (2026-11-16)
- Billing source of truth stays **Kewy/Joteck** (no Stripe). SP-28 builds read-only billing status, usage metering and plan-feature gates on Kewy data. The Stripe tasks are dropped.
