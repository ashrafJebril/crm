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
  get campaignRecipient() { return this.client.campaignRecipient; }
  get campaignBroadcast() { return this.client.campaignBroadcast; }
  get pipeline() { return this.client.pipeline; }
  get ticketStage() { return this.client.ticketStage; }
  get ticket() { return this.client.ticket; }
  get ticketActivity() { return this.client.ticketActivity; }
  /** SP-09: files linked to tickets. */
  get ticketAttachment() { return this.client.ticketAttachment; }
  get lostReason() { return this.client.lostReason; }
  get savedReply() { return this.client.savedReply; }
  get integration() { return this.client.integration; }
  get channel() { return this.client.channel; }
  get note() { return this.client.note; }
  get media() { return this.client.media; }
  get segment() { return this.client.segment; }
  get segmentMember() { return this.client.segmentMember; }
  get tag() { return this.client.tag; }
  get workflow() { return this.client.workflow; }
  get workflowRun() { return this.client.workflowRun; }
  /** SP-24: the lifecycle once-per-occurrence claim. */
  get lifecycleDelivery() { return this.client.lifecycleDelivery; }
  get adsChatSession() { return this.client.adsChatSession; }
  get adsChatMessage() { return this.client.adsChatMessage; }
  get adsPendingAction() { return this.client.adsPendingAction; }
  get adsActionAudit() { return this.client.adsActionAudit; }
  get adsWallet() { return this.client.adsWallet; }
  get adsWalletTransaction() { return this.client.adsWalletTransaction; }
  // SP-15: click-to-WhatsApp attribution and Meta Ads.
  get adSource() { return this.client.adSource; }
  get adReferral() { return this.client.adReferral; }
  get adSpendDaily() { return this.client.adSpendDaily; }
  get metaAdsConnection() { return this.client.metaAdsConnection; }
  get metaLead() { return this.client.metaLead; }
  // SP-10: the bookings catalog and catalog imports.
  get service() { return this.client.service; }
  get staffResource() { return this.client.staffResource; }
  get staffService() { return this.client.staffService; }
  get catalogImport() { return this.client.catalogImport; }
  // SP-21: agent knowledge.
  get knowledgeSource() { return this.client.knowledgeSource; }
  get knowledgePage() { return this.client.knowledgePage; }
  get knowledgeChunk() { return this.client.knowledgeChunk; }
  // SP-20: agent configuration and sandbox threads.
  get agentSettings() { return this.client.agentSettings; }
  get agentSandboxThread() { return this.client.agentSandboxThread; }
  // SP-18: the in-app copilot.
  get copilotSession() { return this.client.copilotSession; }
  get copilotMessage() { return this.client.copilotMessage; }
  get copilotPendingAction() { return this.client.copilotPendingAction; }
  get copilotAttachment() { return this.client.copilotAttachment; }
  get copilotActionAudit() { return this.client.copilotActionAudit; }

  // SP-26: not tenant-scoped on purpose. Invitations are read and accepted
  // from outside their workspace (public accept, the invitee's own list) and
  // audit rows are written for the invited workspace while the request's
  // context is another one, so every query names workspaceId explicitly.
  // PasswordReset has no workspaceId.
  get invitation() { return this.client.invitation; }
  get auditLog() { return this.client.auditLog; }
  get passwordReset() { return this.client.passwordReset; }

  // SP-22: the skills ledger and the agent's tool-call log (tenant-scoped).
  get skillInstall() { return this.client.skillInstall; }
  get agentToolCall() { return this.client.agentToolCall; }
  // SP-23: connectors (tenant-scoped; the proxy and the schedulers run
  // without a context and name workspaceId or a unique key explicitly).
  get connector() { return this.client.connector; }
  get connectorCall() { return this.client.connectorCall; }
  get connectorSyncLink() { return this.client.connectorSyncLink; }
  get connectorSyncRun() { return this.client.connectorSyncRun; }
  // SP-27: in the tenancy list (defence in depth). AuthGuard's lookup by hash
  // is a findUnique before any workspace context exists; every other query
  // names workspaceId explicitly.
  get apiKey() { return this.client.apiKey; }
  get webhookEndpoint() { return this.client.webhookEndpoint; }
  get webhookDelivery() { return this.client.webhookDelivery; }

  get $transaction() { return this.client.$transaction.bind(this.client); }
  get $executeRaw() { return this.client.$executeRaw.bind(this.client); }
  get $executeRawUnsafe() { return this.client.$executeRawUnsafe.bind(this.client); }
  get $queryRawUnsafe() { return this.client.$queryRawUnsafe.bind(this.client); }
  get $queryRaw() { return this.client.$queryRaw.bind(this.client); }
}
