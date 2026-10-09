# Automations builder, UI-only phase

Date: 2026-09-13
Status: approved design, awaiting implementation plan

## Revision 2026-09-14: guided wizard replaces the card builder

After a hands-on review the user rejected the single-column card builder
(too many clicks, drag handles felt like a developer tool, the template list
with warnings was confusing, and the look did not match the app). The builder
was replaced with a three-step wizard that mirrors the existing Campaigns
wizard:

- **Shell:** back arrow, editable name, Enabled toggle; pill stepper
  `01 When — 02 Messages — 03 Review`; full-width two-column layout with the
  shared `PhonePreview` (extracted from Campaigns into `src/components/`) on the
  right, plus an email preview card under it when Email is on.
- **Step 1, When:** six colored trigger tiles with icons; settings for the chosen
  trigger appear under the tiles (same six triggers and settings as before).
- **Step 2, Messages:** two channel panels, WhatsApp (green) and Email (blue),
  each with an on/off toggle, a template dropdown (incompatible templates are
  listed but disabled with a short reason), a "Send" timing select
  (Immediately, after 1 hour, 1 day, 2 days, 3 days, 7 days, custom), and for
  Email an editable subject. No cards, no drag, no add-step menu.
- **Step 3, Review:** a timeline of trigger and messages with rendered text, then
  "Turn on" (or "Save" when the Enabled toggle is off).
- **List page:** rows show the trigger's colored icon, an Active/Paused pill,
  channel icons, and run stats; recipes are colored tiles with channel badges.
- **Data shape unchanged.** `src/screens/automations/wizard.ts` maps the two
  channel panels to and from the persisted `steps` array
  (`[wait?, whatsapp, wait?, email]`), so the store, catalog, summarizer, and
  tests are untouched. Consequence: the wizard edits at most one WhatsApp and
  one Email step per rule; extra steps saved by the old builder are dropped on
  the next save.
- Removed: `AutomationBuilder.tsx`, `StepCard.tsx`, `TriggerPicker.tsx`.
  `TemplatePicker.tsx` now only holds `TemplatePreview` and `warningText`.

## Goal

Let a workspace user build a simple automation rule in tkana without training:
"When X happens, send WhatsApp template A, wait N days, send email template B."
This phase ships the complete user experience with local persistence only. No
backend model, no event dispatcher, no message sending. The data shape is chosen
so the backend phase is CRUD plus a dispatcher, with no frontend rework.

The reference screenshot (a generic step builder with per-variable mapping
fields) is the bar to beat on simplicity. The key decisions that make this
easier:

- Sentence-style single column instead of a canvas or side panel.
- Templates carry named tokens, so the user never maps variables.
- Exactly three step types: Send WhatsApp, Send Email, Wait.

## Placement

- New nav item "Automations" (Arabic: "الأتمتة") in the Workspace section,
  directly after Campaigns, using the existing `IconBolt`.
- Route id `automations`, hash `#/automations`. Added to `RouteId`, the lazy
  screen map in `src/router.tsx`, and `NAV` plus `TITLES` in `src/shell/nav.ts`.
- Page title: EN "Automations", AR "الأتمتة".

## Screens

### 1. Automations list

- Header via the existing `PageHeader` with a "New automation" primary button.
- Each automation is a row card showing:
  - Name.
  - Sentence summary generated from the rule, e.g. "When a deal moves to Won →
    WhatsApp: Thank you → wait 2 days → Email: Onboarding". Uses the trigger and
    step labels from the catalog, so it is bilingual for free.
  - Enabled toggle (existing `Toggle` component). Toggling saves immediately.
  - Mock stats: run count and last run, shown muted. Zero and "Never" for new
    rules.
  - Clicking the card opens the builder for that rule. A hover delete action
    asks for confirmation with the existing `Modal`.
- Empty state: short line of copy plus three starter recipe cards. Clicking a
  recipe opens the builder prefilled:
  - Welcome new contact: trigger New contact added → WhatsApp "Welcome".
  - Deal won thank-you: trigger Deal moves to stage (first Won stage) →
    WhatsApp "Thank you" → Wait 2 days → Email "Onboarding".
  - Appointment reminder: trigger Appointment coming up 24 hours before →
    WhatsApp "Appointment reminder".

### 2. Builder

Single centered column, max width about 640px. Navigation between list and
builder is local component state inside the automations page, not a new hash
route, matching how other screens handle sub-views.

