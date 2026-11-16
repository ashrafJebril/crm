import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { WorkspaceInterceptor } from "./common/workspace.interceptor";
import { ScheduleModule } from "@nestjs/schedule";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { BillingModule } from "./billing/billing.module";
import { PrismaModule } from "./prisma/prisma.module";
import { KewyIdentityModule } from "./kewy-identity/kewy-identity.module";
import { AuthModule } from "./auth/auth.module";
import { HealthModule } from "./health/health.module";
import { ContactsModule } from "./contacts/contacts.module";
import { ImportsModule } from "./imports/imports.module";
import { ActivitiesModule } from "./activities/activities.module";
import { ConversationsModule } from "./conversations/conversations.module";
import { AppointmentsModule } from "./appointments/appointments.module";
import { TemplatesModule } from "./templates/templates.module";
import { TeamModule } from "./team/team.module";
import { CampaignsModule } from "./campaigns/campaigns.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { InsightsModule } from "./insights/insights.module";
import { HomeModule } from "./home/home.module";
import { IntegrationsModule } from "./integrations/integrations.module";
import { ChannelsCoreModule } from "./channels/channels-core.module";
import { ChannelsModule } from "./channels/channels.module";
import { TicketsModule } from "./tickets/tickets.module";
import { PipelinesModule } from "./pipelines/pipelines.module";
import { ResolutionModule } from "./resolution/resolution.module";
import { WorkspacesModule } from "./workspaces/workspaces.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { NotesModule } from "./notes/notes.module";
import { RecordsModule } from "./records/records.module";
import { MediaModule } from "./media/media.module";
import { SocialModule } from "./social/social.module";
import { AdminModule } from "./admin/admin.module";
import { JoteckModule } from "./joteck/joteck.module";
import { RealtimeModule } from "./realtime/realtime.module";
import { SearchModule } from "./search/search.module";
import { SegmentsModule } from "./segments/segments.module";
import { TagsModule } from "./tags/tags.module";
import { SavedRepliesModule } from "./saved-replies/saved-replies.module";
import { WorkflowsModule } from "./workflows/workflows.module";
import { McpServerModule } from "./mcp-server/mcp-server.module";
import { AdsModule } from "./ads/ads.module";
import { MetaAdsModule } from "./meta-ads/meta-ads.module";
import { KnowledgeModule } from "./knowledge/knowledge.module";
import { CustomFieldsModule } from "./custom-fields/custom-fields.module";
import { PermissionsModule } from "./permissions/permissions.module";
import { RolesModule } from "./roles/roles.module";
import { ServicesModule } from "./services/services.module";
import { StaffModule } from "./staff/staff.module";
import { BookingsModule } from "./bookings/bookings.module";
import { CatalogImportModule } from "./catalog-import/catalog-import.module";

@Module({
  imports: [
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),
    PrismaModule,
    KewyIdentityModule,
    BillingModule,
    AuthModule,
    // PermissionGuard is an APP_GUARD registered in AuthModule (after AuthGuard).
    PermissionsModule,
    RolesModule,
    HealthModule,
    SegmentsModule,
    TagsModule,
    SavedRepliesModule,
    ContactsModule,
    ImportsModule,
    ActivitiesModule,
    ConversationsModule,
    AppointmentsModule,
    // SP-10: the bookings catalog.
    ServicesModule,
    StaffModule,
    BookingsModule,
    CatalogImportModule,
    TemplatesModule,
    TeamModule,
    CampaignsModule,
    DashboardModule,
    // SP-11: support insights (sales and the working home join later).
    InsightsModule,
    // SP-11: the working home (Task 3).
    HomeModule,
    // SP-19: global routing core (resolver, transports, inbound sink) before
    // anything that sends or receives, then the /channels hub.
    ChannelsCoreModule,
    IntegrationsModule,
    ChannelsModule,
    McpServerModule,
    TicketsModule,
    PipelinesModule,
    ResolutionModule,
    WorkflowsModule,
    WorkspacesModule,
    NotesModule,
    RecordsModule,
    NotificationsModule,
    MediaModule,
    SocialModule,
    AdminModule,
    JoteckModule,
    RealtimeModule,
    SearchModule,
    AdsModule,
    MetaAdsModule,
    KnowledgeModule,
    CustomFieldsModule,
  ],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: WorkspaceInterceptor },
  ],
})
export class AppModule {}
