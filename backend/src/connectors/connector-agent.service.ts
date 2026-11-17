import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { LMcpService } from "../integrations/l-mcp.service";
import { connectorError } from "./connector-errors";
import { mintProxyToken } from "./connector-proxy-token";

/** The CRM proxy URL l calls for one connector (CRM_MCP_PUBLIC_URL, as mcpEndpointUrl()). */
export function connectorProxyUrl(connectorId: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CRM_MCP_PUBLIC_URL?.trim() || env.BACKEND_PUBLIC_URL?.trim();
  if (!configured && env.NODE_ENV === "production") throw new Error("CRM_MCP_PUBLIC_URL is not configured");
  const base = (configured || "http://localhost:4100").replace(/\/$/, "");
  return `${base}/api/mcp/connectors/${encodeURIComponent(connectorId)}`;
}

type Row = { id: string; workspaceId: string; provider: string; lServerId: string | null; agentBound: boolean; proxyTokenPrefix: string | null };

/**
 * SP-23 l provisioning (ruling 4): each connector is ONE MCP server on l
 * whose URL is our proxy and whose bearer is the connector's `cnp_` token.
 * The agent picker is bind/unbind of that server (ruling 10: connecting binds
 * it). Disconnect unbinds and removes it on l (best effort) and revokes our
 * token (the guarantee: the proxy refuses a revoked token).
 */
@Injectable()
export class ConnectorAgentService {
  private readonly logger = new Logger(ConnectorAgentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lMcp: LMcpService,
  ) {}

  private async lLinked(workspaceId: string): Promise<boolean> {
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { lWorkspaceId: true } });
    return !!ws?.lWorkspaceId;
  }

  /**
   * Mints the proxy token, registers the server on l and binds it. A
   * workspace not linked to l is left unprovisioned (returns false).
   */
  async provision(conn: Row, opts: { bind?: boolean } = {}): Promise<boolean> {
    if (conn.lServerId) {
      if (opts.bind !== false && !conn.agentBound) await this.setBound(conn, true);
      return true;
    }
    if (!(await this.lLinked(conn.workspaceId))) return false;
    const minted = await mintProxyToken();
    const server = await this.lMcp.create(conn.workspaceId, {
      name: `kewy_conn_${conn.provider}_${conn.id.slice(-6)}`,
      description: `Kewy CRM connector (${conn.provider}) through the CRM proxy.`,
      url: connectorProxyUrl(conn.id),
      headers: { Authorization: `Bearer ${minted.token}` },
    });
    await this.prisma.connector.updateMany({
      where: { id: conn.id, workspaceId: conn.workspaceId },
      data: { lServerId: server.id, proxyTokenPrefix: minted.prefix, proxyTokenHash: minted.hash },
    });
    if (opts.bind !== false) {
      await this.lMcp.bind(conn.workspaceId, server.id);
      await this.prisma.connector.updateMany({ where: { id: conn.id, workspaceId: conn.workspaceId }, data: { agentBound: true } });
    }
    return true;
  }

  /** The agent switch. 409 connectors.agent_not_connected without an l link. */
  async setBound(conn: Row, bound: boolean): Promise<void> {
    if (!conn.lServerId) {
      if (!bound) {
        await this.prisma.connector.updateMany({ where: { id: conn.id, workspaceId: conn.workspaceId }, data: { agentBound: false } });
        return;
      }
      if (!(await this.provision(conn, { bind: true }))) throw connectorError("connectors.agent_not_connected");
      return;
    }
    if (bound) await this.lMcp.bind(conn.workspaceId, conn.lServerId);
    else await this.lMcp.unbind(conn.workspaceId, conn.lServerId);
    await this.prisma.connector.updateMany({ where: { id: conn.id, workspaceId: conn.workspaceId }, data: { agentBound: bound } });
  }

  /** Unbind + remove on l (best effort) and revoke the proxy token. */
  async remove(conn: Row): Promise<void> {
    if (conn.lServerId) {
      try {
        if (conn.agentBound) await this.lMcp.unbind(conn.workspaceId, conn.lServerId);
      } catch (e) {
        this.logger.warn(`l unbind failed for connector ${conn.id}: ${(e as Error).message}`);
      }
      try {
        await this.lMcp.remove(conn.workspaceId, conn.lServerId);
      } catch (e) {
        this.logger.warn(`l server removal failed for connector ${conn.id}: ${(e as Error).message}`);
      }
    }
    await this.prisma.connector.updateMany({
      where: { id: conn.id, workspaceId: conn.workspaceId },
      data: { lServerId: null, agentBound: false, proxyTokenPrefix: null, proxyTokenHash: null },
    });
  }
}
