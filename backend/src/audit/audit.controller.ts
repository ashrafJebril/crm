import { Controller, Get, Param, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import type { JwtPayload } from "../auth/auth.guard";
import { assertJwtWorkspace } from "../members/jwt-workspace";
import { AuditService, type AuditQuery } from "./audit.service";

/** GET /workspaces/:id/audit (members.manage, ruling 8). PermissionGuard has
 *  checked the permission against the JWT workspace; any other :id is 404. */
@Controller("workspaces/:id/audit")
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Param("id") id: string, @Query() q: AuditQuery, @Req() req: Request & { user: JwtPayload }) {
    assertJwtWorkspace(id, req.user);
    return this.audit.list(id, {
      cursor: typeof q.cursor === "string" ? q.cursor : undefined,
      action: typeof q.action === "string" ? q.action : undefined,
      actorId: typeof q.actorId === "string" ? q.actorId : undefined,
      from: typeof q.from === "string" ? q.from : undefined,
      to: typeof q.to === "string" ? q.to : undefined,
    });
  }
}