Top bar: Back to list, editable name input, Enabled toggle, Save button. The name
is auto-suggested as "<trigger label> → <first action label>" until the user
edits it; after a manual edit it is never overwritten.

Trigger card, labelled "When…":

- Unset state: a large dashed card "Choose what starts this automation". Clicking
  shows a grid of the six triggers, each with an icon and one-line description.
- Set state: shows the trigger label and its settings inline. Settings are
  rendered inside the card, no panel:
  - New contact added: no settings.
  - Deal moves to a stage: pipeline select, then stage select. Stages come from
    the existing pipeline API (`useFetch`) so real stage names appear. Won and
    Lost are ordinary stages here.
  - New conversation starts: channel select with Any, WhatsApp, Instagram,
    Facebook.
  - Appointment booked: no settings.
  - Appointment coming up: hours-before select with 1, 2, 24, 48.
  - Tag added to contact: tag select from the existing tags API.
- A "Change" link swaps back to the grid. Changing the trigger keeps the steps
  but re-runs token validation (see below).

Step cards below the trigger, joined by a thin vertical line:

- Send WhatsApp: shows the chosen template name, language badge, and the body
  rendered with sample data. Unset state shows the template picker inline.
- Send Email: subject line (pre-filled from the template, editable) plus the
  same picker and preview for the email body.
- Wait: chips 1 hour, 1 day, 2 days, 3 days, plus a custom amount input and a
  unit select (hours, days). Card summary reads "Wait 2 days".
- Each card has a drag handle, a delete action, and an expand/collapse chevron.
  Reordering uses `@dnd-kit/sortable`, already a dependency and used by the
  pipeline board.
- "+ Add step" at the bottom opens a small three-item menu: Send WhatsApp,
  Send Email, Wait. The new card is appended expanded.

Template picker (shared by WhatsApp and Email steps):

- Search input filtering by name.
- A list where each row shows name, language, an "Approved" badge, and the body
  already rendered with sample data, so the user sees the actual message the
  contact would get. No raw `{{1}}` placeholders are shown anywhere.
- WhatsApp rows come from mock templates in the catalog for this phase. Email
  rows also come from mock templates.
- Rows whose tokens the current trigger cannot supply are still listed but
  carry a warning chip and are shown after the compatible ones.

Validation and Save:

- Save is disabled until a trigger is set and at least one non-Wait step has a
  template chosen. A muted hint under the button explains what is missing.
- Save writes to the store and returns to the list with a toast "Automation
  saved".
- Leaving the builder with unsaved changes asks for confirmation.

## Auto-mapping without a mapping UI

Templates use named tokens. The catalog defines the token vocabulary and which
triggers supply which tokens:

| Token | Supplied by |
| --- | --- |
| `contact.name`, `contact.phone` | all triggers |
| `workspace.name`, `agent.name` | all triggers |
| `deal.title`, `deal.value`, `stage.label` | Deal moves to a stage |
| `conversation.channel` | New conversation starts |
| `appointment.time`, `appointment.service` | Appointment booked, Appointment coming up |
| `tag.name` | Tag added to contact |

Rules:

- `missingTokens(template, trigger)` returns the tokens a template needs that the
  trigger does not supply. The step card shows one warning chip when the list is
  non-empty, for example "This template needs deal info, but the trigger is New
  contact". Save stays enabled; the warning is advisory in this phase.
- `renderTemplate(body, sampleData)` substitutes tokens with sample values for
  preview. Meta WhatsApp templates use numbered placeholders, so a template may
  carry `variableMap`, a record from placeholder number to token name
  (`{ "1": "contact.name", "2": "deal.title" }`). Rendering resolves numbers
  through the map first, then substitutes. Unmapped numbers render as a visible
  `[missing]` marker so problems are obvious in preview.
- The same `variableMap` becomes a JSON column on the backend `Template` model in
  the wiring phase. Templates created inside tkana will write it automatically;
  templates imported from Meta will need it filled once in the template editor.

Sample data lives in the catalog with EN and AR variants, so the AR UI previews
an Arabic name and service.

## Data shape

Defined in `src/lib/automations.ts`. It mirrors the future Prisma model
(`Automation` with `trigger` and `steps` JSON columns).

