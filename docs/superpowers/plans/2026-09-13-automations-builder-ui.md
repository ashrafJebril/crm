# Automations Builder (UI-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a sentence-style automation rule builder ("When X → send WhatsApp A → wait 2 days → send email B") as a new Automations screen, persisted in localStorage, with no backend.

**Architecture:** Pure domain code (types, template rendering, token compatibility) lives in `src/lib/automations.ts` and is unit-tested with vitest. A pure, React-free catalog (`catalog.ts`) holds trigger definitions, sample data, mock templates, starter recipes, and the sentence summarizer. React screens under `src/screens/automations/` compose those into a list view and a single-column builder; a localStorage store hook is the only persistence and is the one file replaced later by API hooks.

**Tech Stack:** React 18, TypeScript strict, Vite 6, Tailwind v4 utility classes plus inline styles on CSS variables, `@dnd-kit/core` + `@dnd-kit/sortable` + `@dnd-kit/utilities` (already installed), `@tanstack/react-query` via the existing `useFetch`, vitest (new dev dependency).

**Spec:** `docs/superpowers/specs/2026-09-13-automations-builder-ui-design.md`

## Global Constraints

- Frontend lives at repo root (`src/`), not `frontend/`. Backend is untouched in this plan.
- Route id is `automations`, hash `#/automations`. Nav label EN "Automations", AR "الأتمتة", placed directly after Campaigns, icon `IconBolt`.
- Bilingual copy uses `makeTx(t.lang)` from `src/lib/tx.ts`; `t.lang` comes from `useTweaks()` in `src/tweaks/context`. Every user-visible string gets an EN and an AR value.
- Styling follows existing pattern: className `card`, `card-h`, `btn`, `btn primary`, `mono`, `flip-rtl`, `badge`; inline `style={{}}` using `var(--ink)`, `var(--ink-3)`, `var(--bg-1)`, `var(--bg-2)`, `var(--bg-3)`, `var(--line)`, `var(--line-soft)`, `var(--accent)`. No new UI libraries.
- Layout must read correctly in RTL (`<html dir="rtl">` is set by TweaksProvider). Use logical properties (`marginInlineStart`, `paddingInlineEnd`, `insetInlineStart`) instead of left/right.
- Exactly six triggers and exactly three step kinds (whatsapp, email, wait). No conditions, branches, or run history.
- Save disabled until a trigger is set and at least one whatsapp/email step has a template. Missing-token warning is advisory and never blocks save.
- localStorage key: `tkana.automations.<workspaceId>`. All storage access wrapped in try/catch.
- TypeScript flags in force: `strict`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax` (use `import type` for types), `erasableSyntaxOnly` (no enums, no parameter properties).
- Commit after every task. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Work happens on branch `feat/automations-builder-ui` (already created, contains the spec).

---

## File map

| File | Responsibility |
| --- | --- |
| `vite.config.ts` (modify) | Add vitest `test` block. |
| `package.json` (modify) | Add `vitest` dev dependency and `test` script. |
| `src/lib/automations.ts` (create) | Types, token vocabulary, `renderTemplate`, `templateTokens`, `missingTokens`, `canSave`, `newStep`. Pure. |
| `src/lib/automations.test.ts` (create) | Unit tests for the above. |
| `src/screens/automations/catalog.ts` (create) | `TRIGGERS` (labels EN/AR, descriptions, supplied tokens), `SAMPLE` data EN/AR, `MOCK_TEMPLATES`, `RECIPES`, `triggerLabel`, `stepLabel`, `summarize`, `suggestName`. Pure, no React. |
| `src/screens/automations/catalog.test.ts` (create) | Tests for `summarize`, `suggestName`, `missingTokens` against catalog templates. |
| `src/screens/automations/store.ts` (create) | `loadAutomations`, `saveAutomations` (pure, take a Storage) and `useAutomationsStore()` hook. |
| `src/screens/automations/store.test.ts` (create) | Tests for the pure load/save. |
| `src/lib/types.ts` (modify) | Add `"automations"` to `RouteId`. |
| `src/shell/nav.ts` (modify) | NAV + TITLES entries. |
| `src/router.tsx` (modify) | Lazy screen entry. |
| `src/screens/automations/AutomationsPage.tsx` (create) | List, empty state with recipes, list/builder switching, delete confirm. |
| `src/screens/automations/TemplatePicker.tsx` (create) | Search + rendered rows + compatibility warning. |
| `src/screens/automations/StepCard.tsx` (create) | Sortable card for whatsapp / email / wait, plus `AddStepMenu`. |
| `src/screens/automations/TriggerPicker.tsx` (create) | Six-trigger grid + inline settings. |
| `src/screens/automations/AutomationBuilder.tsx` (create) | Top bar, trigger card, sortable steps, save validation, unsaved-changes guard. |

---

### Task 1: Vitest setup and pure domain module (`src/lib/automations.ts`)

**Files:**
- Modify: `package.json`
- Modify: `vite.config.ts`
- Create: `src/lib/automations.ts`
- Test: `src/lib/automations.test.ts`

**Interfaces:**
- Produces (used by every later task):
  - Types `TriggerKind`, `Trigger`, `Step`, `StepKind`, `Automation`, `AutomationTemplate`, `Token`.
  - `const BASE_TOKENS: Token[]`
  - `renderTemplate(body: string, values: Record<string, string>, variableMap?: Record<string, string>): string`
  - `templateTokens(t: Pick<AutomationTemplate, "body" | "variableMap">): Token[]`
  - `missingTokens(t: Pick<AutomationTemplate, "body" | "variableMap">, supplied: readonly Token[]): Token[]`
  - `canSave(a: Automation): boolean`
  - `newStep(kind: StepKind): Step`
  - `newAutomation(): Automation`

- [ ] **Step 1: Install vitest and add the script**

Run:
```bash
npm install --save-dev vitest@^3
```
Then edit `package.json` scripts to add `"test": "vitest run"` after `"typecheck"`.

- [ ] **Step 2: Add the vitest block to `vite.config.ts`**

Replace the top of the file and add `test` inside `defineConfig`:

```ts
/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  server: {
    port: 5174,
    strictPort: true,
    open: true,
  },
  build: {
    target: "es2022",
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes("node_modules/react")) return "react";
        },
      },
    },
  },
});
```

- [ ] **Step 3: Write the failing tests**

Create `src/lib/automations.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  BASE_TOKENS,
  canSave,
  missingTokens,
  newAutomation,
  newStep,
  renderTemplate,
  templateTokens,
} from "./automations";

const values = {
  "contact.name": "Sara",
  "deal.title": "Laser package",
  "deal.value": "AED 2,400",
};

describe("renderTemplate", () => {
  it("substitutes named tokens", () => {
    expect(renderTemplate("Hi {{contact.name}}, re {{deal.title}}", values)).toBe(
      "Hi Sara, re Laser package",
    );
  });

  it("resolves numbered placeholders through variableMap", () => {
    const out = renderTemplate("Hi {{1}}, your {{2}} is ready", values, {
      "1": "contact.name",
      "2": "deal.title",
    });
    expect(out).toBe("Hi Sara, your Laser package is ready");
  });

  it("renders unmapped numbers as [missing]", () => {
    expect(renderTemplate("Hi {{1}} and {{2}}", values, { "1": "contact.name" })).toBe(
      "Hi Sara and [missing]",
    );
    expect(renderTemplate("Hi {{1}}", values)).toBe("Hi [missing]");
  });

  it("leaves unknown named tokens untouched", () => {
    expect(renderTemplate("Hi {{contact.email}}", values)).toBe("Hi {{contact.email}}");
  });
});

describe("templateTokens / missingTokens", () => {
  it("collects named tokens", () => {
    expect(templateTokens({ body: "{{contact.name}} {{deal.value}} {{contact.name}}" })).toEqual([
      "contact.name",
      "deal.value",
    ]);
  });

  it("collects tokens via variableMap for numbered templates", () => {
    expect(
      templateTokens({ body: "{{1}} {{2}}", variableMap: { "1": "contact.name", "2": "deal.title" } }),
    ).toEqual(["contact.name", "deal.title"]);
  });

  it("returns empty when the trigger supplies everything", () => {
    expect(missingTokens({ body: "Hi {{contact.name}}" }, BASE_TOKENS)).toEqual([]);
  });

  it("lists deal tokens for a contact-only trigger", () => {
    expect(missingTokens({ body: "{{contact.name}} {{deal.title}} {{deal.value}}" }, BASE_TOKENS)).toEqual([
      "deal.title",
      "deal.value",
    ]);
  });
});

