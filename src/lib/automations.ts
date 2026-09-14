// Pure domain code for Automations. No React, no DOM. The shapes here mirror
// the future Prisma `Automation` model (trigger + steps as JSON columns), so
// the backend phase is CRUD plus a dispatcher with no frontend rework.

export type ConversationChannel = "any" | "whatsapp" | "instagram" | "facebook";

export type Trigger =
  | { kind: "contact.created" }
  | { kind: "deal.stage_changed"; pipelineId: string; stageId: string }
  | { kind: "conversation.started"; channel: ConversationChannel }
  | { kind: "appointment.booked" }
  | { kind: "appointment.upcoming"; hoursBefore: number }
  | { kind: "contact.tagged"; tagId: string };

export type TriggerKind = Trigger["kind"];

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

export const ALL_TOKENS = [
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
] as const;

export type Token = (typeof ALL_TOKENS)[number];

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
