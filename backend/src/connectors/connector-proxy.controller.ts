import { Body, Controller, Headers, HttpCode, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { Public } from "../auth/public.decorator";
import { ConnectorProxyGuard, type ProxyRequest } from "./connector-proxy.guard";
import { ConnectorProxyRpc, type ProxyConnector } from "./connector-proxy.rpc";

/**
 * SP-23: the MCP endpoint l calls for one connector (`POST
 * /api/mcp/connectors/:connectorId`, public + ConnectorProxyGuard).
 * `X-Dry-Run: 1` (SP-20 sandbox) refuses write tools.
 */
@Controller("mcp/connectors")
export class ConnectorProxyController {
  constructor(private readonly rpc: ConnectorProxyRpc) {}

  @Public()
  @UseGuards(ConnectorProxyGuard)
  @Post(":connectorId")
  @HttpCode(200)
  async handle(
    @Param("connectorId") _connectorId: string,
    @Body() body: unknown,
    @Headers("x-dry-run") dryRun: string | undefined,
    @Req() req: ProxyRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const out = await this.rpc.handle(req.connector as unknown as ProxyConnector, body, { dryRun: dryRun === "1" });
    if (out === null) {
      res.status(202);
      return undefined;
    }
    return out;
  }
}
