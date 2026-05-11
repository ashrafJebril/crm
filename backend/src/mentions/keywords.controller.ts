import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import { KeywordsService } from "./keywords.service";
import { CreateKeywordDto, UpdateKeywordDto } from "./keywords.dto";

@Controller("keywords")
export class KeywordsController {
  constructor(private readonly svc: KeywordsService) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Post()
  create(@Body() dto: CreateKeywordDto) {
    return this.svc.create(dto);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdateKeywordDto) {
    return this.svc.update(id, dto);
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.svc.remove(id);
  }
}