```ts
export type TriggerKind =
  | "contact.created"
  | "deal.stage_changed"
  | "conversation.started"
  | "appointment.booked"
  | "appointment.upcoming"
  | "contact.tagged";

export type Trigger =
  | { kind: "contact.created" }
  | { kind: "deal.stage_changed"; pipelineId: string; stageId: string }
  | { kind: "conversation.started"; channel: "any" | "whatsapp" | "instagram" | "facebook" }
  | { kind: "appointment.booked" }
  | { kind: "appointment.upcoming"; hoursBefore: number }
  | { kind: "contact.tagged"; tagId: string };

export type Step =
  | { id: string; kind: "whatsapp"; templateId: string | null }
  | { id: string; kind: "email"; templateId: string | null; subject: string }
  | { id: string; kind: "wait"; amount: number; unit: "hours" | "days" };

export interface Automation {
  id: string;
  name: string;
  nameEdited: boolean;
  enabled: boolean;
  trigger: Trigger | null;
  steps: Step[];
  createdAt: string;
  updatedAt: string;
  runs: number;
  lastRunAt: string | null;
}

export interface AutomationTemplate {
  id: string;
  channel: "whatsapp" | "email";
  name: string;
  lang: "en" | "ar";
  subject?: string;          // email only
  body: string;              // named tokens or numbered placeholders
  variableMap?: Record<string, string>;
}
```

A trigger set to `null` is allowed in memory while editing but never saved.

## Persistence

`src/screens/automations/store.ts` exposes `useAutomationsStore()` returning
`{ list, get, save, remove, setEnabled }`. It is backed by localStorage under the
key `tkana.automations.<workspaceId>` so rules are per workspace, matching the
multi-tenancy model. All reads and writes are wrapped in try/catch; a failed read
yields an empty list. This is the single file replaced by `useFetch` and
`useMutation` calls when the API exists.

## Files

- `src/lib/types.ts`: add `"automations"` to `RouteId`.
- `src/shell/nav.ts`: NAV entry after Campaigns, TITLES entry.
- `src/router.tsx`: lazy import of the page.
- `src/lib/automations.ts`: types above, `renderTemplate`, `missingTokens`,
  `summarize(automation, lang)`.
- `src/screens/automations/AutomationsPage.tsx`: list view, empty state with
  recipes, local list/builder switching.
- `src/screens/automations/AutomationBuilder.tsx`: top bar, trigger card, sortable
  step list, add-step menu, save validation.
- `src/screens/automations/TriggerPicker.tsx`: six-trigger grid and inline
  settings per trigger.
- `src/screens/automations/StepCard.tsx`: the three step kinds, drag handle,
  delete, expand.
- `src/screens/automations/TemplatePicker.tsx`: search, rendered preview rows,
  compatibility warning.
- `src/screens/automations/catalog.ts`: trigger definitions with EN/AR labels,
  descriptions, icons, supplied tokens; step definitions; sample data EN/AR;
  mock WhatsApp and email templates; starter recipes.
- `src/screens/automations/store.ts`: localStorage store hook.
- `src/lib/automations.test.ts`: unit tests.

Styling follows the existing pattern: inline style objects on CSS variables plus
the `btn`, `btn primary`, `mono`, and `flip-rtl` utilities. Bilingual copy uses
the `tx("English", "عربي")` helper from `src/lib/tx.ts`. Layout must read
correctly in RTL, including the connector line and drag handles.

## Testing

- Add `vitest` as a dev dependency with a `test` script. Only pure functions are
  unit tested in this phase:
  - `renderTemplate`: named tokens, numbered placeholders through `variableMap`,
    unmapped numbers produce `[missing]`, unknown tokens left untouched.
  - `missingTokens`: returns empty for a compatible pair, lists deal tokens for a
    contact trigger, handles numbered templates through the map.
  - `summarize`: produces the sentence in EN and AR for a three-step rule.
- Browser walkthrough using the `verify` skill in EN and AR: create from a
  recipe, change the trigger and see the warning chip appear, add and reorder
  steps, save, refresh and confirm persistence, toggle enabled from the list,
  delete with confirmation.
- `npm run typecheck` passes.

## Out of scope for this phase

- Backend `Automation` model, migrations, API, event dispatcher, executor.
- Real sending of WhatsApp or email.
- Template creation or editing inside the builder. The picker reads a mocked
  list; the existing Templates screen is unchanged.
- Conditions or branches, multiple triggers, run history.
- Email infrastructure. The app has no email provider and `Contact` has no
  email field. Both are needed before the Email step can run for real.
