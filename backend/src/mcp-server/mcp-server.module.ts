import { Module } from "@nestjs/common";
import { AppointmentsModule } from "../appointments/appointments.module";
import { ContactsModule } from "../contacts/contacts.module";
import { IntegrationsModule } from "../integrations/integrations.module";
import { McpAuthGuard } from "./mcp-auth.guard";
import { McpServerController } from "./mcp-server.controller";
import { McpToolsFactory } from "./mcp-tools.factory";

@Module({
  imports: [AppointmentsModule, ContactsModule, IntegrationsModule],
  controllers: [McpServerController],
  providers: [McpAuthGuard, McpToolsFactory],
})
export class McpServerModule {}
