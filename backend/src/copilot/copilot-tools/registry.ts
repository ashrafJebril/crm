/**
 * SP-18 copilot tool registry: the only source of tools the model can call.
 *
 * Every tool runs as the member: it receives the member's `Viewer` and the
 * workspace from the JWT (never from the model), checks its own permission
 * with `PermissionService.viewerCan` before touching data (missing → a result
 * that says so, never data), and calls the existing services so SP-25
 * permissions and conversation visibility apply exactly as in the UI.
 *
 * Read tools `execute`; write tools (Task 2) `propose` a card. Tool input is
 * validated with the zod schema before anything runs; an unknown name is an
 * `is_error` result.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { ZodTypeAny } from "zod";
import type { Viewer } from "../../permissions/visibility";
import { toolInputSchema } from "../../agent/sandbox/sandbox-tools";
import type { SourceCollector } from "../copilot-sources";

export type ToolKind = "read" | "write";
export type ToolRisk = "low" | "medium" | "high";

/** Stream events a tool may emit (e.g. `draft`). */
export type ToolEmit = (event: string, data: unknown) => void;

export interface ToolContext {
  workspaceId: string;
  viewer: Viewer;
  sessionId: string;
  lang: "en" | "ar";
  now: Date;
  sources: SourceCollector;
  /** Customer-written text or outside content was read (ruling 5). */
  taint(): void;
  /** True once the session read customer-written or outside content. */
  isTainted(): boolean;
  emit: ToolEmit;
}

/** Where an approved write runs: as the member, at decision time (never the turn's context). */
export interface ExecContext {
  workspaceId: string;
  viewer: Viewer;
  sessionId: string;
  now: Date;
}

/** The card the member sees (labels are keys the frontend renders bilingually). */
export interface ActionCard {
  title: string;
  changes: { label: string; before?: string; after: string }[];
}

/** What a write tool proposes: the sealed args, the card, the permission it needs and its risk. */
export interface WriteProposal {
  args: Record<string, unknown>;
  card: ActionCard;
  permission: string;
  risk: ToolRisk;
}

export type ToolRefusal = { error: string; note: string };
export type Recheck = "ok" | "permission_revoked" | "card_outdated";

/** Thrown by a write tool's apply when the record changed since the card. */
export class CardOutdated extends Error {
  constructor() {
    super("card_outdated");
    this.name = "CardOutdated";
  }
}

export interface CopilotTool {
  name: string;
  description: string;
  inputSchema: ZodTypeAny;
  kind: ToolKind;
  /** Every listed permission is required (checked before execute). */
  permissions: string[];
  risk?: ToolRisk;
  /** Output fields written by customers (documentation; wrapped by the tool itself). */
  customerText?: string[];
  /** A short activity label, e.g. "Reading tickets". */
  label: [en: string, ar: string];
  /** Read tools: run as the member. Write tools never execute from the loop (they propose). */
  execute(ctx: ToolContext, input: never): Promise<unknown>;
  /** Write tools: validate as the member and build the card (no write). */
  propose?(ctx: ToolContext, input: never): Promise<WriteProposal | ToolRefusal>;
  /** Write tools: at approval, re-check the record as the member and that it did not change since the card. */
  recheck?(exec: ExecContext, args: Record<string, unknown>): Promise<Recheck>;
  /** Write tools: the write, through the existing service, as the member. May throw CardOutdated. */
  apply?(exec: ExecContext, args: Record<string, unknown>): Promise<unknown>;
}

/** The loop never runs a write tool's execute. */
export const WRITE_EXECUTE = async (): Promise<never> => {
  throw new Error("write tools propose; they are applied by CopilotActionsService");
};

/** The result a tool returns when the member lacks its permission (no data). */
export function noAccess(permission: string): { error: "no_access"; permission: string; note: string } {
  return {
    error: "no_access",
    permission,
    note: `The member's role does not include ${permission}, so this information is not available to them. Say so; do not guess.`,
  };
}

export class CopilotToolRegistry {
  private readonly byName = new Map<string, CopilotTool>();

  constructor(tools: CopilotTool[]) {
    for (const t of tools) {
      if (this.byName.has(t.name)) throw new Error(`duplicate copilot tool ${t.name}`);
      this.byName.set(t.name, t);
    }
  }

  get(name: string): CopilotTool | undefined {
    return this.byName.get(name);
  }

  names(): string[] {
    return [...this.byName.keys()].sort();
  }

  /**
   * Claude tool definitions: sorted by name (a stable, cacheable prefix),
   * `strict: true` with `additionalProperties: false`, and
   * `eager_input_streaming: true` (a streaming request with client tools;
   * every input is validated before it runs). The last carries the tools'
   * cache breakpoint.
   */
  definitions(): Anthropic.Beta.BetaTool[] {
    const defs = this.names().map((name) => {
      const t = this.byName.get(name) as CopilotTool;
      return {
        name: t.name,
        description: t.description,
        input_schema: toolInputSchema(t.inputSchema),
        strict: true,
        eager_input_streaming: true,
      } as Anthropic.Beta.BetaTool;
    });
    if (defs.length) defs[defs.length - 1] = { ...defs[defs.length - 1], cache_control: { type: "ephemeral" } };
    return defs;
  }
}
