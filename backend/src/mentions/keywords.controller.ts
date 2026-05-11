import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import { KeywordsService } from "./keywords.service";
import { CreateKeywordDto, UpdateKeywordDto } from "./keywords.dto";
import { CurrentWorkspace } from "../common/current-workspace.decorator";

@Controller("keywords")
export class KeywordsController {
  constructor(private readonly svc: KeywordsService) {}

  @Get()
  list(@CurrentWorkspace() workspaceId: string) {
    return this.svc.list(workspaceId);
  }

  @Post()
  create(@CurrentWorkspace() workspaceId: string, @Body() dto: CreateKeywordDto) {
    return this.svc.create(workspaceId, dto);
  }

  @Patch(":id")
  update(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: UpdateKeywordDto,
  ) {
    return this.svc.update(workspaceId, id, dto);
  }

  @Delete(":id")
  remove(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.remove(workspaceId, id);
  }
}
