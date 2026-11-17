import { Body, Controller, Delete, Get, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import type { JwtPayload } from "../auth/auth.guard";
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { actorOf } from "../permissions/permission.service";
import { ApiKeysService } from "./api-keys.service";
import { CreateApiKeyDto } from "./api-keys.dto";

type AuthedReq = Request & { user: JwtPayload };

/** SP-27 organization API keys (permissions in permission-map.ts: view,
 *  create, delete on api_keys; minting is blocked for impersonators). */
@Controller("api-keys")
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get()
  list(@CurrentWorkspace() ws: string) {
    return this.keys.list(ws);
  }

  @Post()
  create(@CurrentWorkspace() ws: string, @Body() dto: CreateApiKeyDto, @Req() req: AuthedReq) {
    return this.keys.create(ws, actorOf(req.user), dto);
  }

  @Delete(":id")
  revoke(@CurrentWorkspace() ws: string, @Param("id") id: string, @Req() req: AuthedReq) {
    return this.keys.revoke(ws, actorOf(req.user), id);
  }
}
