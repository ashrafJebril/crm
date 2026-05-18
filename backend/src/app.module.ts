import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { WorkspaceInterceptor } from "./common/workspace.interceptor";
import { ScheduleModule } from "@nestjs/schedule";
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
import { MentionsModule } from "./mentions/mentions.module";
import { WorkspacesModule } from "./workspaces/workspaces.module";
import { NotesModule } from "./notes/notes.module";
import { MediaModule } from "./media/media.module";
import { SocialModule } from "./social/social.module";
import { ScheduledPostsModule } from "./scheduled-posts/scheduled-posts.module";
import { AdminModule } from "./admin/admin.module";
import { OpenAiModule } from "./openai/openai.module";
import { KnowledgeModule } from "./knowledge/knowledge.module";
import { AiModule } from "./ai/ai.module";

@Module({
  imports: [
    ScheduleModule.forRoot(),
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
    MentionsModule,
    WorkspacesModule,
    NotesModule,
    MediaModule,
    SocialModule,
    ScheduledPostsModule,
    AdminModule,
    OpenAiModule,
    KnowledgeModule,
    AiModule,
  ],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: WorkspaceInterceptor },
  ],
})
export class AppModule {}
