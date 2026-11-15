import { Module } from "@nestjs/common";
import { AppointmentsModule } from "../appointments/appointments.module";
import { ContactsModule } from "../contacts/contacts.module";
import { IntegrationsModule } from "../integrations/integrations.module";
import { MediaModule } from "../media/media.module";
import { McpAuthGuard } from "./mcp-auth.guard";
import { McpServerController } from "./mcp-server.controller";
import { McpToolsFactory } from "./mcp-tools.factory";

@Module({
  imports: [AppointmentsModule, ContactsModule, IntegrationsModule, MediaModule],
  controllers: [McpServerController],
  providers: [McpAuthGuard, McpToolsFactory],
})
export class McpServerModule {}
