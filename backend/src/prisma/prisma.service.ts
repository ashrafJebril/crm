import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { tenancyExtension } from "../common/prisma-tenancy";

@Injectable()
export class PrismaService implements OnModuleDestroy {
  // Underlying base client. NEVER expose this in normal service code — it
  // bypasses tenancy scoping. Reserved for admin/cross-tenant operations
  // (super-admin portal, migration scripts hosted in-process).
  private readonly base = new PrismaClient();
  private readonly client = this.base.$extends(tenancyExtension);

  async onModuleDestroy(): Promise<void> {
    await this.base.$disconnect();
  }

  /** Unscoped Prisma client. Use ONLY in code that must read/write across
   *  tenants (super-admin endpoints). Regular services must use the model
   *  delegates below, which go through the tenancy extension. */
  get raw(): PrismaClient {
    return this.base;
  }

  // ─── Model delegates (tenant-scoped via extension) ────────────────────
  get user() { return this.client.user; }
  get workspace() { return this.client.workspace; }
  get workspaceMember() { return this.client.workspaceMember; }
  get role() { return this.client.role; }
  get importJob() { return this.client.importJob; }
  get activity() { return this.client.activity; }
  get contact() { return this.client.contact; }
  get conversation() { return this.client.conversation; }
  get conversationLabel() { return this.client.conversationLabel; }
  /** Not tenant-scoped: callers must verify conversation + label ownership first. */
  get conversationLabelLink() { return this.client.conversationLabelLink; }
  get notification() { return this.client.notification; }
  get notificationPreference() { return this.client.notificationPreference; }
  /** Not tenant-scoped (no workspaceId): callers must verify the note belongs to the workspace first. */
  get noteSeen() { return this.client.noteSeen; }
  get customFieldDef() { return this.client.customFieldDef; }
  /** Not tenant-scoped (no workspaceId): callers must verify contact + def ownership first. */
  get customFieldValue() { return this.client.customFieldValue; }
  get message() { return this.client.message; }
  get appointment() { return this.client.appointment; }
  get template() { return this.client.template; }
  get campaign() { return this.client.campaign; }
  get pipeline() { return this.client.pipeline; }
  get ticketStage() { return this.client.ticketStage; }
  get ticket() { return this.client.ticket; }
  get ticketActivity() { return this.client.ticketActivity; }
  get lostReason() { return this.client.lostReason; }
  get savedReply() { return this.client.savedReply; }
  get integration() { return this.client.integration; }
  get note() { return this.client.note; }
  get media() { return this.client.media; }
  get segment() { return this.client.segment; }
  get segmentMember() { return this.client.segmentMember; }
  get tag() { return this.client.tag; }
  get workflow() { return this.client.workflow; }
  get workflowRun() { return this.client.workflowRun; }
  get adsChatSession() { return this.client.adsChatSession; }
  get adsChatMessage() { return this.client.adsChatMessage; }
  get adsPendingAction() { return this.client.adsPendingAction; }
  get adsActionAudit() { return this.client.adsActionAudit; }
  get adsWallet() { return this.client.adsWallet; }
  get adsWalletTransaction() { return this.client.adsWalletTransaction; }

  get $transaction() { return this.client.$transaction.bind(this.client); }
  get $executeRaw() { return this.client.$executeRaw.bind(this.client); }
  get $executeRawUnsafe() { return this.client.$executeRawUnsafe.bind(this.client); }
  get $queryRawUnsafe() { return this.client.$queryRawUnsafe.bind(this.client); }
  get $queryRaw() { return this.client.$queryRaw.bind(this.client); }
}
