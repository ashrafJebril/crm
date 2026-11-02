import { Controller, Get, HttpCode, Post } from "@nestjs/common";
import { CurrentUserId, CurrentWorkspace } from "../common/current-workspace.decorator";
import { HjzLinkService } from "./hjz-link.service";

/** The CRM end of the "Open HJZ" link (no second login). */
@Controller("hjz/link")
export class HjzLinkController {
  constructor(private readonly link: HjzLinkService) {}

  @Get()
  status(@CurrentWorkspace() workspaceId: string, @CurrentUserId() userId: string) {
    return this.link.status(workspaceId, userId);
  }

  /** A one-minute, single-use URL that opens HJZ signed in as this user. */
  @Post()
  @HttpCode(200)
  open(@CurrentWorkspace() workspaceId: string, @CurrentUserId() userId: string) {
    return this.link.ticketUrl(workspaceId, userId);
  }
}
