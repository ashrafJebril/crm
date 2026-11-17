/**
 * SP-20 sandbox tool policy (pure). Deny by default, keyed on the tool id:
 *
 *  - only ids in SANDBOX_READ_TOOLS execute for real;
 *  - every other tool (the known writes, and any tool added later that is not
 *    listed) returns a mock `{simulated, ok, tool, note, args}` without
 *    touching a service. The decision never reads a tool's description.
 *
 * Also converts the MCP tools' zod (v3) input schemas into Claude tool
 * definitions with `strict: true` and `additionalProperties: false`. The
 * conversion covers the zod types the CRM tools use and throws on anything
 * else, so a new tool with an unsupported schema fails its spec, not a
 * customer's preview. Constraints the API does not accept in strict schemas
 * (min/max, lengths) are moved into the description by the SDK's own
 * `transformJSONSchema`, and are still enforced by zod before execution.
 */
import { transformJSONSchema } from "@anthropic-ai/sdk/lib/transform-json-schema";
import type Anthropic from "@anthropic-ai/sdk";
import type { ZodTypeAny } from "zod";
import { SANDBOX_READ_TOOLS } from "../agent-constants";

/** The shape of a tool built by McpToolsFactory (`@mastra/core` createTool). */
export interface SandboxableTool {
  id: string;
  description?: string;
  inputSchema?: unknown;
  execute?: (input: never, context: never) => Promise<unknown>;
}

export const SIMULATED_NOTE = "NOT saved: this is a test chat. Tell the owner what would have happened.";

export interface SimulatedResult {
  simulated: true;
  ok: true;
  tool: string;
  note: string;
  args: unknown;
}

export function isSandboxReadTool(id: string): boolean {
  return (SANDBOX_READ_TOOLS as readonly string[]).includes(id);
}

export function simulatedResult(tool: string, args: unknown): SimulatedResult {
  return { simulated: true, ok: true, tool, note: SIMULATED_NOTE, args };
}

/**
 * The same tools with every non-read `execute` replaced by the mock. The
 * originals are not mutated (the live MCP route keeps its own instances).
 */
export function sandboxTools<T extends Record<string, SandboxableTool>>(tools: T): T {
  const out: Record<string, SandboxableTool> = {};
  for (const [key, tool] of Object.entries(tools)) {
    const id = tool.id ?? key;
    out[key] = isSandboxReadTool(id)
      ? tool
      : { ...tool, execute: (async (input: unknown) => simulatedResult(id, input)) as SandboxableTool["execute"] };
  }
  return out as T;
}

// ── zod v3 → JSON schema (the subset the CRM tools use) ──────────────────

type Json = Record<string, unknown>;

function def(schema: ZodTypeAny): { typeName: string; [k: string]: unknown } {
  return (schema as unknown as { _def: { typeName: string } })._def;
}

function withDescription(schema: ZodTypeAny, json: Json): Json {
  const d = def(schema).description;
  return typeof d === "string" && d ? { ...json, description: d } : json;
}

/** One zod node; `optional` tells the caller whether the property is required. */
function convert(schema: ZodTypeAny): { json: Json; optional: boolean } {
  const d = def(schema);
  switch (d.typeName) {
    case "ZodOptional": {
      const inner = convert(d.innerType as ZodTypeAny);
      return { json: withDescription(schema, inner.json), optional: true };
    }
    case "ZodDefault": {
      const inner = convert(d.innerType as ZodTypeAny);
      const value = (d.defaultValue as () => unknown)();
      return { json: withDescription(schema, { ...inner.json, default: value }), optional: true };
    }
    case "ZodNullable": {
      const inner = convert(d.innerType as ZodTypeAny);
      return { json: withDescription(schema, { anyOf: [inner.json, { type: "null" }] }), optional: inner.optional };
    }
    case "ZodEffects":
      return convert(d.schema as ZodTypeAny);
    case "ZodString": {
      const json: Json = { type: "string" };
      for (const c of (d.checks as { kind: string; value?: number }[]) ?? []) {
        if (c.kind === "datetime") json.format = "date-time";
        else if (c.kind === "date") json.format = "date";
        else if (c.kind === "email") json.format = "email";
        else if (c.kind === "url") json.format = "uri";
        else if (c.kind === "uuid") json.format = "uuid";
        else if (c.kind === "min") json.minLength = c.value;
        else if (c.kind === "max") json.maxLength = c.value;
      }
      return { json: withDescription(schema, json), optional: false };
    }
    case "ZodNumber": {
      const json: Json = { type: "number" };
      for (const c of (d.checks as { kind: string; value?: number; inclusive?: boolean }[]) ?? []) {
        if (c.kind === "int") json.type = "integer";
        else if (c.kind === "min") json[c.inclusive === false ? "exclusiveMinimum" : "minimum"] = c.value;
        else if (c.kind === "max") json[c.inclusive === false ? "exclusiveMaximum" : "maximum"] = c.value;
      }
      return { json: withDescription(schema, json), optional: false };
    }
    case "ZodBoolean":
      return { json: withDescription(schema, { type: "boolean" }), optional: false };
    case "ZodEnum":
      return { json: withDescription(schema, { type: "string", enum: [...(d.values as string[])] }), optional: false };
    case "ZodLiteral":
      return { json: withDescription(schema, { const: d.value }), optional: false };
    case "ZodArray": {
      const items = convert(d.type as ZodTypeAny).json;
      return { json: withDescription(schema, { type: "array", items }), optional: false };
    }
    case "ZodUnion":
      return {
        json: withDescription(schema, { anyOf: (d.options as ZodTypeAny[]).map((o) => convert(o).json) }),
        optional: false,
      };
    case "ZodObject": {
      const shape = (d.shape as () => Record<string, ZodTypeAny>)();
      const properties: Record<string, Json> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        const c = convert(v);
        properties[k] = c.json;
        if (!c.optional) required.push(k);
      }
      return { json: withDescription(schema, { type: "object", properties, required, additionalProperties: false }), optional: false };
    }
    default:
      throw new Error(`sandbox: unsupported tool schema type ${d.typeName}`);
  }
}

/** A strict JSON schema for a zod object schema (an empty object when none). */
export function toolInputSchema(inputSchema: unknown): Anthropic.Beta.BetaTool.InputSchema {
  if (!inputSchema) return { type: "object", properties: {}, required: [], additionalProperties: false } as Anthropic.Beta.BetaTool.InputSchema;
  const json = convert(inputSchema as ZodTypeAny).json;
  if (json.type !== "object") throw new Error("sandbox: a tool's input schema must be an object");
  return transformJSONSchema(json) as Anthropic.Beta.BetaTool.InputSchema;
}

/**
 * Claude tool definitions, sorted by name (a stable prefix for the prompt
 * cache); the last one carries the tools' cache breakpoint.
 */
export function toolDefinitions(tools: Record<string, SandboxableTool>): Anthropic.Beta.BetaTool[] {
  const defs = Object.values(tools)
    .map(
      (t): Anthropic.Beta.BetaTool => ({
        name: t.id,
        description: t.description ?? t.id,
        input_schema: toolInputSchema(t.inputSchema),
        strict: true,
      }),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  if (defs.length) defs[defs.length - 1] = { ...defs[defs.length - 1], cache_control: { type: "ephemeral" } };
  return defs;
}

/** Tool arguments for display: primitive values as short strings, nothing nested. */
export function displayArgs(args: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!args || typeof args !== "object" || Array.isArray(args)) return out;
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = String(v).slice(0, 200);
  }
  return out;
}
