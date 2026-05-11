import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { ConversationsService } from "./conversations.service";
import {
  CreateConversationDto,
  CreateMessageDto,
  UpdateConversationDto,
} from "./conversations.dto";

@Controller("conversations")
export class ConversationsController {
  constructor(private readonly svc: ConversationsService) {}

  @Get() list() { return this.svc.list(); }
  @Get(":id") get(@Param("id") id: string) { return this.svc.get(id); }
  @Post() create(@Body() dto: CreateConversationDto) { return this.svc.create(dto); }
  @Patch(":id") update(@Param("id") id: string, @Body() dto: UpdateConversationDto) {
    return this.svc.update(id, dto);
  }
  @Post(":id/read") markRead(@Param("id") id: string) {
    return this.svc.markRead(id);
  }
  @Delete(":id") remove(@Param("id") id: string) { return this.svc.remove(id); }

  // Messages
  @Get(":id/messages") messages(@Param("id") id: string) {
    return this.svc.listMessages(id);
  }
  @Post(":id/messages") send(@Param("id") id: string, @Body() dto: CreateMessageDto) {
    return this.svc.addMessage(id, dto);
  }
}
