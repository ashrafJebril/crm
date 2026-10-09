import { Controller, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { MCPServer } from "@mastra/mcp";
import { Public } from "../auth/public.decorator";
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { McpAuthGuard } from "./mcp-auth.guard";
import { McpToolsFactory } from "./mcp-tools.factory";

@Controller()
export class McpServerController {
  constructor(private readonly toolsFactory: McpToolsFactory) {}

  // @Public() bypasses the global per-user AuthGuard; McpAuthGuard is this
  // route's own authentication (a per-workspace bearer token, see Task 6).
  @Public()
  @UseGuards(McpAuthGuard)
  @Post("mcp/v1")
  async handle(@Req() req: Request, @Res() res: Response, @CurrentWorkspace() workspaceId: string): Promise<void> {
    const server = new MCPServer({
      name: "tkana-crm",
      version: "1.0.0",
      tools: this.toolsFactory.build(workspaceId),
    });
    // serverless:true — a fresh MCPServer is built per request (see above),
    // so there is no shared session-transport map across requests for a
    // sessionIdGenerator's ids to ever be resolved against.
    const url = new URL(req.url ?? "", `${req.protocol}://${req.get("host")}`);
    await server.startHTTP({
      url,
      httpPath: url.pathname,
      req,
      res,
      options: { serverless: true },
    });
  }
}
