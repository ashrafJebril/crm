import { ForbiddenException, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionService, type Actor } from "../permissions/permission.service";
import { isEffectiveOwner } from "../permissions/member-role";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import { RealtimeService } from "../realtime/realtime.service";
import { memberError } from "./member-errors";
import { assertAnotherOwner, findWorkspaceMember, serializable } from "./member-guards";

/** Open work a member holds (ruling 7). `total` excludes bookings, which are
 *  shown but never moved (staff assignment needs a schedule fit). */
export interface OpenWorkDto {
  conversations: number;
  tickets: { deals: number; leads: number; support: number };
  followUps: number;
  contacts: number;
  bookings: number;
  total: number;
}

export interface HandoverRefusal {
  reason: "not_member" | "same_user" | "missing_permission";
  resource?: "conversations" | "tickets" | "contacts";
}

type Tx = Parameters<Parameters<PrismaService["$transaction"]>[0]>[0];
type Db = Tx | PrismaService;

/** Conversation statuses that are finished: anything else is open work. */
const CLOSED_CONVERSATION = ["resolved", "closed", "spam"];
/** Upcoming bookings that still need their staff member. */
const LIVE_BOOKING = ["confirmed", "pending"];

const ZERO: OpenWorkDto = { conversations: 0, tickets: { deals: 0, leads: 0, support: 0 }, followUps: 0, contacts: 0, bookings: 0, total: 0 };

/**
 * SP-26 handover (Review Focus 2): removing a member never orphans work.
 * Open conversations, tickets, follow-ups and owned contacts move to one
 * recipient in the same Serializable transaction as the delete; nothing moves
 * when the delete is refused, and a recipient without the needed permission
 * is refused, never silently skipped.
 */
@Injectable()
export class HandoverService {
  private readonly logger = new Logger(HandoverService.name);
  /** Injectable clock for specs. */
  now: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Counts of the member's open work in this workspace. */
  async openWork(db: Db, workspaceId: string, userId: string): Promise<OpenWorkDto> {
    const openTicket = { workspaceId, ownerId: userId, closedAt: null };
    const [conversations, deals, leads, support, followUps, contacts, bookings] = await Promise.all([
      db.conversation.count({ where: { workspaceId, assigneeId: userId, status: { notIn: CLOSED_CONVERSATION } } }),
      db.ticket.count({ where: { ...openTicket, pipeline: { kind: { notIn: ["leads", "support"] } } } }),
      db.ticket.count({ where: { ...openTicket, pipeline: { kind: "leads" } } }),
      db.ticket.count({ where: { ...openTicket, pipeline: { kind: "support" } } }),
      db.activity.count({ where: { workspaceId, assigneeId: userId, doneAt: null } }),
      db.contact.count({ where: { workspaceId, ownerId: userId } }),
      db.appointment.count({ where: { workspaceId, staffId: userId, startAt: { gte: this.now() }, status: { in: LIVE_BOOKING } } }),
    ]);
    const total = conversations + deals + leads + support + followUps + contacts;
    return { conversations, tickets: { deals, leads, support }, followUps, contacts, bookings, total };
  }

  /** Why `toUserId` cannot take `work` from `fromUserId`, or null when it can. */
  async canReceive(workspaceId: string, fromUserId: string, toUserId: string, work: OpenWorkDto): Promise<HandoverRefusal | null> {
    if (toUserId === fromUserId) return { reason: "same_user" };
    const eff = await this.permissions.effective(workspaceId, toUserId);
    if (!eff) return { reason: "not_member" };
    const ticketCount = work.tickets.deals + work.tickets.leads + work.tickets.support;
    const needs: Array<[number, "conversations" | "tickets" | "contacts"]> = [
      [work.conversations, "conversations"],
      [ticketCount, "tickets"],
      [work.contacts + work.followUps, "contacts"],
    ];
    for (const [count, resource] of needs) {
      if (count > 0 && !this.permissions.can(eff, `${resource}.update`)) return { reason: "missing_permission", resource };
    }
    return null;
  }

  /** Moves every open kind from one member to another inside `tx`. Closed
   *  work stays. Conversations keep their updatedAt (inbox order) and bump
   *  their version, as an assignment does. */
  async handOver(tx: Tx, workspaceId: string, fromUserId: string, toUserId: string, work: OpenWorkDto): Promise<OpenWorkDto> {
    const convs = await tx.conversation.findMany({
      where: { workspaceId, assigneeId: fromUserId, status: { notIn: CLOSED_CONVERSATION } },
      select: { id: true, updatedAt: true },
    });
    let conversations = 0;
    for (const c of convs) {
      const res = await tx.conversation.updateMany({
        where: { id: c.id, workspaceId, assigneeId: fromUserId },
        data: { assigneeId: toUserId, version: { increment: 1 }, updatedAt: c.updatedAt },
      });
      conversations += res.count;
    }
    const tickets = await tx.ticket.updateMany({
      where: { workspaceId, ownerId: fromUserId, closedAt: null },
      data: { ownerId: toUserId },
    });
    const followUps = await tx.activity.updateMany({
      where: { workspaceId, assigneeId: fromUserId, doneAt: null },
      data: { assigneeId: toUserId },
    });
    const contacts = await tx.contact.updateMany({
      where: { workspaceId, ownerId: fromUserId },
      data: { ownerId: toUserId },
    });
    // Ticket kinds come from the count taken in this same transaction.
    const ticketSplit = tickets.count === work.tickets.deals + work.tickets.leads + work.tickets.support ? work.tickets : { deals: tickets.count, leads: 0, support: 0 };
    return {
      conversations,
      tickets: ticketSplit,
      followUps: followUps.count,
      contacts: contacts.count,
      bookings: 0,
      total: conversations + tickets.count + followUps.count + contacts.count,
    };
  }

