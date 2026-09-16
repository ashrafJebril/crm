export type ConditionOperator = "equals" | "not_equals" | "contains" | "not_contains";

export interface ConditionConfig {
  field: string;
  operator: ConditionOperator;
  value: string;
}

export interface AiConditionConfig {
  prompt: string;
}

export interface SendWhatsappConfig {
  message: string;
}

export interface AskAgentConfig {
  prompt: string;
}

export type UpdateDataConfig =
  | { operation: "add_tag"; tag: string }
  | { operation: "remove_tag"; tag: string }
  | { operation: "move_ticket_stage"; stageId: string }
  | {
      operation: "update_contact_field";
      field: "name" | "phone" | "industry" | "lifecycle" | "source" | "value";
      value: string;
    };

export interface DelayConfig {
  amount: number;
  unit: "minutes" | "hours" | "days";
}

interface BaseStep {
  id: string;
  next?: string;
}

export interface ConditionStep extends BaseStep {
  type: "condition";
  config: ConditionConfig;
  thenNext?: string;
  elseNext?: string;
}

export interface AiConditionStep extends BaseStep {
  type: "ai_condition";
  config: AiConditionConfig;
  thenNext?: string;
  elseNext?: string;
}

export interface SendWhatsappStep extends BaseStep {
  type: "send_whatsapp";
  config: SendWhatsappConfig;
}

export interface AskAgentStep extends BaseStep {
  type: "ask_agent";
  config: AskAgentConfig;
}

export interface UpdateDataStep extends BaseStep {
  type: "update_data";
  config: UpdateDataConfig;
}

export interface DelayStep extends BaseStep {
  type: "delay";
  config: DelayConfig;
}

export type Step =
  | ConditionStep
  | AiConditionStep
  | SendWhatsappStep
  | AskAgentStep
  | UpdateDataStep
  | DelayStep;

export interface StepGraph {
  entry: string | null;
  steps: Record<string, Step>;
}

export interface StoredCursor {
  stepId: string | null;
}

export function initialCursor(graph: StepGraph): StoredCursor {
  return { stepId: graph.entry };
}

const STEP_TYPES = [
  "condition",
  "ai_condition",
  "send_whatsapp",
  "ask_agent",
  "update_data",
  "delay",
] as const;

const CONDITION_OPERATORS: ConditionOperator[] = ["equals", "not_equals", "contains", "not_contains"];
const DELAY_UNITS = ["minutes", "hours", "days"];
const UPDATE_DATA_OPERATIONS = ["add_tag", "remove_tag", "move_ticket_stage", "update_contact_field"];
const CONTACT_FIELDS = ["name", "phone", "industry", "lifecycle", "source", "value"];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireString(v: unknown, label: string): string {
  if (typeof v !== "string") throw new Error(`${label} must be a string`);
  return v;
}

function requireNonEmptyString(v: unknown, label: string, strict: boolean): string {
  const s = requireString(v, label);
  if (strict && s.length === 0) throw new Error(`${label} must be a non-empty string`);
  return s;
}

function validateConfig(type: Step["type"], config: unknown, strict: boolean): void {
  if (!isObject(config)) throw new Error(`step config must be an object (type=${type})`);

  switch (type) {
    case "condition": {
      requireNonEmptyString(config.field, "condition.field", strict);
      if (!CONDITION_OPERATORS.includes(config.operator as ConditionOperator)) {
        throw new Error(`condition.operator must be one of ${CONDITION_OPERATORS.join(", ")}`);
      }
      requireNonEmptyString(config.value, "condition.value", strict);
      return;
    }
    case "ai_condition":
      requireNonEmptyString(config.prompt, "ai_condition.prompt", strict);
      return;
    case "send_whatsapp":
      requireNonEmptyString(config.message, "send_whatsapp.message", strict);
      return;
    case "ask_agent":
      requireNonEmptyString(config.prompt, "ask_agent.prompt", strict);
      return;
    case "delay": {
      if (typeof config.amount !== "number" || config.amount <= 0) {
        throw new Error("delay.amount must be a positive number");
      }
      if (!DELAY_UNITS.includes(config.unit as string)) {
        throw new Error(`delay.unit must be one of ${DELAY_UNITS.join(", ")}`);
      }
      return;
    }
    case "update_data": {
      if (!UPDATE_DATA_OPERATIONS.includes(config.operation as string)) {
        throw new Error(`update_data.operation must be one of ${UPDATE_DATA_OPERATIONS.join(", ")}`);
      }
      if (config.operation === "add_tag" || config.operation === "remove_tag") {
        requireNonEmptyString(config.tag, "update_data.tag", strict);
      } else if (config.operation === "move_ticket_stage") {
        requireNonEmptyString(config.stageId, "update_data.stageId", strict);
      } else if (config.operation === "update_contact_field") {
        if (!CONTACT_FIELDS.includes(config.field as string)) {
          throw new Error(`update_data.field must be one of ${CONTACT_FIELDS.join(", ")}`);
        }
        requireNonEmptyString(config.value, "update_data.value", strict);
      }
      return;
    }
  }
}

export function validateStepGraph(value: unknown, opts?: { strict?: boolean }): StepGraph {
  const strict = opts?.strict ?? true;
  if (!isObject(value)) throw new Error("Workflow steps must be an object");
  const { entry, steps } = value as { entry?: unknown; steps?: unknown };

  if (entry !== null && typeof entry !== "string") {
    throw new Error("Workflow steps.entry must be a string or null");
  }
  if (!isObject(steps)) throw new Error("Workflow steps.steps must be an object");

  const validated: Record<string, Step> = {};
  for (const [id, raw] of Object.entries(steps)) {
    if (!isObject(raw)) throw new Error(`step ${id} must be an object`);
    if (raw.id !== id) throw new Error(`step ${id} has a mismatched id field`);
    if (!STEP_TYPES.includes(raw.type as (typeof STEP_TYPES)[number])) {
      throw new Error(`step ${id} has an unknown step type: ${String(raw.type)}`);
    }
    validateConfig(raw.type as Step["type"], raw.config, strict);
    if (raw.next !== undefined && typeof raw.next !== "string") {
      throw new Error(`step ${id}.next must be a string`);
    }
    if (raw.type === "condition" || raw.type === "ai_condition") {
      if (raw.thenNext !== undefined && typeof raw.thenNext !== "string") {
        throw new Error(`step ${id}.thenNext must be a string`);
      }
      if (raw.elseNext !== undefined && typeof raw.elseNext !== "string") {
        throw new Error(`step ${id}.elseNext must be a string`);
      }
    }
    validated[id] = raw as unknown as Step;
  }

  if (entry !== null && !(entry in validated)) {
    throw new Error(`Workflow steps.entry "${entry}" not found in steps`);
  }

  return { entry: entry as string | null, steps: validated };
}
