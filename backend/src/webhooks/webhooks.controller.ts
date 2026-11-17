import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import type { JwtPayload } from "../auth/auth.guard";
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { actorOf } from "../permissions/permission.service";
import { WebhooksService } from "./webhooks.service";
import { CreateWebhookDto, UpdateWebhookDto } from "./webhooks.dto";

type AuthedReq = Request & { user: JwtPayload };

/** SP-27 outgoing webhooks (permissions in permission-map.ts: api_keys.*;
 *  create and rotate-secret are blocked for impersonators). */
@Controller("webhooks")
export class WebhooksController {
  constructor(private readonly hooks: WebhooksService) {}

  @Get()
  list(@CurrentWorkspace() ws: string) {
    return this.hooks.list(ws);
  }

  @Post()
  create(@CurrentWorkspace() ws: string, @Body() dto: CreateWebhookDto, @Req() req: AuthedReq) {
    return this.hooks.create(ws, actorOf(req.user), dto);
  }

  @Patch(":id")
  update(@CurrentWorkspace() ws: string, @Param("id") id: string, @Body() dto: UpdateWebhookDto, @Req() req: AuthedReq) {
    return this.hooks.update(ws, actorOf(req.user), id, dto);
  }

  @Delete(":id")
  remove(@CurrentWorkspace() ws: string, @Param("id") id: string, @Req() req: AuthedReq) {
    return this.hooks.remove(ws, actorOf(req.user), id);
  }

  @Post(":id/rotate-secret")
  rotate(@CurrentWorkspace() ws: string, @Param("id") id: string, @Req() req: AuthedReq) {
    return this.hooks.rotateSecret(ws, actorOf(req.user), id);
  }

  @Post(":id/test")
  test(@CurrentWorkspace() ws: string, @Param("id") id: string) {
    return this.hooks.test(ws, id);
  }

  @Get(":id/deliveries")
  deliveries(
    @CurrentWorkspace() ws: string,
    @Param("id") id: string,
    @Query("status") status?: string,
    @Query("cursor") cursor?: string,
  ) {
    return this.hooks.deliveries(ws, id, { status, cursor });
  }

  @Get(":id/deliveries/:deliveryId")
  delivery(@CurrentWorkspace() ws: string, @Param("id") id: string, @Param("deliveryId") deliveryId: string) {
    return this.hooks.delivery(ws, id, deliveryId);
  }

  @Post(":id/deliveries/:deliveryId/redeliver")
  redeliver(@CurrentWorkspace() ws: string, @Param("id") id: string, @Param("deliveryId") deliveryId: string) {
    return this.hooks.redeliver(ws, id, deliveryId);
  }
}
