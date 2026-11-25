import { Controller, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { MCPServer } from "@mastra/mcp";
import { Public } from "../auth/public.decorator";
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { McpAuthGuard } from "./mcp-auth.guard";
import { McpToolsFactory } from "./mcp-tools.factory";
import { SkillsService } from "../skills/skills.service";
import { isDryRun, L_DRY_RUN_HEADER } from "../common/dry-run";

@Controller()
export class McpServerController {
  constructor(
    private readonly toolsFactory: McpToolsFactory,
    private readonly skills: SkillsService,
  ) {}

  // @Public() bypasses the global per-user AuthGuard; McpAuthGuard is this
  // route's own authentication (a per-workspace bearer token, see Task 6).
  @Public()
  @UseGuards(McpAuthGuard)
  @Post("mcp/v1")
  async handle(@Req() req: Request, @Res() res: Response, @CurrentWorkspace() workspaceId: string): Promise<void> {
    // A test turn from l (`dry_run`, the "Try your agent" panel) gets the
    // sandbox tools: reads run, every write returns a "NOT saved" mock, and
    // nothing is written to the usage log.
    const mode = isDryRun(req.headers[L_DRY_RUN_HEADER]) ? "sandbox" : "live";
    const server = new MCPServer({
      name: "tkana-crm",
      version: "1.0.0",
      // SP-22: only the tools of this workspace's enabled skills (one indexed query).
      tools: this.toolsFactory.build(workspaceId, { mode, enabled: await this.skills.enabledFor(workspaceId) }),
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
