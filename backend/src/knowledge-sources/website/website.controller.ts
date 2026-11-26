import { Body, Controller, Param, Patch, Post } from "@nestjs/common";
import { CurrentUserId, CurrentWorkspace } from "../../common/current-workspace.decorator";
import { CheckWebsiteDto, CreateWebsiteDto, PatchWebsiteDto } from "../knowledge-sources.dto";
import { WebsitesService } from "./websites.service";

/**
 * SP-21 website routes. Permissions (permission-map.ts): `check` and create
 * need `knowledge.create`; patch and refresh need `knowledge.update`.
 * `websites/check` is declared before the `:id` routes.
 */
@Controller("knowledge/websites")
export class WebsiteController {
  constructor(private readonly websites: WebsitesService) {}

  @Post("check")
  check(@CurrentWorkspace() ws: string, @Body() body: CheckWebsiteDto) {
    return this.websites.check(ws, body.url);
  }

  @Post()
  create(@CurrentWorkspace() ws: string, @CurrentUserId() userId: string, @Body() body: CreateWebsiteDto) {
    return this.websites.create(ws, userId, body);
  }

  @Patch(":id")
  patch(@CurrentWorkspace() ws: string, @Param("id") id: string, @Body() body: PatchWebsiteDto) {
    return this.websites.patch(ws, id, body);
  }

  @Post(":id/refresh")
  refresh(@CurrentWorkspace() ws: string, @Param("id") id: string) {
    return this.websites.refresh(ws, id);
  }
}
