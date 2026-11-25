import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { RealtimeModule } from "../realtime/realtime.module";
import { HandoverService } from "./handover.service";
import { InvitationsController } from "./invitations.controller";
import { InvitationsService } from "./invitations.service";

/**
 * SP-26 members: email invitations and handover on removal. Prisma,
 * permissions, Kewy sync, email and audit come from @Global modules.
 * WorkspacesModule imports this (DELETE …/members, open-work, handover);
 * AuthModule imports it for the invitee's routes and registers
 * PublicInvitationsController (it needs AuthService to issue the session).
 */
@Module({
  imports: [NotificationsModule, RealtimeModule],
  controllers: [InvitationsController],
  providers: [InvitationsService, HandoverService],
  exports: [InvitationsService, HandoverService],
})
export class MembersModule {}