  /** GET …/members/:userId/open-work[?handoverTo]. */
  async openWorkFor(workspaceId: string, userId: string, handoverTo?: string): Promise<OpenWorkDto & { refusal?: HandoverRefusal }> {
    await findWorkspaceMember(this.prisma, workspaceId, userId);
    const work = await this.openWork(this.prisma, workspaceId, userId);
    if (!handoverTo) return work;
    const refusal = await this.canReceive(workspaceId, userId, handoverTo, work);
    return refusal ? { ...work, refusal } : work;
  }

  /** POST …/members/:userId/handover: move the open work, keep the member. */
  async handOverOnly(workspaceId: string, userId: string, handoverTo: string, actor: Actor): Promise<{ moved: OpenWorkDto }> {
    const moved = await serializable(() =>
      this.prisma.$transaction(
        async (tx) => {
          await findWorkspaceMember(tx, workspaceId, userId);
          await this.permissions.assertCanActOn(workspaceId, actor, userId);
          const work = await this.openWork(tx, workspaceId, userId);
          const refusal = await this.canReceive(workspaceId, userId, handoverTo, work);
          if (refusal) throw memberError("members.handover_refused", { ...refusal });
          const out = work.total > 0 ? await this.handOver(tx, workspaceId, userId, handoverTo, work) : ZERO;
          await this.audit.record(tx, {
            workspaceId,
            actorId: actor.userId,
            action: "member.handover",
            targetKind: "member",
            targetId: userId,
            meta: { handoverTo, moved: out },
          });
          return out;
        },
        { isolationLevel: "Serializable" },
      ),
    );
    this.afterMove(workspaceId, handoverTo, moved, actor);
    return { moved };
  }

  /**
   * DELETE …/members/:userId. One Serializable transaction: re-check the
   * actor and the owner rules, recount, refuse (409) when work is open and no
   * recipient is given, else move every kind, delete the membership and write
   * `member.removed`. The crm User (and its Kewy identity) stays.
   */
  async removeWithHandover(
    workspaceId: string,
    userId: string,
    actor: Actor,
    handoverTo?: string,
  ): Promise<{ ok: true; moved: OpenWorkDto }> {
    // Ruling 11: also blocked per route in PermissionGuard; refused here too
    // so no other caller can remove a member from a support session.
    if (actor.impersonating && !actor.isSuperAdmin) {
      throw new ForbiddenException({ statusCode: 403, message: "Not allowed during impersonation" });
    }
    const moved = await serializable(() =>
      this.prisma.$transaction(
        async (tx) => {
          const m = await findWorkspaceMember(tx, workspaceId, userId);
          await this.permissions.assertCanActOn(workspaceId, actor, userId);
          const owner = isEffectiveOwner(m);
          if (owner) await this.permissions.assertOwner(workspaceId, actor, "Only an owner can remove an owner");
          const work = await this.openWork(tx, workspaceId, userId);
          if (work.total > 0 && !handoverTo) throw memberError("members.handover_required", { openWork: work });
          if (handoverTo && work.total > 0) {
            const refusal = await this.canReceive(workspaceId, userId, handoverTo, work);
            if (refusal) throw memberError("members.handover_refused", { ...refusal });
          }
          // After the counts and before any write: a refusal moves nothing.
          if (owner) await assertAnotherOwner(tx, workspaceId, m.id);
          const out = handoverTo && work.total > 0 ? await this.handOver(tx, workspaceId, userId, handoverTo, work) : ZERO;
          await tx.workspaceMember.delete({ where: { id: m.id } });
          await this.audit.record(tx, {
            workspaceId,
            actorId: actor.userId,
            action: "member.removed",
            targetKind: "member",
            targetId: userId,
            meta: { handoverTo: handoverTo && work.total > 0 ? handoverTo : null, moved: out },
          });
          return out;
        },
        { isolationLevel: "Serializable" },
      ),
    );
    this.permissions.invalidate(workspaceId, userId);
    if (handoverTo && moved.total > 0) this.afterMove(workspaceId, handoverTo, moved, actor);
    return { ok: true, moved };
  }

  /** After commit: one notification to the recipient and an inbox refresh. */
  private afterMove(workspaceId: string, to: string, moved: OpenWorkDto, actor: Actor): void {
    if (moved.total === 0) return;
    void this.notifications
      .notify(workspaceId, [to], {
        type: "assignment",
        title: "assignment.handover",
        body: String(moved.total),
        actorId: actor.userId,
      })
      .catch((e: unknown) => this.logger.warn(`handover notification failed: ${(e as Error)?.message}`));
    if (moved.conversations > 0) {
      try {
        this.realtime.emitToWorkspace(workspaceId, "inbox.activity", { reason: "handover" });
      } catch (e) {
        this.logger.warn(`handover realtime emit failed: ${(e as Error)?.message}`);
      }
    }
  }
}
