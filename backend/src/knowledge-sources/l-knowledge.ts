import { HttpException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { LAgentResolverService } from "../integrations/l-agent-resolver.service";
import { LJoteckClient } from "../integrations/l-joteck.client";
import { TYPED_KINDS, type KnowledgeKind, type TypedKind } from "./knowledge-constants";
import type { KnowledgeSourceDto } from "./knowledge-sources.dto";
import { TYPED_COLUMNS } from "./typed-docs";

/**
 * The business's knowledge lives on l (kewy-ai): this CRM keeps its screens
 * and calls l's joteck knowledge API for the workspace's l workspace.
 *
 * Two names differ between the two:
 *  - kind: l "guidelines" is crm "guideline"; l "sheet" with a template id
 *    of offers/inventory/packages is crm "typed_doc" with that `typedKind`.
 *  - the crm templates are sent to l as l templates (`crmTemplate`).
 */

/** Thrown when the workspace has no l workspace yet (its AI agent is off). */
export const AGENT_OFF = "knowledge.agent_off";

export function agentOff(): HttpException {
  return new HttpException({ statusCode: 409, message: AGENT_OFF }, 409);
}

export interface LTarget {
  /** `/workspaces/{l id}/knowledge` */
  base: string;
  lWorkspaceId: string;
}

/** An l knowledge document, as l's joteck API returns it (crm-shaped apart from kind/template/agent). */
export type LSource = Omit<KnowledgeSourceDto, "kind" | "typedKind" | "publishState" | "legacy"> & {
  kind: string;
  template: string | null;
  agent: string | null;
};

export function toCrmKind(kind: string): KnowledgeKind {
  if (kind === "guidelines") return "guideline";
  if (kind === "sheet") return "typed_doc";
  return kind as KnowledgeKind;
}

/** The l kind for a crm kind filter (`?kind=`). */
export function toLKind(kind: string): string {
  if (kind === "guideline") return "guidelines";
  if (kind === "typed_doc") return "sheet";
  return kind;
}

export function isTypedKind(v: unknown): v is TypedKind {
  return typeof v === "string" && (TYPED_KINDS as readonly string[]).includes(v);
}

/** crm's DTO for an l document. */
export function toCrm(s: LSource): KnowledgeSourceDto {
  const { template, agent: _agent, kind, ...rest } = s;
  return {
    ...rest,
    kind: toCrmKind(kind),
    typedKind: kind === "sheet" && isTypedKind(template) ? template : null,
    publishState: "none",
    legacy: false,
  } as KnowledgeSourceDto;
}

const DATE_COLUMNS = new Set(["valid_from", "valid_to"]);

/**
 * One of crm's typed kinds as an l sheet template. Column rules match
 * typed-docs.ts; offers' `valid_to` hides a row once it has passed; an
 * empty currency next to a price is SAR, as before.
 */
export function crmTemplate(kind: TypedKind, currency = "SAR") {
  const cur = /^[A-Z]{3}$/.test(currency) ? currency : "SAR";
  const names = TYPED_COLUMNS[kind].map((c) => c.name);
  return {
    id: kind,
    columns: TYPED_COLUMNS[kind].map((c) => {
      const type = c.rule ?? (DATE_COLUMNS.has(c.name) ? "date" : "text");
      return {
        key: c.name,
        required: c.required,
        type,
        ...(kind === "offers" && c.name === "valid_to" ? { role: "expires_on" } : {}),
        ...(c.name === "currency"
          ? { default: cur, default_if: ["price", "original_price", "sale_price"].filter((n) => names.includes(n)) }
          : {}),
      };
    }),
  };
}

@Injectable()
export class LKnowledge {
  constructor(
    private readonly prisma: PrismaService,
    private readonly client: LJoteckClient,
    private readonly agents: LAgentResolverService,
  ) {}

  /** The workspace's l knowledge API, or null when its AI agent is off. */
  async target(workspaceId: string): Promise<LTarget | null> {
    if (!this.client.enabled) return null;
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { lWorkspaceId: true } });
    if (!ws?.lWorkspaceId) return null;
    return { lWorkspaceId: ws.lWorkspaceId, base: `/workspaces/${encodeURIComponent(ws.lWorkspaceId)}/knowledge` };
  }

  async require(workspaceId: string): Promise<LTarget> {
    const t = await this.target(workspaceId);
    if (!t) throw agentOff();
    return t;
  }

  /** The l agent whose guidelines this workspace edits. */
  agentSlug(workspaceId: string, t: LTarget): Promise<string> {
    return this.agents.resolveSlug(workspaceId, t.lWorkspaceId);
  }

  call<T>(
    t: LTarget,
    path: string,
    opts: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown; formData?: FormData; timeoutMs?: number } = {},
  ): Promise<T> {
    return this.client.request<T>(`${t.base}${path}`, { ...opts, passErrors: "knowledge." });
  }

  raw(t: LTarget, path: string) {
    return this.client.requestRaw(`${t.base}${path}`, { passErrors: "knowledge." });
  }
}
