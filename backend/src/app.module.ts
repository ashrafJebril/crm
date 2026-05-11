import { Module } from "@nestjs/common";
import { PrismaModule } from "./prisma/prisma.module";
import { AuthModule } from "./auth/auth.module";
import { HealthModule } from "./health/health.module";
import { ContactsModule } from "./contacts/contacts.module";
import { ConversationsModule } from "./conversations/conversations.module";
import { AppointmentsModule } from "./appointments/appointments.module";
import { TemplatesModule } from "./templates/templates.module";
import { TeamModule } from "./team/team.module";
import { CampaignsModule } from "./campaigns/campaigns.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { IntegrationsModule } from "./integrations/integrations.module";
import { TicketsModule } from "./tickets/tickets.module";

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    HealthModule,
    ContactsModule,
    ConversationsModule,
    AppointmentsModule,
    TemplatesModule,
    TeamModule,
    CampaignsModule,
    DashboardModule,
    IntegrationsModule,
    TicketsModule,
  ],
})
export class AppModule {}
