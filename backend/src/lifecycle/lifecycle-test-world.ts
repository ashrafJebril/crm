/**
 * SP-24 spec helper (not a runtime file): the real lifecycle service,
 * workflow engine (dispatch, runner, executors), booking writer, tickets
 * service and reminder scheduler over the in-memory Prisma double. Providers
 * (Zernio, Meta, the template submit) are fakes that record calls; nothing
 * leaves the process.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { makeFakePrisma } from "../channels/test-prisma";
import { ChannelResolver } from "../channels/channel-resolver.service";
import { PermissionService } from "../permissions/permission.service";
import { WorkflowRunnerService } from "../workflows/workflow-runner.service";
import { WorkflowDispatchService } from "../workflows/workflow-dispatch.service";
import { WorkflowsService } from "../workflows/workflows.service";
import { SendWhatsappTemplateExecutor } from "../workflows/executors/send-whatsapp-template.executor";
import { NotifyStaffExecutor } from "../workflows/executors/notify-staff.executor";
import { BookingWriter } from "../bookings/booking-writer";
import { TicketsService } from "../tickets/tickets.service";
import { LifecycleService } from "./lifecycle.service";
import { LifecycleReminderScheduler } from "./lifecycle-reminder.scheduler";

export const A = "wsA";
export const B = "wsB";

export function lifecycleWorld(opts: { withWhatsapp?: boolean } = {}) {
  const prisma = makeFakePrisma({
    workspace: [
      { id: A, name: "Acme Salon", timezone: "Asia/Riyadh", lang: "ar" },
      { id: B, name: "Other", timezone: "Europe/London", lang: "en" },
    ],
    user: [
      { id: "uOwner", name: "Owner" },
      { id: "uAdmin", name: "Admin" },
      { id: "uAssigned", name: "Assigned agent" },
      { id: "uNoTickets", name: "No tickets" },
      { id: "uB", name: "B owner" },
    ],
    role: [
      { id: "rAssigned", workspaceId: A, key: null, isSystem: false, name: "Assigned", nameAr: "Assigned", permissions: { tickets: ["view"], conversations: ["view"] }, conversationVisibility: "assigned" },
      { id: "rNoTickets", workspaceId: A, key: null, isSystem: false, name: "NoTickets", nameAr: "NoTickets", permissions: { conversations: ["view"] }, conversationVisibility: "all" },
    ],
    workspaceMember: [
      { id: "m1", workspaceId: A, userId: "uOwner", role: "owner", roleId: null },
      { id: "m2", workspaceId: A, userId: "uAdmin", role: "admin", roleId: null },
      { id: "m3", workspaceId: A, userId: "uAssigned", role: "custom", roleId: "rAssigned" },
      { id: "m4", workspaceId: A, userId: "uNoTickets", role: "custom", roleId: "rNoTickets" },
      { id: "m5", workspaceId: B, userId: "uB", role: "owner", roleId: null },
    ],
    channel:
      opts.withWhatsapp === false
        ? []
        : [
            { id: "chA", workspaceId: A, kind: "whatsapp", provider: "zernio", externalId: "acc-A", displayName: "Main", status: "active", isDefault: true, integrationId: null },
            { id: "chB", workspaceId: A, kind: "whatsapp", provider: "zernio", externalId: "acc-B", displayName: "Second", status: "active", isDefault: false, integrationId: null },
          ],
    contact: [
      { id: "cAr", workspaceId: A, name: "ليلى أحمد", firstName: "ليلى", phone: "+966500000001", marketingOptOut: false },
      { id: "cEn", workspaceId: A, name: "Omar Ali", firstName: null, phone: "+966500000002", marketingOptOut: false },
      { id: "cOut", workspaceId: A, name: "Opted Out", firstName: null, phone: "+966500000003", marketingOptOut: true },
      { id: "cSecond", workspaceId: A, name: "Second Number", firstName: null, phone: "+966500000004", marketingOptOut: false },
    ],
    conversation: [
      { id: "convAr", workspaceId: A, contactId: "cAr", channel: "whatsapp", channelId: "chA", assigneeId: null, updatedAt: new Date("2026-11-01") },
      { id: "convEn", workspaceId: A, contactId: "cEn", channel: "whatsapp", channelId: "chA", assigneeId: null, updatedAt: new Date("2026-11-01") },
      { id: "convOut", workspaceId: A, contactId: "cOut", channel: "whatsapp", channelId: "chA", assigneeId: null, updatedAt: new Date("2026-11-01") },
      { id: "convSecond", workspaceId: A, contactId: "cSecond", channel: "whatsapp", channelId: "chB", assigneeId: null, updatedAt: new Date("2026-11-01") },
    ],
    message: [
      { id: "mAr", workspaceId: A, conversationId: "convAr", from: "them", body: "مرحبا، أريد موعدًا", createdAt: new Date("2026-11-01T10:00:00Z") },
      { id: "mEn", workspaceId: A, conversationId: "convEn", from: "them", body: "Hi, I'd like to book", createdAt: new Date("2026-11-01T10:00:00Z") },
      { id: "mOut", workspaceId: A, conversationId: "convOut", from: "them", body: "Hello", createdAt: new Date("2026-11-01T10:00:00Z") },
    ],
    template: [],
    workflow: [],
    workflowRun: [],
    lifecycleDelivery: [],
    appointment: [],
    pipeline: [
      { id: "plSupport", workspaceId: A, key: "support", name: "Support", nameAr: "الدعم", kind: "support", archivedAt: null, assignsConversations: false, agentCanMove: true },
      { id: "plLeads", workspaceId: A, key: "leads", name: "Leads", nameAr: "Leads", kind: "leads", archivedAt: null, assignsConversations: false, agentCanMove: true },
    ],
    ticketStage: [
      { id: "stOpen", workspaceId: A, pipelineId: "plSupport", key: "open", label: "Open", labelAr: "Open", order: 0, isTerminal: false, isWon: false, slaMinutes: null },
      { id: "stResolved", workspaceId: A, pipelineId: "plSupport", key: "resolved", label: "Resolved", labelAr: "Resolved", order: 2, isTerminal: true, isWon: true, slaMinutes: null },
      { id: "stDismissed", workspaceId: A, pipelineId: "plSupport", key: "dismissed", label: "Dismissed", labelAr: "Dismissed", order: 3, isTerminal: true, isWon: false, slaMinutes: null },
      { id: "stNew", workspaceId: A, pipelineId: "plLeads", key: "new", label: "New", labelAr: "New", order: 0, isTerminal: false, isWon: false, slaMinutes: null },
    ],
    ticket: [],
    ticketActivity: [],
    notification: [],
    notificationPreference: [],
  });

  const locked = { value: false };
  const paymentLock = { isLocked: jest.fn(async () => locked.value) };
  const sends: { conversationId: string; name: string; language: string; variables: string[] }[] = [];
  const zernio = {
    sends,
    sendTemplateInDbConversation: jest.fn(async (_ws: string, conversationId: string, name: string, language: string, variables: string[]) => {
      sends.push({ conversationId, name, language, variables });
      return { ok: true, id: `z${sends.length}` };
    }),
  };
  const meta = { sendTemplateInConversation: jest.fn(async () => ({ wamid: "w1" })) };
  const sent: { userIds: string[]; n: any }[] = [];
  const notifications = {
    sent,
    notify: jest.fn(async (_ws: string, userIds: string[], n: any) => {
      sent.push({ userIds: [...userIds].sort(), n });
      return userIds.length;
    }),
  };
  const perm = new PermissionService(prisma as any);
  const channels = new ChannelResolver(prisma as any);
  const templateExec = new SendWhatsappTemplateExecutor(prisma as any, zernio as any, meta as any, channels);
  const notifyExec = new NotifyStaffExecutor(prisma as any, perm, notifications as any);
  const stub = { execute: jest.fn(async () => ({ ok: true })) };
  const runner = new WorkflowRunnerService(prisma as any, stub as any, stub as any, stub as any, paymentLock as any, templateExec, notifyExec);
  const dispatch = new WorkflowDispatchService(prisma as any, runner, paymentLock as any);
  const workflows = new WorkflowsService(prisma as any, dispatch, perm);

  // The template submit: records the payload; the row starts in review.
  const created: any[] = [];
  const templates = {
    created,
    create: jest.fn(async (ws: string, input: any): Promise<any> => {
      created.push({ ws, ...input });
      return prisma.template.create({
        data: { workspaceId: ws, name: input.name, lang: input.lang, category: input.category, status: "pending", body: input.body, footer: input.footer, metaRejectionReason: null, quality: null },
      });
    }),
    list: jest.fn(async (ws: string) => prisma.template.findMany({ where: { workspaceId: ws } })),
  };
  const lifecycle = new LifecycleService(prisma as any, workflows, templates as any);

  // Trigger events dispatch for real; `flush()` waits for them.
  const pending: Promise<unknown>[] = [];
  const events = { emit: jest.fn((_name: string, evt: any) => pending.push(dispatch.handleTrigger(evt))) };
  const flush = async () => {
    while (pending.length) await pending.shift();
  };
  const bookings = new BookingWriter(prisma as any, undefined, events as any);
  const tickets = new TicketsService(prisma as any, { emitToWorkspace: jest.fn() } as any, events as any);
  const scheduler = new LifecycleReminderScheduler(prisma as any, dispatch, paymentLock as any);

  /** Marks a template's live status (what the reconcile would write). */
  const setStatus = (name: string, status: string, reason: string | null = null) => {
    const t = (prisma.db.template as any[]).find((x) => x.name === name);
    if (!t) throw new Error(`no template ${name}`);
    t.status = status;
    t.metaRejectionReason = reason;
  };
  const approveAll = () => (prisma.db.template as any[]).forEach((t) => (t.status = "approved"));
  const runs = () => prisma.db.workflowRun as any[];

  return {
    prisma,
    db: prisma.db as Record<string, any[]>,
    locked,
    paymentLock,
    zernio,
    meta,
    notifications,
    perm,
    runner,
    dispatch,
    workflows,
    templates,
    lifecycle,
    events,
    flush,
    bookings,
    tickets,
    scheduler,
    setStatus,
    approveAll,
    runs,
  };
}

/** The body of a thrown HttpException. */
export async function failure(p: Promise<unknown>): Promise<{ status: number; body: any }> {
  try {
    await p;
  } catch (e: any) {
    if (typeof e?.getStatus === "function") return { status: e.getStatus(), body: e.getResponse() };
    throw e;
  }
  throw new Error("expected a rejection");
}

/** A legacy-shaped booking (no catalog ids, no resource: never gated). */
export const bookingInput = (over: Record<string, unknown> = {}): any => ({
  contactId: "cAr",
  service: "Haircut",
  serviceAr: "قص شعر",
  startAt: "2027-01-05T07:30:00.000Z",
  durationMin: 60,
  status: "confirmed",
  source: "human",
  ...over,
});
