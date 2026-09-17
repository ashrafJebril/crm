import { Controller, Delete, ForbiddenException, Get, Post } from "@nestjs/common";
import { CurrentUserId, CurrentWorkspace } from "../common/current-workspace.decorator";
import { WorkspacesService } from "../workspaces/workspaces.service";
import { McpTokenService } from "./mcp-token.service";

@Controller("integrations/mcp/token")
export class McpTokenController {
  constructor(
    private readonly tokens: McpTokenService,
    private readonly workspaces: WorkspacesService,
  ) {}

  private async requireEditor(userId: string, workspaceId: string): Promise<void> {
    const role = await this.workspaces.requireMember(userId, workspaceId);
    if (role !== "owner" && role !== "admin") {
      throw new ForbiddenException("Only owner or admin can manage the MCP access token");
    }
  }

  @Get("status")
  status(@CurrentWorkspace() workspaceId: string) {
    return this.tokens.status(workspaceId);
  }

  @Post()
  async generate(@CurrentWorkspace() workspaceId: string, @CurrentUserId() userId: string) {
    await this.requireEditor(userId, workspaceId);
    return this.tokens.generate(workspaceId);
  }

  @Delete()
  async revoke(@CurrentWorkspace() workspaceId: string, @CurrentUserId() userId: string) {
    await this.requireEditor(userId, workspaceId);
    await this.tokens.revoke(workspaceId);
    return { ok: true };
  }
}
