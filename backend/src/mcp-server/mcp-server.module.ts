import { Module } from "@nestjs/common";
import { AppointmentsModule } from "../appointments/appointments.module";
import { BookingsModule } from "../bookings/bookings.module";
import { ContactsModule } from "../contacts/contacts.module";
import { IntegrationsModule } from "../integrations/integrations.module";
import { MediaModule } from "../media/media.module";
import { KnowledgeSourcesModule } from "../knowledge-sources/knowledge-sources.module";
import { McpAuthGuard } from "./mcp-auth.guard";
import { McpServerController } from "./mcp-server.controller";
import { McpToolsFactory } from "./mcp-tools.factory";

@Module({
  imports: [AppointmentsModule, BookingsModule, ContactsModule, IntegrationsModule, MediaModule, KnowledgeSourcesModule],
  controllers: [McpServerController],
  providers: [McpAuthGuard, McpToolsFactory],
})
export class McpServerModule {}
