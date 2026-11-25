import { Module } from "@nestjs/common";
import { AppointmentsModule } from "../appointments/appointments.module";
import { BookingsModule } from "../bookings/bookings.module";
import { ContactsModule } from "../contacts/contacts.module";
import { IntegrationsModule } from "../integrations/integrations.module";
import { MediaModule } from "../media/media.module";
import { KnowledgeSourcesModule } from "../knowledge-sources/knowledge-sources.module";
import { SkillsModule } from "../skills/skills.module";
import { TicketsModule } from "../tickets/tickets.module";
import { TagsModule } from "../tags/tags.module";
import { McpAuthGuard } from "./mcp-auth.guard";
import { McpServerController } from "./mcp-server.controller";
import { McpToolsFactory } from "./mcp-tools.factory";

@Module({
  // SP-22: skills (enabled set, usage recorder), tickets and tags (the new tools).
  imports: [AppointmentsModule, BookingsModule, ContactsModule, IntegrationsModule, MediaModule, KnowledgeSourcesModule, SkillsModule, TicketsModule, TagsModule],
  controllers: [McpServerController],
  providers: [McpAuthGuard, McpToolsFactory],
  // SP-20: the "Try your agent" sandbox builds the same tools in sandbox mode.
  exports: [McpToolsFactory],
})
export class McpServerModule {}
