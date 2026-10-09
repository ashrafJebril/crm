import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { LAgentResolverService } from "./l-agent-resolver.service";
import { LJoteckClient } from "./l-joteck.client";
import { LMcpService } from "./l-mcp.service";
import { McpTokenService } from "./mcp-token.service";

// l requires ^[a-z][a-z0-9_]*$ for MCP server names.
const CRM_MCP_SERVER_NAME = "kewy_crm";
// Marks a prompt that already carries the CRM section, so setup can re-run.
const PROMPT_MARKER = "<!-- kewy-crm-tools -->";

const CRM_PROMPT_SECTION = `${PROMPT_MARKER}
## Booking and customer records

You are connected to this business's CRM through tools. Use them; never claim to have booked, changed or cancelled anything unless a tool call succeeded.

To book an appointment:
1. Ask for anything missing: the service, the date and time, and the customer's name and phone number.
2. Call search_contacts with the customer's phone or name. If there is no match, call create_contact (source "chat", lifecycle "lead").
3. Optionally call list_appointments for that day to avoid a clash.
4. Call create_appointment with the contact's id, the service (and serviceAr, its Arabic name), startAt as an ISO 8601 datetime with a timezone offset, durationMin, status "pending" and source "self-booking".
5. Confirm the details back to the customer in their language.

To change or cancel, find the appointment with list_appointments, then use update_appointment or cancel_appointment. If a tool call fails, say so honestly and offer to have a team member follow up.`;

interface LAgent {
  slug: string;
  live_version: number | null;
}
interface LPrompt {
  version: number;
  content: string;
}

export interface AgentSetupResult {
  mcpServer: "created" | "already-present";
  prompt: "updated" | "already-present";
}

/**
 * Gives a workspace's Kewy AI agent access to this CRM, with no user action:
 * registers the CRM's own MCP endpoint on the l platform (with a freshly
 * minted token), binds it to the agent, and teaches the agent's prompt how to
 * book. Idempotent — safe to call on every link and to re-run for backfills.
 */
@Injectable()
export class LAgentSetupService {
  private readonly logger = new Logger(LAgentSetupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: LJoteckClient,
    private readonly resolver: LAgentResolverService,
    private readonly mcp: LMcpService,
    private readonly tokens: McpTokenService,
  ) {}

  /** Never throws: a failure here must not fail the link that triggered it. */
  async ensureQuietly(workspaceId: string): Promise<void> {
    try {
      await this.ensure(workspaceId);
    } catch (err) {
      this.logger.warn(
        `Kewy AI agent setup failed for workspace ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async ensure(workspaceId: string): Promise<AgentSetupResult> {
    const ws = await this.prisma.raw.workspace.findUnique({
      where: { id: workspaceId },
      select: { lWorkspaceId: true },
    });
    if (!ws?.lWorkspaceId) throw new Error("Workspace is not linked to Kewy AI");
    const lWorkspaceId = ws.lWorkspaceId;

    return {
      mcpServer: await this.ensureMcpServer(workspaceId),
      prompt: await this.ensurePrompt(workspaceId, lWorkspaceId),
    };
  }

  private async ensureMcpServer(workspaceId: string): Promise<AgentSetupResult["mcpServer"]> {
    const { servers } = await this.mcp.list(workspaceId);
    const existing = servers.find((s) => s.name === CRM_MCP_SERVER_NAME);
    // Only a server we can still authenticate against counts as present: if
    // the CRM token was revoked, re-register with a fresh one.
    if (existing && (await this.tokens.status(workspaceId)).connected) {
      await this.mcp.bind(workspaceId, existing.id);
      return "already-present";
    }
    if (existing) await this.mcp.remove(workspaceId, existing.id);

    const { token, endpointUrl } = await this.tokens.generate(workspaceId);
    const server = await this.mcp.create(workspaceId, {
      name: CRM_MCP_SERVER_NAME,
      description:
        "This business's CRM: appointments and contacts. Use it to book, reschedule or cancel appointments and to look up or create customers.",
      url: endpointUrl,
      headers: { Authorization: `Bearer ${token}` },
    });
    await this.mcp.bind(workspaceId, server.id);
    return "created";
  }

  private async ensurePrompt(
    workspaceId: string,
    lWorkspaceId: string,
  ): Promise<AgentSetupResult["prompt"]> {
    const slug = await this.resolver.resolveSlug(workspaceId, lWorkspaceId);
    const base = `/workspaces/${lWorkspaceId}/agents`;
    const agents = await this.client.request<LAgent[]>(base);
    const agent = agents.find((a) => a.slug === slug);
    const prompts = await this.client.request<LPrompt[]>(`${base}/${slug}/prompts`);
    const live = prompts.find((p) => p.version === agent?.live_version);
    const current = live?.content ?? "";
    if (current.includes(PROMPT_MARKER)) return "already-present";

    const content = current ? `${current.trimEnd()}\n\n${CRM_PROMPT_SECTION}` : CRM_PROMPT_SECTION;
    await this.client.request(`${base}/${slug}/prompt`, { method: "PUT", body: { content } });
    return "updated";
  }
}