describe("canSave / factories", () => {
  it("newAutomation starts empty and unsaveable", () => {
    const a = newAutomation();
    expect(a.trigger).toBeNull();
    expect(a.steps).toEqual([]);
    expect(a.enabled).toBe(true);
    expect(canSave(a)).toBe(false);
  });

  it("requires a trigger and one templated message step", () => {
    const a = newAutomation();
    a.trigger = { kind: "contact.created" };
    expect(canSave(a)).toBe(false);
    a.steps = [newStep("wait")];
    expect(canSave(a)).toBe(false);
    const wa = newStep("whatsapp");
    a.steps = [wa];
    expect(canSave(a)).toBe(false);
    if (wa.kind === "whatsapp") wa.templateId = "t1";
    expect(canSave(a)).toBe(true);
  });

  it("newStep defaults", () => {
    expect(newStep("wait")).toMatchObject({ kind: "wait", amount: 1, unit: "days" });
    expect(newStep("email")).toMatchObject({ kind: "email", templateId: null, subject: "" });
    expect(newStep("whatsapp").id).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL, "Failed to resolve import ./automations" or similar module-not-found.

- [ ] **Step 5: Write the module**

Create `src/lib/automations.ts`:

```ts
// Pure domain code for Automations. No React, no DOM. The shapes here mirror
// the future Prisma `Automation` model (trigger + steps as JSON columns), so
// the backend phase is CRUD plus a dispatcher with no frontend rework.

export type TriggerKind =
  | "contact.created"
  | "deal.stage_changed"
  | "conversation.started"
  | "appointment.booked"
  | "appointment.upcoming"
  | "contact.tagged";

export type ConversationChannel = "any" | "whatsapp" | "instagram" | "facebook";

export type Trigger =
  | { kind: "contact.created" }
  | { kind: "deal.stage_changed"; pipelineId: string; stageId: string }
  | { kind: "conversation.started"; channel: ConversationChannel }
  | { kind: "appointment.booked" }
  | { kind: "appointment.upcoming"; hoursBefore: number }
  | { kind: "contact.tagged"; tagId: string };

export type StepKind = "whatsapp" | "email" | "wait";
export type WaitUnit = "hours" | "days";

export type Step =
  | { id: string; kind: "whatsapp"; templateId: string | null }
  | { id: string; kind: "email"; templateId: string | null; subject: string }
  | { id: string; kind: "wait"; amount: number; unit: WaitUnit };

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

export type Token =
  | "contact.name"
  | "contact.phone"
  | "workspace.name"
  | "agent.name"
  | "deal.title"
  | "deal.value"
  | "stage.label"
  | "conversation.channel"
  | "appointment.time"
  | "appointment.service"
  | "tag.name";

export const ALL_TOKENS: readonly Token[] = [
  "contact.name",
  "contact.phone",
  "workspace.name",
  "agent.name",
  "deal.title",
  "deal.value",
  "stage.label",
  "conversation.channel",
  "appointment.time",
  "appointment.service",
  "tag.name",
];

/** Tokens every trigger can supply. */
export const BASE_TOKENS: readonly Token[] = [
  "contact.name",
  "contact.phone",
  "workspace.name",
  "agent.name",
];

export interface AutomationTemplate {
  id: string;
  channel: "whatsapp" | "email";
  name: string;
  lang: "en" | "ar";
  /** Email only. */
  subject?: string;
  /** Named tokens `{{contact.name}}` or Meta-style numbered `{{1}}`. */
  body: string;
  /** Numbered placeholder → token name, e.g. { "1": "contact.name" }. */
  variableMap?: Record<string, string>;
}

const NUMBERED = /\{\{(\d+)\}\}/g;
const NAMED = /\{\{([a-z]+\.[a-zA-Z]+)\}\}/g;

const isToken = (s: string): s is Token => (ALL_TOKENS as readonly string[]).includes(s);

/** Substitute tokens for preview. Unmapped numbers become a visible marker;
 *  unknown named tokens are left as-is so problems are obvious. */
export function renderTemplate(
  body: string,
  values: Record<string, string>,
  variableMap?: Record<string, string>,
): string {
  const named = body.replace(NUMBERED, (_m, n: string) => {
    const token = variableMap?.[n];
    return token ? `{{${token}}}` : "[missing]";
  });
  return named.replace(NAMED, (m, token: string) => values[token] ?? m);
}

/** Distinct tokens a template needs, in order of first appearance. */
export function templateTokens(t: Pick<AutomationTemplate, "body" | "variableMap">): Token[] {
  const out: Token[] = [];
  const push = (s: string) => {
    if (isToken(s) && !out.includes(s)) out.push(s);
  };
  for (const m of t.body.matchAll(NUMBERED)) {
    const token = t.variableMap?.[m[1]];
    if (token) push(token);
  }
  for (const m of t.body.matchAll(NAMED)) push(m[1]);
  return out;
}

/** Tokens the template needs that the trigger does not supply. */
export function missingTokens(
  t: Pick<AutomationTemplate, "body" | "variableMap">,
  supplied: readonly Token[],
): Token[] {
  return templateTokens(t).filter((tok) => !supplied.includes(tok));
}

const uid = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);

export function newStep(kind: StepKind): Step {
  const id = uid();
  switch (kind) {
    case "whatsapp":
      return { id, kind, templateId: null };
    case "email":
      return { id, kind, templateId: null, subject: "" };
    case "wait":
      return { id, kind, amount: 1, unit: "days" };
  }
}

export function newAutomation(): Automation {
  const now = new Date().toISOString();
  return {
    id: uid(),
    name: "",
    nameEdited: false,
    enabled: true,
    trigger: null,
    steps: [],
    createdAt: now,
    updatedAt: now,
    runs: 0,
    lastRunAt: null,
  };
}

/** Save is allowed once a trigger is set and at least one message step has a template. */
export function canSave(a: Automation): boolean {
  if (!a.trigger) return false;
  return a.steps.some(
    (s) => (s.kind === "whatsapp" || s.kind === "email") && s.templateId !== null,
  );
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, 12 tests.

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add package.json package-lock.json vite.config.ts src/lib/automations.ts src/lib/automations.test.ts
git commit -m "feat(automations): pure domain module with template rendering and vitest setup

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Catalog (triggers, sample data, mock templates, recipes, summarizer)

**Files:**
- Create: `src/screens/automations/catalog.ts`
- Test: `src/screens/automations/catalog.test.ts`

**Interfaces:**
- Consumes: everything from Task 1.
- Produces:
  - `interface TriggerDef { kind: TriggerKind; en: string; ar: string; descEn: string; descAr: string; supplies: readonly Token[]; defaults: Trigger }`
  - `const TRIGGERS: readonly TriggerDef[]` (six entries, in spec order)
  - `triggerDef(kind: TriggerKind): TriggerDef`
  - `suppliedTokens(trigger: Trigger | null): readonly Token[]`
  - `const SAMPLE: Record<Lang, Record<Token, string>>`
  - `const MOCK_TEMPLATES: readonly AutomationTemplate[]`
  - `templateById(id: string | null): AutomationTemplate | undefined`
  - `triggerLabel(trigger: Trigger | null, lang: Lang, ctx: LabelContext): string`
  - `stepLabel(step: Step, lang: Lang): string`
  - `summarize(a: Automation, lang: Lang, ctx: LabelContext): string`
  - `suggestName(a: Automation, lang: Lang, ctx: LabelContext): string`
  - `interface LabelContext { stageLabel?: (stageId: string) => string | undefined; tagName?: (tagId: string) => string | undefined }`
  - `interface Recipe { id: string; en: string; ar: string; descEn: string; descAr: string; build: (opts: { wonStageRef: { pipelineId: string; stageId: string } | null }) => Automation }`
  - `const RECIPES: readonly Recipe[]`

- [ ] **Step 1: Write the failing tests**

Create `src/screens/automations/catalog.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { missingTokens, newAutomation, newStep } from "@/lib/automations";
import {
  MOCK_TEMPLATES,
  RECIPES,
  TRIGGERS,
  stepLabel,
  suggestName,
  summarize,
  suppliedTokens,
  templateById,
} from "./catalog";

const ctx = { stageLabel: (id: string) => (id === "won" ? "Won" : undefined) };

describe("catalog shape", () => {
  it("has exactly six triggers with bilingual labels", () => {
    expect(TRIGGERS).toHaveLength(6);
    for (const t of TRIGGERS) {
      expect(t.en.length).toBeGreaterThan(0);
      expect(t.ar.length).toBeGreaterThan(0);
      expect(t.defaults.kind).toBe(t.kind);
    }
  });

  it("every mock template is compatible with at least one trigger", () => {
    for (const tpl of MOCK_TEMPLATES) {
      const ok = TRIGGERS.some((t) => missingTokens(tpl, t.supplies).length === 0);
      expect(ok, tpl.id).toBe(true);
    }
  });

  it("deal templates are incompatible with the contact trigger", () => {
    const tpl = templateById("wa_deal_won_en")!;
    expect(missingTokens(tpl, suppliedTokens({ kind: "contact.created" }))).toContain("deal.title");
    expect(missingTokens(tpl, suppliedTokens({ kind: "deal.stage_changed", pipelineId: "p", stageId: "won" }))).toEqual([]);
  });
});

describe("summarize / suggestName", () => {
  const a = newAutomation();
  a.trigger = { kind: "deal.stage_changed", pipelineId: "p", stageId: "won" };
  const wa = newStep("whatsapp");
  if (wa.kind === "whatsapp") wa.templateId = "wa_deal_won_en";
  const wait = newStep("wait");
  if (wait.kind === "wait") {
    wait.amount = 2;
    wait.unit = "days";
  }
  const em = newStep("email");
  if (em.kind === "email") em.templateId = "em_onboarding_en";
  a.steps = [wa, wait, em];

  it("produces the English sentence", () => {
    expect(summarize(a, "en", ctx)).toBe(
      "When a deal moves to Won → WhatsApp: Deal won thank-you → wait 2 days → Email: Onboarding",
    );
  });

  it("produces the Arabic sentence", () => {
    const s = summarize(a, "ar", ctx);
    expect(s).toContain("عندما تنتقل صفقة إلى Won");
    expect(s).toContain("واتساب: Deal won thank-you");
    expect(s).toContain("انتظر 2 يوم");
  });

  it("suggests a name from trigger and first action", () => {
    expect(suggestName(a, "en", ctx)).toBe("Deal moves to Won → WhatsApp");
    const empty = newAutomation();
    expect(suggestName(empty, "en", ctx)).toBe("New automation");
  });

  it("stepLabel handles wait units", () => {
    expect(stepLabel({ id: "x", kind: "wait", amount: 1, unit: "hours" }, "en")).toBe("wait 1 hour");
    expect(stepLabel({ id: "x", kind: "wait", amount: 3, unit: "hours" }, "en")).toBe("wait 3 hours");
  });
});

describe("recipes", () => {
  it("builds three saveable-shaped automations", () => {
    expect(RECIPES).toHaveLength(3);
    const won = RECIPES.find((r) => r.id === "deal_won")!.build({
      wonStageRef: { pipelineId: "p", stageId: "won" },
    });
    expect(won.trigger).toEqual({ kind: "deal.stage_changed", pipelineId: "p", stageId: "won" });
    expect(won.steps.map((s) => s.kind)).toEqual(["whatsapp", "wait", "email"]);
    const noStage = RECIPES.find((r) => r.id === "deal_won")!.build({ wonStageRef: null });
    expect(noStage.trigger).toEqual({ kind: "deal.stage_changed", pipelineId: "", stageId: "" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL, cannot resolve `./catalog`.

- [ ] **Step 3: Write the catalog**

Create `src/screens/automations/catalog.ts`:

```ts
// React-free catalog for the Automations builder: trigger definitions,
// sample data for previews, mocked templates, starter recipes, and the
// sentence summarizer. Keeping this pure lets vitest run it in node.
import type { Lang } from "@/lib/types";
import {
  BASE_TOKENS,
  newAutomation,
  newStep,
  type Automation,
  type AutomationTemplate,
  type Step,
  type Token,
  type Trigger,
  type TriggerKind,
} from "@/lib/automations";

export interface TriggerDef {
  kind: TriggerKind;
  en: string;
  ar: string;
  descEn: string;
  descAr: string;
  supplies: readonly Token[];
  defaults: Trigger;
}

const withBase = (...extra: Token[]): readonly Token[] => [...BASE_TOKENS, ...extra];

export const TRIGGERS: readonly TriggerDef[] = [
  {
    kind: "contact.created",
    en: "New contact added",
    ar: "إضافة جهة اتصال جديدة",
    descEn: "Runs when a contact is created from any source.",
    descAr: "يعمل عند إنشاء جهة اتصال من أي مصدر.",
    supplies: withBase(),
    defaults: { kind: "contact.created" },
  },
  {
    kind: "deal.stage_changed",
    en: "Deal moves to a stage",
    ar: "انتقال صفقة إلى مرحلة",
    descEn: "Runs when a deal enters the stage you pick, including Won or Lost.",
    descAr: "يعمل عند انتقال صفقة إلى المرحلة التي تختارها، بما فيها الفوز أو الخسارة.",
    supplies: withBase("deal.title", "deal.value", "stage.label"),
    defaults: { kind: "deal.stage_changed", pipelineId: "", stageId: "" },
  },
  {
    kind: "conversation.started",
    en: "New conversation starts",
    ar: "بدء محادثة جديدة",
    descEn: "Runs on the first inbound message from a contact.",
    descAr: "يعمل عند أول رسالة واردة من جهة اتصال.",
    supplies: withBase("conversation.channel"),
    defaults: { kind: "conversation.started", channel: "any" },
  },
  {
    kind: "appointment.booked",
    en: "Appointment booked",
    ar: "حجز موعد",
    descEn: "Runs as soon as an appointment is created.",
    descAr: "يعمل فور إنشاء موعد.",
    supplies: withBase("appointment.time", "appointment.service"),
    defaults: { kind: "appointment.booked" },
  },
  {
    kind: "appointment.upcoming",
    en: "Appointment coming up",
    ar: "موعد قريب",
    descEn: "Runs a set number of hours before an appointment.",
    descAr: "يعمل قبل الموعد بعدد ساعات تحدده.",
    supplies: withBase("appointment.time", "appointment.service"),
    defaults: { kind: "appointment.upcoming", hoursBefore: 24 },
  },
  {
    kind: "contact.tagged",
    en: "Tag added to contact",
    ar: "إضافة وسم لجهة اتصال",
    descEn: "Runs when the tag you pick is added to a contact.",
    descAr: "يعمل عند إضافة الوسم الذي تختاره إلى جهة اتصال.",
    supplies: withBase("tag.name"),
    defaults: { kind: "contact.tagged", tagId: "" },
  },
];

export function triggerDef(kind: TriggerKind): TriggerDef {
  const def = TRIGGERS.find((t) => t.kind === kind);
  if (!def) throw new Error(`unknown trigger ${kind}`);
  return def;
}

export function suppliedTokens(trigger: Trigger | null): readonly Token[] {
  return trigger ? triggerDef(trigger.kind).supplies : BASE_TOKENS;
}

export const SAMPLE: Record<Lang, Record<Token, string>> = {
  en: {
    "contact.name": "Sara Ahmed",
    "contact.phone": "+971 50 123 4567",
    "workspace.name": "Aram Clinic",
    "agent.name": "Omar",
    "deal.title": "Laser package",
    "deal.value": "AED 2,400",
    "stage.label": "Won",
    "conversation.channel": "WhatsApp",
    "appointment.time": "Tuesday 3:00 PM",
    "appointment.service": "Consultation",
    "tag.name": "VIP",
  },
  ar: {
    "contact.name": "سارة أحمد",
    "contact.phone": "+971 50 123 4567",
    "workspace.name": "عيادة آرام",
    "agent.name": "عمر",
    "deal.title": "باقة الليزر",
    "deal.value": "2,400 درهم",
    "stage.label": "تم الفوز",
    "conversation.channel": "واتساب",
    "appointment.time": "الثلاثاء 3:00 م",
    "appointment.service": "استشارة",
    "tag.name": "VIP",
  },
};

export const MOCK_TEMPLATES: readonly AutomationTemplate[] = [
  {
    id: "wa_welcome_en",
    channel: "whatsapp",
    name: "Welcome",
    lang: "en",
    body: "Hi {{contact.name}}, welcome to {{workspace.name}}! I'm {{agent.name}}. Reply here any time and we'll help you out.",
  },
  {
    id: "wa_welcome_ar",
    channel: "whatsapp",
    name: "ترحيب",
    lang: "ar",
    body: "أهلاً {{contact.name}}، مرحباً بك في {{workspace.name}}! أنا {{agent.name}}. راسلنا هنا في أي وقت وسنساعدك.",
  },
  {
    id: "wa_deal_won_en",
    channel: "whatsapp",
    name: "Deal won thank-you",
    lang: "en",
    // Meta-style numbered placeholders, mapped to tokens.
    body: "Thank you {{1}}! Your {{2}} ({{3}}) is confirmed. {{4}} will be in touch with next steps.",
    variableMap: { "1": "contact.name", "2": "deal.title", "3": "deal.value", "4": "agent.name" },
  },
  {
    id: "wa_deal_won_ar",
    channel: "whatsapp",
    name: "شكر بعد إتمام الصفقة",
    lang: "ar",
    body: "شكراً {{1}}! تم تأكيد {{2}} ({{3}}). سيتواصل معك {{4}} بالخطوات التالية.",
    variableMap: { "1": "contact.name", "2": "deal.title", "3": "deal.value", "4": "agent.name" },
  },
  {
    id: "wa_appt_reminder_en",
    channel: "whatsapp",
    name: "Appointment reminder",
    lang: "en",
    body: "Hi {{contact.name}}, a reminder of your {{appointment.service}} at {{workspace.name}} on {{appointment.time}}. Reply 1 to confirm or 2 to reschedule.",
  },
  {
    id: "wa_appt_reminder_ar",
    channel: "whatsapp",
    name: "تذكير بالموعد",
    lang: "ar",
    body: "مرحباً {{contact.name}}، نذكرك بموعد {{appointment.service}} في {{workspace.name}} يوم {{appointment.time}}. أرسل 1 للتأكيد أو 2 لإعادة الجدولة.",
  },
  {
    id: "wa_new_chat_en",
    channel: "whatsapp",
    name: "First reply",
    lang: "en",
    body: "Thanks for reaching out on {{conversation.channel}}, {{contact.name}}! {{agent.name}} from {{workspace.name}} will reply shortly.",
  },
  {
    id: "em_onboarding_en",
    channel: "email",
    name: "Onboarding",
    lang: "en",
    subject: "Welcome aboard, {{contact.name}}",
    body: "Hi {{contact.name}},\n\nThanks for choosing {{workspace.name}} for {{deal.title}}. Here is what happens next and how to reach {{agent.name}} if you need anything.",
  },
  {
    id: "em_onboarding_ar",
    channel: "email",
    name: "بداية التعامل",
    lang: "ar",
    subject: "أهلاً بك، {{contact.name}}",
    body: "مرحباً {{contact.name}}،\n\nشكراً لاختيارك {{workspace.name}} لـ {{deal.title}}. إليك الخطوات التالية وكيفية التواصل مع {{agent.name}} عند الحاجة.",
  },
  {
    id: "em_welcome_en",
    channel: "email",
    name: "Welcome email",
    lang: "en",
    subject: "Welcome to {{workspace.name}}",
    body: "Hi {{contact.name}},\n\nGreat to have you with us. {{agent.name}} is your point of contact at {{workspace.name}}.",
  },
];

export function templateById(id: string | null): AutomationTemplate | undefined {
  return id ? MOCK_TEMPLATES.find((t) => t.id === id) : undefined;
}

export interface LabelContext {
  stageLabel?: (stageId: string) => string | undefined;
  tagName?: (tagId: string) => string | undefined;
}

const CHANNEL_LABEL: Record<Lang, Record<string, string>> = {
  en: { any: "any channel", whatsapp: "WhatsApp", instagram: "Instagram", facebook: "Facebook" },
  ar: { any: "أي قناة", whatsapp: "واتساب", instagram: "إنستغرام", facebook: "فيسبوك" },
};

/** Sentence fragment for the trigger, e.g. "a deal moves to Won". */
function triggerClause(trigger: Trigger, lang: Lang, ctx: LabelContext): string {
  const ar = lang === "ar";
  switch (trigger.kind) {
    case "contact.created":
      return ar ? "تُضاف جهة اتصال جديدة" : "a new contact is added";
    case "deal.stage_changed": {
      const stage = (trigger.stageId && ctx.stageLabel?.(trigger.stageId)) || (ar ? "مرحلة" : "a stage");
      return ar ? `تنتقل صفقة إلى ${stage}` : `a deal moves to ${stage}`;
    }
    case "conversation.started": {
      const ch = CHANNEL_LABEL[lang][trigger.channel];
      return ar ? `تبدأ محادثة جديدة على ${ch}` : `a new conversation starts on ${ch}`;
    }
    case "appointment.booked":
      return ar ? "يُحجز موعد" : "an appointment is booked";
    case "appointment.upcoming":
      return ar
        ? `يقترب موعد (قبل ${trigger.hoursBefore} ساعة)`
        : `an appointment is ${trigger.hoursBefore}h away`;
    case "contact.tagged": {
      const tag = (trigger.tagId && ctx.tagName?.(trigger.tagId)) || (ar ? "وسم" : "a tag");
      return ar ? `يُضاف وسم ${tag} لجهة اتصال` : `tag ${tag} is added to a contact`;
    }
  }
}

/** Short trigger label for names, e.g. "Deal moves to Won". */
export function triggerLabel(trigger: Trigger | null, lang: Lang, ctx: LabelContext): string {
  if (!trigger) return lang === "ar" ? "اختر المشغّل" : "Choose a trigger";
  const def = triggerDef(trigger.kind);
  if (trigger.kind === "deal.stage_changed") {
    const stage = trigger.stageId && ctx.stageLabel?.(trigger.stageId);
    if (stage) return lang === "ar" ? `انتقال صفقة إلى ${stage}` : `Deal moves to ${stage}`;
  }
  if (trigger.kind === "contact.tagged") {
    const tag = trigger.tagId && ctx.tagName?.(trigger.tagId);
    if (tag) return lang === "ar" ? `إضافة وسم ${tag}` : `Tag ${tag} added`;
  }
  return lang === "ar" ? def.ar : def.en;
}

export function stepLabel(step: Step, lang: Lang): string {
  const ar = lang === "ar";
  switch (step.kind) {
    case "whatsapp": {
      const name = templateById(step.templateId)?.name ?? (ar ? "اختر قالباً" : "choose a template");
      return ar ? `واتساب: ${name}` : `WhatsApp: ${name}`;
    }
    case "email": {
      const name = templateById(step.templateId)?.name ?? (ar ? "اختر قالباً" : "choose a template");
      return ar ? `بريد: ${name}` : `Email: ${name}`;
    }
    case "wait": {
      if (ar) return `انتظر ${step.amount} ${step.unit === "days" ? "يوم" : "ساعة"}`;
      const unit = step.unit === "days" ? "day" : "hour";
      return `wait ${step.amount} ${unit}${step.amount === 1 ? "" : "s"}`;
    }
  }
}

/** "When a deal moves to Won → WhatsApp: Thank you → wait 2 days → Email: Onboarding" */
export function summarize(a: Automation, lang: Lang, ctx: LabelContext): string {
  const ar = lang === "ar";
  const head = a.trigger
    ? (ar ? "عندما " : "When ") + triggerClause(a.trigger, lang, ctx)
    : ar
      ? "لم يُحدَّد مشغّل"
      : "No trigger yet";
  const parts = [head, ...a.steps.map((s) => stepLabel(s, lang))];
  return parts.join(" → ");
}

/** "<trigger label> → <first action>" until the user edits the name. */
export function suggestName(a: Automation, lang: Lang, ctx: LabelContext): string {
  if (!a.trigger) return lang === "ar" ? "أتمتة جديدة" : "New automation";
  const first = a.steps.find((s) => s.kind !== "wait");
  const action = !first
    ? "…"
    : first.kind === "whatsapp"
      ? lang === "ar" ? "واتساب" : "WhatsApp"
      : lang === "ar" ? "بريد" : "Email";
  return `${triggerLabel(a.trigger, lang, ctx)} → ${action}`;
}

export interface Recipe {
  id: string;
  en: string;
  ar: string;
  descEn: string;
  descAr: string;
  build: (opts: { wonStageRef: { pipelineId: string; stageId: string } | null }) => Automation;
}

const message = (kind: "whatsapp" | "email", templateId: string): Step => {
  const s = newStep(kind);
  if (s.kind === "whatsapp" || s.kind === "email") s.templateId = templateId;
  if (s.kind === "email") s.subject = templateById(templateId)?.subject ?? "";
  return s;
};

const wait = (amount: number): Step => {
  const s = newStep("wait");
  if (s.kind === "wait") s.amount = amount;
  return s;
};

export const RECIPES: readonly Recipe[] = [
  {
    id: "welcome",
    en: "Welcome new contact",
    ar: "ترحيب بجهة اتصال جديدة",
    descEn: "Send a WhatsApp welcome the moment a contact is added.",
    descAr: "أرسل رسالة ترحيب عبر واتساب فور إضافة جهة اتصال.",
    build: () => {
      const a = newAutomation();
      a.trigger = { kind: "contact.created" };
      a.steps = [message("whatsapp", "wa_welcome_en")];
      return a;
    },
  },
  {
    id: "deal_won",
    en: "Deal won thank-you",
    ar: "شكر بعد الفوز بصفقة",
    descEn: "Thank the customer on WhatsApp, then email onboarding two days later.",
    descAr: "اشكر العميل عبر واتساب، ثم أرسل بريد البداية بعد يومين.",
    build: ({ wonStageRef }) => {
      const a = newAutomation();
      a.trigger = {
        kind: "deal.stage_changed",
        pipelineId: wonStageRef?.pipelineId ?? "",
        stageId: wonStageRef?.stageId ?? "",
      };
      a.steps = [message("whatsapp", "wa_deal_won_en"), wait(2), message("email", "em_onboarding_en")];
      return a;
    },
  },
  {
    id: "appt_reminder",
    en: "Appointment reminder",
    ar: "تذكير بالموعد",
    descEn: "Remind the contact on WhatsApp 24 hours before their appointment.",
    descAr: "ذكّر جهة الاتصال عبر واتساب قبل موعدها بـ 24 ساعة.",
    build: () => {
      const a = newAutomation();
      a.trigger = { kind: "appointment.upcoming", hoursBefore: 24 };
      a.steps = [message("whatsapp", "wa_appt_reminder_en")];
      return a;
    },
  },
];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS for both test files. If the Arabic `summarize` assertion for "عندما تنتقل صفقة إلى Won" fails on spacing, fix the string in `triggerClause`, not the test.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/screens/automations/catalog.ts src/screens/automations/catalog.test.ts
git commit -m "feat(automations): trigger catalog, sample data, mock templates, recipes, summarizer

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: localStorage store

**Files:**
- Create: `src/screens/automations/store.ts`
- Test: `src/screens/automations/store.test.ts`

**Interfaces:**
- Consumes: `Automation` from Task 1; `useAuth()` from `src/auth/context` (field `activeWorkspace: Workspace | null`).
- Produces:
  - `storageKey(workspaceId: string | null): string`
  - `loadAutomations(storage: Pick<Storage, "getItem">, key: string): Automation[]`
  - `saveAutomations(storage: Pick<Storage, "setItem">, key: string, list: Automation[]): boolean`
  - `useAutomationsStore(): { list: Automation[]; get: (id: string) => Automation | undefined; save: (a: Automation) => void; remove: (id: string) => void; setEnabled: (id: string, on: boolean) => void }`

- [ ] **Step 1: Write the failing tests**

Create `src/screens/automations/store.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { newAutomation } from "@/lib/automations";
import { loadAutomations, saveAutomations, storageKey } from "./store";

function fakeStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    dump: () => Object.fromEntries(m),
  };
}

describe("store", () => {
  it("scopes the key by workspace and falls back to local", () => {
    expect(storageKey("ws1")).toBe("tkana.automations.ws1");
    expect(storageKey(null)).toBe("tkana.automations.local");
  });

  it("round-trips a list", () => {
    const s = fakeStorage();
    const a = newAutomation();
    a.name = "Test";
    expect(saveAutomations(s, "k", [a])).toBe(true);
    expect(loadAutomations(s, "k")).toEqual([a]);
  });

  it("returns empty on missing or corrupt data", () => {
    expect(loadAutomations(fakeStorage(), "k")).toEqual([]);
    expect(loadAutomations(fakeStorage({ k: "{not json" }), "k")).toEqual([]);
    expect(loadAutomations(fakeStorage({ k: '{"a":1}' }), "k")).toEqual([]);
  });

  it("swallows storage write errors", () => {
    const s = {
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(saveAutomations(s, "k", [])).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL, cannot resolve `./store`.

- [ ] **Step 3: Write the store**

Create `src/screens/automations/store.ts`:

```ts
// UI-only persistence for Automations. This is the one file to swap for
// useFetch/useMutation once the backend exists; the page and builder only
// see the hook's return shape.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/auth/context";
import type { Automation } from "@/lib/automations";

export const storageKey = (workspaceId: string | null): string =>
  `tkana.automations.${workspaceId ?? "local"}`;

export function loadAutomations(storage: Pick<Storage, "getItem">, key: string): Automation[] {
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Automation[]) : [];
  } catch {
    return [];
  }
}

export function saveAutomations(
  storage: Pick<Storage, "setItem">,
  key: string,
  list: Automation[],
): boolean {
  try {
    storage.setItem(key, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

const browserStorage = (): Storage | null =>
  typeof localStorage === "undefined" ? null : localStorage;

export function useAutomationsStore() {
  const { activeWorkspace } = useAuth();
  const key = storageKey(activeWorkspace?.id ?? null);
  const [list, setList] = useState<Automation[]>(() => {
    const s = browserStorage();
    return s ? loadAutomations(s, key) : [];
  });

  // Re-read when the workspace changes (multi-workspace users switch in the Topbar).
  useEffect(() => {
    const s = browserStorage();
    setList(s ? loadAutomations(s, key) : []);
  }, [key]);

  const persist = useCallback(
    (next: Automation[]) => {
      setList(next);
      const s = browserStorage();
      if (s) saveAutomations(s, key, next);
    },
    [key],
  );

  const save = useCallback(
    (a: Automation) => {
      const stamped = { ...a, updatedAt: new Date().toISOString() };
      const idx = list.findIndex((x) => x.id === a.id);
      const next = idx === -1 ? [stamped, ...list] : list.map((x) => (x.id === a.id ? stamped : x));
      persist(next);
    },
    [list, persist],
  );

  const remove = useCallback(
    (id: string) => persist(list.filter((x) => x.id !== id)),
    [list, persist],
  );

  const setEnabled = useCallback(
    (id: string, on: boolean) =>
      persist(list.map((x) => (x.id === id ? { ...x, enabled: on } : x))),
    [list, persist],
  );

  const get = useCallback((id: string) => list.find((x) => x.id === id), [list]);

  return useMemo(() => ({ list, get, save, remove, setEnabled }), [list, get, save, remove, setEnabled]);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all three files.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/screens/automations/store.ts src/screens/automations/store.test.ts
git commit -m "feat(automations): workspace-scoped localStorage store

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Route, nav entry, and list page with empty state

**Files:**
- Modify: `src/lib/types.ts:15-29`
- Modify: `src/shell/nav.ts` (NAV after the `campaigns` row, TITLES after `campaigns`)
- Modify: `src/router.tsx:5-20`
- Create: `src/screens/automations/AutomationsPage.tsx`

**Interfaces:**
- Consumes: `useAutomationsStore` (Task 3); `RECIPES`, `summarize` (Task 2); `Automation`, `newAutomation` (Task 1); `PageHeader`, `Toggle`, `Modal`, `useToast`, `Badge`; `useFetch<Pipeline[]>("/pipelines")` and `useFetch<TagRow[]>("/tags")`.
- Produces: default export `AutomationsPage`. The builder is stubbed in this task as a local placeholder component named `AutomationBuilder` with props `{ initial: Automation; onSave: (a: Automation) => void; onBack: () => void }`; Task 8 replaces the stub with the real import. Also exports `useLabelContext(): LabelContext` reused by Task 8.

- [ ] **Step 1: Add the route id**

In `src/lib/types.ts`, change the `RouteId` union to include `"automations"` after `"campaigns"`:

```ts
export type RouteId =
  | "dashboard"
  | "inbox"
  | "calendar"
  | "social"
  | "media"
  | "pipeline"
  | "campaigns"
  | "automations"
  | "ads"
  | "contacts"
  | "analytics"
  | "templates"
  | "team"
  | "settings"
  | "admin";
```

- [ ] **Step 2: Add nav and title entries**

In `src/shell/nav.ts`, insert after the `campaigns` NAV row:

```ts
  { id: "automations", label: "Automations", ar: "الأتمتة",        Icon: IconBolt },
```

and after the `campaigns` TITLES row:

```ts
  automations: { en: "Automations",     ar: "الأتمتة" },
```

`IconBolt` is already imported in that file.

- [ ] **Step 3: Register the lazy screen**

In `src/router.tsx`, add after the `campaigns` entry:

```ts
  automations: lazy(() => import("@/screens/automations/AutomationsPage")),
```

- [ ] **Step 4: Run typecheck to see the missing screen**

Run: `npm run typecheck`
Expected: FAIL, cannot find module `@/screens/automations/AutomationsPage`.

- [ ] **Step 5: Create the list page**

Create `src/screens/automations/AutomationsPage.tsx`:

```tsx
import { useMemo, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import type { Pipeline, TagRow } from "@/lib/types";
import { newAutomation, type Automation } from "@/lib/automations";
import { useFetch } from "@/api/useFetch";
import { PageHeader } from "@/components/PageHeader";
import { Toggle } from "@/components/Toggle";
import { Modal } from "@/components/Modal";
import { useToast } from "@/components/Toast";
import { IconBolt, IconPlus, IconTrash } from "@/icons";
import { RECIPES, summarize, type LabelContext } from "./catalog";
import { useAutomationsStore } from "./store";

/** Resolves stage and tag ids to display labels for summaries and names. */
export function useLabelContext(): LabelContext {
  const { t } = useTweaks();
  const pipelinesQ = useFetch<Pipeline[]>("/pipelines");
  const tagsQ = useFetch<TagRow[]>("/tags");
  return useMemo<LabelContext>(
    () => ({
      stageLabel: (stageId) => {
        for (const p of pipelinesQ.data ?? []) {
          const s = p.stages.find((x) => x.id === stageId);
          if (s) return t.lang === "ar" ? s.labelAr || s.label : s.label;
        }
        return undefined;
      },
      tagName: (tagId) => tagsQ.data?.find((x) => x.id === tagId)?.name,
    }),
    [pipelinesQ.data, tagsQ.data, t.lang],
  );
}

// Temporary stub, replaced by the real builder in a later task.
function AutomationBuilder({
  initial,
  onSave,
  onBack,
}: {
  initial: Automation;
  onSave: (a: Automation) => void;
  onBack: () => void;
}) {
  return (
    <div style={{ padding: 24 }}>
      <button className="btn" onClick={onBack}>Back</button>
      <button className="btn primary" onClick={() => onSave(initial)}>Save stub</button>
    </div>
  );
}

type View = { kind: "list" } | { kind: "edit"; draft: Automation };

export default function AutomationsPage() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { toast } = useToast();
  const store = useAutomationsStore();
  const ctx = useLabelContext();
  const pipelinesQ = useFetch<Pipeline[]>("/pipelines");
  const [view, setView] = useState<View>({ kind: "list" });
  const [confirmDelete, setConfirmDelete] = useState<Automation | null>(null);

  const wonStageRef = useMemo(() => {
    for (const p of pipelinesQ.data ?? []) {
      const won = p.stages.find((s) => s.isWon);
      if (won) return { pipelineId: p.id, stageId: won.id };
    }
    return null;
  }, [pipelinesQ.data]);

  if (view.kind === "edit") {
    return (
      <AutomationBuilder
        initial={view.draft}
        onBack={() => setView({ kind: "list" })}
        onSave={(a) => {
          store.save(a);
          toast(tx("Automation saved", "تم حفظ الأتمتة"), "success");
          setView({ kind: "list" });
        }}
      />
    );
  }

  const fmtDate = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString(t.lang === "ar" ? "ar" : "en", { month: "short", day: "numeric" }) : tx("Never", "أبداً");

  return (
    <div style={{ overflowY: "auto", flex: 1 }}>
      <PageHeader
        title={tx("Automations", "الأتمتة")}
        subtitle={tx(
          "When something happens, send the right message automatically.",
          "عند حدوث شيء، أرسل الرسالة المناسبة تلقائياً.",
        )}
        actions={
          <button className="btn primary" onClick={() => setView({ kind: "edit", draft: newAutomation() })}>
            <IconPlus w={14} /> {tx("New automation", "أتمتة جديدة")}
          </button>
        }
      />

      <div style={{ padding: "0 24px 40px", display: "grid", gap: 12 }}>
        {store.list.length === 0 ? (
          <div className="card" style={{ padding: 32 }}>
            <div style={{ textAlign: "center", marginBottom: 24 }}>
              <IconBolt w={28} />
              <h3 style={{ margin: "12px 0 4px", fontSize: 16 }}>
                {tx("Start with a recipe", "ابدأ بوصفة جاهزة")}
              </h3>
              <p style={{ color: "var(--ink-3)", fontSize: 13, margin: 0 }}>
                {tx("Pick one, tweak the message, turn it on.", "اختر واحدة، عدّل الرسالة، وفعّلها.")}
              </p>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
              {RECIPES.map((r) => (
                <button
                  key={r.id}
                  className="card"
                  style={{ padding: 16, textAlign: "start", cursor: "pointer", background: "var(--bg-2)" }}
                  onClick={() => setView({ kind: "edit", draft: r.build({ wonStageRef }) })}
                >
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{tx(r.en, r.ar)}</div>
                  <div style={{ color: "var(--ink-3)", fontSize: 12, marginTop: 6 }}>{tx(r.descEn, r.descAr)}</div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          store.list.map((a) => (
            <div
              key={a.id}
              className="card"
              style={{ padding: "14px 18px", display: "flex", alignItems: "center", gap: 16, cursor: "pointer" }}
              onClick={() => setView({ kind: "edit", draft: a })}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{a.name || tx("Untitled", "بدون اسم")}</div>
                <div style={{ color: "var(--ink-3)", fontSize: 12, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {summarize(a, t.lang, ctx)}
                </div>
              </div>
              <div className="mono" style={{ color: "var(--ink-3)", fontSize: 11, textAlign: "end", flexShrink: 0 }}>
                <div>{a.runs} {tx("runs", "تشغيل")}</div>
                <div>{tx("Last", "آخر")}: {fmtDate(a.lastRunAt)}</div>
              </div>
              <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Toggle on={a.enabled} onChange={(v) => store.setEnabled(a.id, v)} />
                <button
                  className="btn"
                  aria-label={tx("Delete", "حذف")}
                  style={{ padding: 6 }}
                  onClick={() => setConfirmDelete(a)}
                >
                  <IconTrash w={14} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {confirmDelete && (
        <Modal onClose={() => setConfirmDelete(null)} label={tx("Delete automation", "حذف الأتمتة")}>
          <h3 style={{ marginTop: 0 }}>{tx("Delete this automation?", "حذف هذه الأتمتة؟")}</h3>
          <p style={{ color: "var(--ink-3)", fontSize: 13 }}>{confirmDelete.name}</p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button className="btn" onClick={() => setConfirmDelete(null)}>{tx("Cancel", "إلغاء")}</button>
            <button
              className="btn primary"
              onClick={() => {
                store.remove(confirmDelete.id);
                setConfirmDelete(null);
                toast(tx("Automation deleted", "تم حذف الأتمتة"), "info");
              }}
            >
              {tx("Delete", "حذف")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS. If `IconPlus`/`IconTrash`/`IconBolt` do not accept `w`, check `src/icons/index.tsx` for the prop name and adjust; NAV already uses `Icon: ComponentType<{ w?: number }>` so `w` is expected.

- [ ] **Step 7: Browser check**

Run `npm run dev`, log in, open `#/automations`. Expect: the nav shows Automations after Campaigns, the empty state shows three recipe cards, clicking one opens the stub and "Save stub" returns to a list with one row whose summary reads as a sentence. Toggle and delete work. Switch language to Arabic in Settings and confirm the labels flip and the layout is RTL.

- [ ] **Step 8: Commit**

```bash
git add src/lib/types.ts src/shell/nav.ts src/router.tsx src/screens/automations/AutomationsPage.tsx
git commit -m "feat(automations): route, nav entry, list page with recipes and delete

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Template picker

**Files:**
- Create: `src/screens/automations/TemplatePicker.tsx`

**Interfaces:**
- Consumes: `MOCK_TEMPLATES`, `SAMPLE`, `suppliedTokens` (Task 2); `renderTemplate`, `missingTokens`, `AutomationTemplate`, `Trigger` (Task 1); `Badge`.
- Produces:
  - `TemplatePicker({ channel, trigger, selectedId, onSelect }: { channel: "whatsapp" | "email"; trigger: Trigger | null; selectedId: string | null; onSelect: (t: AutomationTemplate) => void })`
  - `TemplatePreview({ template, lang }: { template: AutomationTemplate; lang: Lang })` renders subject (email) and body with sample values in a bubble.
  - `warningText(missing: Token[], trigger: Trigger | null, lang: Lang): string` exported for reuse in `StepCard`.

- [ ] **Step 1: Create the picker**

Create `src/screens/automations/TemplatePicker.tsx`:

```tsx
import { useMemo, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import type { Lang } from "@/lib/types";
import {
  missingTokens,
  renderTemplate,
  type AutomationTemplate,
  type Token,
  type Trigger,
} from "@/lib/automations";
import { Badge } from "@/components/Badge";
import { IconAlert, IconCheck, IconSearch } from "@/icons";
import { MOCK_TEMPLATES, SAMPLE, suppliedTokens, triggerDef } from "./catalog";

const GROUP_LABEL: Record<Lang, Record<string, string>> = {
  en: { contact: "contact", deal: "deal", stage: "stage", conversation: "conversation", appointment: "appointment", tag: "tag" },
  ar: { contact: "جهة الاتصال", deal: "الصفقة", stage: "المرحلة", conversation: "المحادثة", appointment: "الموعد", tag: "الوسم" },
};

/** "This template needs deal info, but the trigger is New contact". */
export function warningText(missing: Token[], trigger: Trigger | null, lang: Lang): string {
  const groups = [...new Set(missing.map((m) => m.split(".")[0]))]
    .map((g) => GROUP_LABEL[lang][g] ?? g)
    .join(lang === "ar" ? " و" : " and ");
  const trig = trigger ? (lang === "ar" ? triggerDef(trigger.kind).ar : triggerDef(trigger.kind).en) : "";
  return lang === "ar"
    ? `هذا القالب يحتاج معلومات ${groups}، لكن المشغّل هو "${trig}"`
    : `This template needs ${groups} info, but the trigger is "${trig}"`;
}

export function TemplatePreview({ template, lang }: { template: AutomationTemplate; lang: Lang }) {
  const values = SAMPLE[lang];
  const body = renderTemplate(template.body, values, template.variableMap);
  const subject = template.subject ? renderTemplate(template.subject, values, template.variableMap) : null;
  return (
    <div
      dir={template.lang === "ar" ? "rtl" : "ltr"}
      style={{
        background: template.channel === "whatsapp" ? "oklch(0.93 0.06 150)" : "var(--bg-2)",
        color: "oklch(0.2 0.02 150)",
        borderRadius: 12,
        padding: "10px 12px",
        fontSize: 13,
        lineHeight: 1.45,
        whiteSpace: "pre-wrap",
        maxWidth: 420,
      }}
    >
      {subject && <div style={{ fontWeight: 600, marginBottom: 6 }}>{subject}</div>}
      {body}
    </div>
  );
}

interface TemplatePickerProps {
  channel: "whatsapp" | "email";
  trigger: Trigger | null;
  selectedId: string | null;
  onSelect: (t: AutomationTemplate) => void;
}

export function TemplatePicker({ channel, trigger, selectedId, onSelect }: TemplatePickerProps) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const [q, setQ] = useState("");
  const supplied = suppliedTokens(trigger);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return MOCK_TEMPLATES.filter((tpl) => tpl.channel === channel)
      .filter((tpl) => !needle || tpl.name.toLowerCase().includes(needle))
      .map((tpl) => ({ tpl, missing: missingTokens(tpl, supplied) }))
      // Compatible first, then keep catalog order.
      .sort((a, b) => Number(a.missing.length > 0) - Number(b.missing.length > 0));
  }, [channel, q, supplied]);

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          border: "1px solid var(--line)",
          borderRadius: 8,
          background: "var(--bg-1)",
        }}
      >
        <IconSearch w={14} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={tx("Search templates", "ابحث في القوالب")}
          style={{ border: 0, background: "transparent", outline: "none", flex: 1, fontSize: 13, color: "inherit" }}
        />
      </label>

      <div style={{ display: "grid", gap: 6, maxHeight: 360, overflowY: "auto" }}>
        {rows.length === 0 && (
          <div style={{ color: "var(--ink-3)", fontSize: 13, padding: 12 }}>{tx("No templates match.", "لا توجد قوالب مطابقة.")}</div>
        )}
        {rows.map(({ tpl, missing }) => {
          const selected = tpl.id === selectedId;
          return (
            <button
              key={tpl.id}
              type="button"
              onClick={() => onSelect(tpl)}
              style={{
                textAlign: "start",
                padding: 12,
                borderRadius: 10,
                border: `1px solid ${selected ? "var(--accent)" : "var(--line-soft)"}`,
                background: selected ? "var(--bg-2)" : "var(--bg-1)",
                cursor: "pointer",
                color: "inherit",
                display: "grid",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>{tpl.name}</span>
                <Badge kind="">{tpl.lang.toUpperCase()}</Badge>
                <Badge kind="ok" dot>{tx("Approved", "معتمد")}</Badge>
                {selected && <IconCheck w={14} />}
              </div>
              <TemplatePreview template={tpl} lang={t.lang} />
              {missing.length > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--warn, #b7791f)", fontSize: 12 }}>
                  <IconAlert w={13} />
                  {warningText(missing, trigger, t.lang)}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS. If `IconAlert`, `IconCheck`, or `IconSearch` are missing from `src/icons/index.tsx`, use `IconBell`, `IconCheckCircle`, or `IconFilter` respectively; all three named here exist per the icon inventory.

- [ ] **Step 3: Commit**

```bash
git add src/screens/automations/TemplatePicker.tsx
git commit -m "feat(automations): template picker with rendered previews and compatibility warning

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Step card and add-step menu

**Files:**
- Create: `src/screens/automations/StepCard.tsx`

**Interfaces:**
- Consumes: `Step`, `StepKind`, `Trigger`, `missingTokens` (Task 1); `templateById`, `stepLabel`, `suppliedTokens` (Task 2); `TemplatePicker`, `TemplatePreview`, `warningText` (Task 5); dnd-kit `useSortable`.
- Produces:
  - `StepCard({ step, trigger, expanded, onToggle, onChange, onRemove }: { step: Step; trigger: Trigger | null; expanded: boolean; onToggle: () => void; onChange: (s: Step) => void; onRemove: () => void })` — must be rendered inside a `SortableContext`.
  - `AddStepMenu({ onAdd }: { onAdd: (kind: StepKind) => void })`

- [ ] **Step 1: Create the file**

Create `src/screens/automations/StepCard.tsx`:

```tsx
import { useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { missingTokens, type Step, type StepKind, type Trigger } from "@/lib/automations";
import { IconAlert, IconChevDown, IconClock, IconMore, IconPlus, IconSend, IconTrash } from "@/icons";
import { stepLabel, suppliedTokens, templateById } from "./catalog";
import { TemplatePicker, TemplatePreview, warningText } from "./TemplatePicker";

const WAIT_CHIPS: { amount: number; unit: "hours" | "days" }[] = [
  { amount: 1, unit: "hours" },
  { amount: 1, unit: "days" },
  { amount: 2, unit: "days" },
  { amount: 3, unit: "days" },
];

interface StepCardProps {
  step: Step;
  trigger: Trigger | null;
  expanded: boolean;
  onToggle: () => void;
  onChange: (s: Step) => void;
  onRemove: () => void;
}

export function StepCard({ step, trigger, expanded, onToggle, onChange, onRemove }: StepCardProps) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: step.id });

  const tpl = step.kind === "wait" ? undefined : templateById(step.templateId);
  const missing = tpl ? missingTokens(tpl, suppliedTokens(trigger)) : [];

  const Icon = step.kind === "wait" ? IconClock : IconSend;
  const kindLabel =
    step.kind === "whatsapp" ? tx("Send WhatsApp", "إرسال واتساب")
    : step.kind === "email" ? tx("Send Email", "إرسال بريد")
    : tx("Wait", "انتظار");

  return (
    <div
      ref={setNodeRef}
      className="card"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.7 : 1,
        padding: 0,
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px" }}>
        <button
          type="button"
          aria-label={tx("Drag to reorder", "اسحب لإعادة الترتيب")}
          {...attributes}
          {...listeners}
          style={{ cursor: "grab", background: "transparent", border: 0, color: "var(--ink-3)", padding: 4, touchAction: "none" }}
        >
          <IconMore w={14} />
        </button>
        <Icon w={16} />
        <button
          type="button"
          onClick={onToggle}
          style={{ flex: 1, textAlign: "start", background: "transparent", border: 0, color: "inherit", cursor: "pointer", minWidth: 0 }}
        >
          <div style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{kindLabel}</div>
          <div style={{ fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {stepLabel(step, t.lang)}
          </div>
        </button>
        {missing.length > 0 && !expanded && (
          <span title={warningText(missing, trigger, t.lang)} style={{ color: "var(--warn, #b7791f)", display: "flex" }}>
            <IconAlert w={14} />
          </span>
        )}
        <button type="button" className="btn" aria-label={tx("Remove step", "إزالة الخطوة")} style={{ padding: 6 }} onClick={onRemove}>
          <IconTrash w={13} />
        </button>
        <button
          type="button"
          className="btn"
          aria-label={expanded ? tx("Collapse", "طيّ") : tx("Expand", "توسيع")}
          style={{ padding: 6, transform: expanded ? "rotate(180deg)" : undefined }}
          onClick={onToggle}
        >
          <IconChevDown w={13} />
        </button>
      </div>

      {expanded && (
        <div style={{ borderTop: "1px solid var(--line-soft)", padding: 14, display: "grid", gap: 12, background: "var(--bg-2)" }}>
          {step.kind === "wait" && (
            <div style={{ display: "grid", gap: 10 }}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {WAIT_CHIPS.map((c) => {
                  const active = step.amount === c.amount && step.unit === c.unit;
                  return (
                    <button
                      key={`${c.amount}${c.unit}`}
                      type="button"
                      className={`btn${active ? " primary" : ""}`}
                      onClick={() => onChange({ ...step, amount: c.amount, unit: c.unit })}
                    >
                      {stepLabel({ ...step, amount: c.amount, unit: c.unit }, t.lang).replace(/^(wait|انتظر) /, "")}
                    </button>
                  );
                })}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                <span style={{ color: "var(--ink-3)" }}>{tx("Custom", "مخصص")}</span>
                <input
                  type="number"
                  min={1}
                  value={step.amount}
                  onChange={(e) => onChange({ ...step, amount: Math.max(1, Number(e.target.value) || 1) })}
                  style={{ width: 72, padding: "6px 8px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--bg-1)", color: "inherit" }}
                />
                <select
                  value={step.unit}
                  onChange={(e) => onChange({ ...step, unit: e.target.value as "hours" | "days" })}
                  style={{ padding: "6px 8px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--bg-1)", color: "inherit" }}
                >
                  <option value="hours">{tx("hours", "ساعات")}</option>
                  <option value="days">{tx("days", "أيام")}</option>
                </select>
              </div>
            </div>
          )}

          {(step.kind === "whatsapp" || step.kind === "email") && (
            <>
              {step.kind === "email" && (
                <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--ink-3)" }}>
                  {tx("Subject", "الموضوع")}
                  <input
                    value={step.subject}
                    onChange={(e) => onChange({ ...step, subject: e.target.value })}
                    placeholder={tx("Pick a template to prefill", "اختر قالباً لتعبئته")}
                    style={{ padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--bg-1)", color: "inherit", fontSize: 13 }}
                  />
                </label>
              )}

              {tpl ? (
                <div style={{ display: "grid", gap: 8 }}>
                  <TemplatePreview template={tpl} lang={t.lang} />
                  {missing.length > 0 && (
                    <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--warn, #b7791f)", fontSize: 12 }}>
                      <IconAlert w={13} /> {warningText(missing, trigger, t.lang)}
                    </div>
                  )}
                  <button
                    type="button"
                    className="btn"
                    style={{ justifySelf: "start" }}
                    onClick={() => onChange({ ...step, templateId: null })}
                  >
                    {tx("Change template", "تغيير القالب")}
                  </button>
                </div>
              ) : (
                <TemplatePicker
                  channel={step.kind}
                  trigger={trigger}
                  selectedId={step.templateId}
                  onSelect={(chosen) =>
                    onChange(
                      step.kind === "email"
                        ? { ...step, templateId: chosen.id, subject: step.subject || chosen.subject || "" }
                        : { ...step, templateId: chosen.id },
                    )
                  }
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function AddStepMenu({ onAdd }: { onAdd: (kind: StepKind) => void }) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const [open, setOpen] = useState(false);
  const pick = (k: StepKind) => {
    onAdd(k);
    setOpen(false);
  };
  return (
    <div style={{ display: "grid", justifyItems: "center", gap: 8 }}>
      {!open ? (
        <button type="button" className="btn" onClick={() => setOpen(true)} style={{ borderStyle: "dashed" }}>
          <IconPlus w={14} /> {tx("Add step", "إضافة خطوة")}
        </button>
      ) : (
        <div className="card" style={{ padding: 6, display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
          <button type="button" className="btn" onClick={() => pick("whatsapp")}><IconSend w={14} /> {tx("Send WhatsApp", "إرسال واتساب")}</button>
          <button type="button" className="btn" onClick={() => pick("email")}><IconSend w={14} /> {tx("Send Email", "إرسال بريد")}</button>
          <button type="button" className="btn" onClick={() => pick("wait")}><IconClock w={14} /> {tx("Wait", "انتظار")}</button>
          <button type="button" className="btn" onClick={() => setOpen(false)} aria-label={tx("Cancel", "إلغاء")}>✕</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS. `@dnd-kit/utilities` is present in `node_modules` (transitive) and already imported by `src/screens/pipeline/TicketCard.tsx`.

- [ ] **Step 3: Commit**

```bash
git add src/screens/automations/StepCard.tsx
git commit -m "feat(automations): sortable step card for WhatsApp, email, and wait plus add-step menu

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Trigger picker with inline settings

**Files:**
- Create: `src/screens/automations/TriggerPicker.tsx`

**Interfaces:**
- Consumes: `TRIGGERS`, `triggerDef`, `triggerLabel`, `LabelContext` (Task 2); `Trigger`, `TriggerKind`, `ConversationChannel` (Task 1); `useFetch<Pipeline[]>("/pipelines")`, `useFetch<TagRow[]>("/tags")`.
- Produces: `TriggerPicker({ trigger, onChange, ctx }: { trigger: Trigger | null; onChange: (t: Trigger) => void; ctx: LabelContext })`

- [ ] **Step 1: Create the file**

Create `src/screens/automations/TriggerPicker.tsx`:

```tsx
import { useState, type ComponentType } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import type { Pipeline, TagRow } from "@/lib/types";
import type { ConversationChannel, Trigger, TriggerKind } from "@/lib/automations";
import { useFetch } from "@/api/useFetch";
import { IconBolt, IconCal, IconClock, IconInbox, IconLayers, IconTag, IconUsers } from "@/icons";
import { TRIGGERS, triggerDef, triggerLabel, type LabelContext } from "./catalog";

const ICONS: Record<TriggerKind, ComponentType<{ w?: number }>> = {
  "contact.created": IconUsers,
  "deal.stage_changed": IconLayers,
  "conversation.started": IconInbox,
  "appointment.booked": IconCal,
  "appointment.upcoming": IconClock,
  "contact.tagged": IconTag,
};

const selectStyle = {
  padding: "8px 10px",
  border: "1px solid var(--line)",
  borderRadius: 8,
  background: "var(--bg-1)",
  color: "inherit",
  fontSize: 13,
} as const;

interface TriggerPickerProps {
  trigger: Trigger | null;
  onChange: (t: Trigger) => void;
  ctx: LabelContext;
}

export function TriggerPicker({ trigger, onChange, ctx }: TriggerPickerProps) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const [choosing, setChoosing] = useState(trigger === null);
  const pipelinesQ = useFetch<Pipeline[]>("/pipelines", { enabled: trigger?.kind === "deal.stage_changed" });
  const tagsQ = useFetch<TagRow[]>("/tags", { enabled: trigger?.kind === "contact.tagged" });

  if (choosing || !trigger) {
    return (
      <div className="card" style={{ padding: 16, borderStyle: trigger ? "solid" : "dashed" }}>
        <div style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 10 }}>
          {tx("When…", "عندما…")}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8 }}>
          {TRIGGERS.map((def) => {
            const Icon = ICONS[def.kind];
            const active = trigger?.kind === def.kind;
            return (
              <button
                key={def.kind}
                type="button"
                onClick={() => {
                  onChange(active ? trigger : def.defaults);
                  setChoosing(false);
                }}
                style={{
                  textAlign: "start",
                  padding: 12,
                  borderRadius: 10,
                  border: `1px solid ${active ? "var(--accent)" : "var(--line-soft)"}`,
                  background: "var(--bg-1)",
                  color: "inherit",
                  cursor: "pointer",
                  display: "grid",
                  gap: 6,
                }}
              >
                <Icon w={16} />
                <div style={{ fontWeight: 600, fontSize: 13 }}>{tx(def.en, def.ar)}</div>
                <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{tx(def.descEn, def.descAr)}</div>
              </button>
            );
          })}
        </div>
        {trigger && (
          <button type="button" className="btn" style={{ marginTop: 10 }} onClick={() => setChoosing(false)}>
            {tx("Cancel", "إلغاء")}
          </button>
        )}
      </div>
    );
  }

  const def = triggerDef(trigger.kind);
  const Icon = ICONS[trigger.kind];
  const pipelines = pipelinesQ.data ?? [];
  const pipeline =
    trigger.kind === "deal.stage_changed"
      ? pipelines.find((p) => p.id === trigger.pipelineId) ?? pipelines.find((p) => p.isDefault) ?? pipelines[0]
      : undefined;

  return (
    <div className="card" style={{ padding: 16, display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <IconBolt w={14} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{tx("When…", "عندما…")}</div>
          <div style={{ fontSize: 15, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
            <Icon w={16} /> {triggerLabel(trigger, t.lang, ctx)}
          </div>
        </div>
        <button type="button" className="btn" onClick={() => setChoosing(true)}>{tx("Change", "تغيير")}</button>
      </div>
      <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{tx(def.descEn, def.descAr)}</div>

      {trigger.kind === "deal.stage_changed" && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select
            style={selectStyle}
            value={pipeline?.id ?? ""}
            onChange={(e) => onChange({ ...trigger, pipelineId: e.target.value, stageId: "" })}
          >
            <option value="" disabled>{tx("Pipeline", "المسار")}</option>
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>{t.lang === "ar" ? p.nameAr || p.name : p.name}</option>
            ))}
          </select>
          <select
            style={selectStyle}
            value={trigger.stageId}
            disabled={!pipeline}
            onChange={(e) => onChange({ ...trigger, pipelineId: pipeline?.id ?? trigger.pipelineId, stageId: e.target.value })}
          >
            <option value="" disabled>{tx("Stage", "المرحلة")}</option>
            {(pipeline?.stages ?? []).map((s) => (
              <option key={s.id} value={s.id}>{t.lang === "ar" ? s.labelAr || s.label : s.label}</option>
            ))}
          </select>
        </div>
      )}

      {trigger.kind === "conversation.started" && (
        <select
          style={selectStyle}
          value={trigger.channel}
          onChange={(e) => onChange({ ...trigger, channel: e.target.value as ConversationChannel })}
        >
          <option value="any">{tx("Any channel", "أي قناة")}</option>
          <option value="whatsapp">WhatsApp</option>
          <option value="instagram">Instagram</option>
          <option value="facebook">Facebook</option>
        </select>
      )}

      {trigger.kind === "appointment.upcoming" && (
        <select
          style={selectStyle}
          value={trigger.hoursBefore}
          onChange={(e) => onChange({ ...trigger, hoursBefore: Number(e.target.value) })}
        >
          {[1, 2, 24, 48].map((h) => (
            <option key={h} value={h}>
              {t.lang === "ar" ? `قبل ${h} ساعة` : `${h} hour${h === 1 ? "" : "s"} before`}
            </option>
          ))}
        </select>
      )}

      {trigger.kind === "contact.tagged" && (
        <select style={selectStyle} value={trigger.tagId} onChange={(e) => onChange({ ...trigger, tagId: e.target.value })}>
          <option value="" disabled>{tx("Pick a tag", "اختر وسماً")}</option>
          {(tagsQ.data ?? []).map((tag) => (
            <option key={tag.id} value={tag.id}>{tag.name}</option>
          ))}
        </select>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS. Note the pipeline select uses `pipeline?.id` as its value so a recipe built with `pipelineId: ""` still shows the default pipeline preselected; the first stage change then writes the real pipeline id.

- [ ] **Step 3: Commit**

```bash
git add src/screens/automations/TriggerPicker.tsx
git commit -m "feat(automations): six-trigger picker with inline settings

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Builder screen and wiring into the page

**Files:**
- Create: `src/screens/automations/AutomationBuilder.tsx`
- Modify: `src/screens/automations/AutomationsPage.tsx` (remove the stub, import the real builder)

**Interfaces:**
- Consumes: `TriggerPicker` (Task 7); `StepCard`, `AddStepMenu` (Task 6); `useLabelContext` (Task 4); `canSave`, `newStep`, `Automation`, `Step` (Task 1); `suggestName`, `summarize` (Task 2); dnd-kit `DndContext`, `SortableContext`, `arrayMove`; `Toggle`, `Modal`.
- Produces: default export `AutomationBuilder({ initial, onSave, onBack })` with the exact prop shape the Task 4 stub used.

- [ ] **Step 1: Create the builder**

Create `src/screens/automations/AutomationBuilder.tsx`:

```tsx
import { useMemo, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { canSave, newStep, type Automation, type Step, type StepKind, type Trigger } from "@/lib/automations";
import { Toggle } from "@/components/Toggle";
import { Modal } from "@/components/Modal";
import { IconArrow } from "@/icons";
import { suggestName, summarize } from "./catalog";
import { TriggerPicker } from "./TriggerPicker";
import { AddStepMenu, StepCard } from "./StepCard";
import { useLabelContext } from "./AutomationsPage";

interface AutomationBuilderProps {
  initial: Automation;
  onSave: (a: Automation) => void;
  onBack: () => void;
}

export default function AutomationBuilder({ initial, onSave, onBack }: AutomationBuilderProps) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const ctx = useLabelContext();
  const [draft, setDraft] = useState<Automation>(initial);
  const [expanded, setExpanded] = useState<string | null>(
    initial.steps.find((s) => s.kind !== "wait" && s.templateId === null)?.id ?? null,
  );
  const [confirmLeave, setConfirmLeave] = useState(false);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(initial), [draft, initial]);
  const displayName = draft.nameEdited ? draft.name : suggestName(draft, t.lang, ctx);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const patch = (p: Partial<Automation>) => setDraft((d) => ({ ...d, ...p }));
  const setTrigger = (trigger: Trigger) => patch({ trigger });
  const updateStep = (s: Step) => patch({ steps: draft.steps.map((x) => (x.id === s.id ? s : x)) });
  const removeStep = (id: string) => patch({ steps: draft.steps.filter((x) => x.id !== id) });
  const addStep = (kind: StepKind) => {
    const s = newStep(kind);
    patch({ steps: [...draft.steps, s] });
    setExpanded(s.id);
  };
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = draft.steps.findIndex((s) => s.id === active.id);
    const to = draft.steps.findIndex((s) => s.id === over.id);
    if (from === -1 || to === -1) return;
    patch({ steps: arrayMove(draft.steps, from, to) });
  };

  const missingHint = !draft.trigger
    ? tx("Choose a trigger to continue.", "اختر مشغّلاً للمتابعة.")
    : !canSave(draft)
      ? tx("Add a WhatsApp or Email step and pick a template.", "أضف خطوة واتساب أو بريد واختر قالباً.")
      : null;

  const back = () => (dirty ? setConfirmLeave(true) : onBack());

  return (
    <div style={{ overflowY: "auto", flex: 1 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "16px 24px",
          borderBottom: "1px solid var(--line-soft)",
          position: "sticky",
          top: 0,
          background: "var(--bg-1)",
          zIndex: 2,
        }}
      >
        <button type="button" className="btn" onClick={back} aria-label={tx("Back", "رجوع")}>
          <span className="flip-rtl" style={{ display: "inline-flex", transform: "rotate(180deg)" }}><IconArrow w={14} /></span>
        </button>
        <input
          value={displayName}
          onChange={(e) => patch({ name: e.target.value, nameEdited: true })}
          aria-label={tx("Automation name", "اسم الأتمتة")}
          style={{ flex: 1, fontSize: 18, fontWeight: 600, border: 0, background: "transparent", color: "inherit", outline: "none", minWidth: 0 }}
        />
        <Toggle on={draft.enabled} onChange={(v) => patch({ enabled: v })} label={tx("Enabled", "مفعّلة")} />
        <button
          type="button"
          className="btn primary"
          disabled={!canSave(draft)}
          title={missingHint ?? undefined}
          onClick={() => onSave({ ...draft, name: displayName })}
        >
          {tx("Save", "حفظ")}
        </button>
      </div>

      <div style={{ maxWidth: 640, margin: "0 auto", padding: "24px 16px 60px", display: "grid", gap: 0 }}>
        <div style={{ color: "var(--ink-3)", fontSize: 13, marginBottom: 16 }}>{summarize(draft, t.lang, ctx)}</div>

        <TriggerPicker trigger={draft.trigger} onChange={setTrigger} ctx={ctx} />

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={draft.steps.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            {draft.steps.map((s) => (
              <div key={s.id}>
                <Connector />
                <StepCard
                  step={s}
                  trigger={draft.trigger}
                  expanded={expanded === s.id}
                  onToggle={() => setExpanded(expanded === s.id ? null : s.id)}
                  onChange={updateStep}
                  onRemove={() => removeStep(s.id)}
                />
              </div>
            ))}
          </SortableContext>
        </DndContext>

        <Connector />
        <AddStepMenu onAdd={addStep} />

        {missingHint && (
          <div style={{ textAlign: "center", color: "var(--ink-3)", fontSize: 12, marginTop: 16 }}>{missingHint}</div>
        )}
      </div>

      {confirmLeave && (
        <Modal onClose={() => setConfirmLeave(false)} label={tx("Unsaved changes", "تغييرات غير محفوظة")}>
          <h3 style={{ marginTop: 0 }}>{tx("Leave without saving?", "الخروج دون حفظ؟")}</h3>
          <p style={{ color: "var(--ink-3)", fontSize: 13 }}>
            {tx("Your changes to this automation will be lost.", "ستفقد تغييراتك على هذه الأتمتة.")}
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="btn" onClick={() => setConfirmLeave(false)}>{tx("Keep editing", "متابعة التحرير")}</button>
            <button type="button" className="btn primary" onClick={onBack}>{tx("Leave", "خروج")}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Thin vertical line joining the cards. */
function Connector() {
  return (
    <div style={{ display: "grid", justifyItems: "center", height: 20 }}>
      <div style={{ width: 2, height: "100%", background: "var(--line)" }} />
    </div>
  );
}
```

- [ ] **Step 2: Replace the stub in the page**

In `src/screens/automations/AutomationsPage.tsx`:
- Delete the whole `// Temporary stub...` block (the local `function AutomationBuilder(...)`).
- Add `import AutomationBuilder from "./AutomationBuilder";` after the `./store` import.

Note the circular import (`AutomationBuilder` imports `useLabelContext` from `AutomationsPage`, and the page imports the builder). Both are used only inside function bodies, so ES modules resolve it fine. If the typechecker or Vite complains, move `useLabelContext` into a new file `src/screens/automations/useLabelContext.ts` with identical code and import it from both.

- [ ] **Step 3: Typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: both PASS.

- [ ] **Step 4: Browser walkthrough (English)**

Run `npm run dev` and open `#/automations`:
1. Click the "Deal won thank-you" recipe. The builder opens with the trigger card showing "Deal moves to Won" (if a Won stage exists) and three steps: WhatsApp, wait 2 days, Email. The name reads "Deal moves to Won → WhatsApp". Summary sentence at the top matches.
2. Click "Change" on the trigger, pick "New contact added". The WhatsApp and Email cards now show a warning icon; expand one and read "This template needs deal info, but the trigger is "New contact added"". Save is still enabled.
3. Click "+ Add step" → Wait. A new expanded Wait card appears at the bottom; click the "3 days" chip; collapsed label reads "wait 3 days".
4. Drag the new Wait card above the Email card using the handle. Order updates; summary sentence updates.
5. Edit the name to "My rule", then change the trigger; the name stays "My rule".
6. Click Save. Toast "Automation saved"; list shows the row with the summary and toggle.
7. Refresh the page. The row is still there.
8. Open the row, click Back without changes: returns immediately. Open again, change something, click Back: the "Leave without saving?" modal appears.
9. New automation from the header button: Save is disabled with the hint "Choose a trigger to continue."; pick a trigger, hint changes to "Add a WhatsApp or Email step and pick a template."; add WhatsApp, pick a template, Save enables.

- [ ] **Step 5: Browser walkthrough (Arabic)**

Switch language to Arabic in Settings and repeat steps 1, 3, and 6. Confirm: labels are Arabic, the layout is mirrored, the drag handle and back arrow sit on the correct side, template previews render Arabic sample data (سارة أحمد) while English templates keep LTR inside their bubble.

- [ ] **Step 6: Commit**

```bash
git add src/screens/automations/AutomationBuilder.tsx src/screens/automations/AutomationsPage.tsx
git commit -m "feat(automations): single-column builder with trigger, sortable steps, and save guard

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Final verification and memory note

**Files:**
- None new. Verification only, plus a memory entry.

- [ ] **Step 1: Full checks**

Run:
```bash
npm run typecheck && npm test && npm run build
```
Expected: all PASS, build output includes a separate chunk for the automations screen.

- [ ] **Step 2: Confirm every spec item has a home**

Walk the spec's "Screens", "Auto-mapping", "Persistence", and "Testing" sections and confirm each is visible in the running app or covered by a test. Known intentional gaps (backend, email infra, template editing) are listed in the spec's out-of-scope section and need no action.

- [ ] **Step 3: Write the project memory**

Create `C:\Users\ashra\.claude\projects\e--projects-crm\memory\project_automations_ui_phase.md` with frontmatter (`name: project-automations-ui-phase`, `type: project`) recording: shipped 2026-09-13 on branch `feat/automations-builder-ui` (unpushed until the user says otherwise), UI-only with localStorage store at `src/screens/automations/store.ts` as the swap point, `variableMap` planned as a Template column, and the email-infrastructure flag. Add a one-line pointer to `MEMORY.md`.

- [ ] **Step 4: Report**

Summarize for the user: what was built, how to reach it, what the tests cover, the branch name, and the two follow-ups (backend wiring; email provider plus Contact email field).
