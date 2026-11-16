/**
 * Seeds the SP-11 fixture world (`__fixtures__/insights-world.ts`) into
 * Postgres and returns a cleanup function. Used by the DB specs
 * (`support-metrics.db.spec.ts`, gated on INSIGHTS_TEST_DATABASE_URL) and by
 * the Task 6 live verification. Writes rows straight into the database: no
 * webhook, no send, no provider call.
 *
 * Every row id is `<tag>_<logical id>` so a run never collides with another;
 * `toLogical` maps ids in a response back to the fixture's. Users get the
 * tagged email `<tag>+<logical id>@insights.invalid`. With `users`, logical
 * user ids are re-pointed to existing users instead (Task 6: invited test
 * users), and those users are neither created nor deleted.
 */
import type { PrismaClient } from "@prisma/client";
import type { InsightsWorld } from "./__fixtures__/insights-world";

export interface SeededWorld {
  workspaceId: string;
  /** Logical fixture id → database id. */
  id: (logical: string) => string;
  /** Database id → logical fixture id (unknown ids pass through). */
  toLogical: (dbId: string | null) => string | null;
  /** Deletes everything this seed created (the workspace cascades). */
  cleanup: () => Promise<void>;
}

export interface SeedOptions {
  /** Prefix for every id, slug and email; default `zz-insights-<time>`. */
  tag?: string;
  /** Logical user id → an existing user id (not created, not deleted). */
  users?: Record<string, string>;
}

export async function seedInsightsWorld(prisma: PrismaClient, world: InsightsWorld, opts: SeedOptions = {}): Promise<SeededWorld> {
  const tag = opts.tag ?? `zz-insights-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const mapped = opts.users ?? {};
  const id = (logical: string) => mapped[logical] ?? `${tag}_${logical}`;
  const reverse = new Map<string, string>();
  const remember = (logical: string) => {
    reverse.set(id(logical), logical);
    return id(logical);
  };
  const createdUsers: string[] = [];

  const workspaceId = remember("workspace");
  await prisma.workspace.create({
    data: { id: workspaceId, name: `${world.workspace.name} ${tag}`, slug: tag, timezone: world.workspace.timezone, lang: world.workspace.lang },
  });

  try {
    for (const r of world.roles) {
      await prisma.role.create({
        data: {
          id: remember(r.id),
          workspaceId,
          key: null,
          name: `${r.name} ${tag}`,
          nameAr: r.name,
          isSystem: false,
          permissions: r.permissions,
          conversationVisibility: r.conversationVisibility,
        },
      });
    }

    for (const u of world.users) {
      const userId = remember(u.id);
      if (!mapped[u.id]) {
        await prisma.user.create({
          data: { id: userId, email: `${tag}+${u.id}@insights.invalid`, name: u.name, initials: u.name.slice(0, 2), color: "150" },
        });
        createdUsers.push(userId);
      }
      if (u.role !== null) {
        await prisma.workspaceMember.create({
          data: { userId, workspaceId, role: u.role, roleId: u.roleId ? id(u.roleId) : null },
        });
      }
    }

    for (const c of world.channels) {
      await prisma.channel.create({
        data: {
          id: remember(c.id),
          workspaceId,
          kind: c.kind,
          provider: c.provider,
          externalId: `${tag}-${c.externalId}`,
          displayName: c.displayName,
          status: "active",
        },
      });
    }

    for (const c of world.conversations) {
      const contactId = remember(`contact-${c.id}`);
      await prisma.contact.create({
        data: { id: contactId, workspaceId, name: `Contact ${c.id}`, industry: "—", lifecycle: "customer", source: "whatsapp", lastSeen: "now" },
      });
      await prisma.conversation.create({
        data: {
          id: remember(c.id),
          workspaceId,
          contactId,
          channel: c.channel,
          channelId: c.channelId ? id(c.channelId) : null,
          assigneeId: c.assigneeId ? id(c.assigneeId) : null,
          lastAt: "now",
          lastFrom: "them",
          preview: "",
          status: "human",
          intent: "",
          confidence: 0,
          escalated: c.escalated ?? false,
          resolutionStatus: c.resolutionStatus ?? null,
          resolution: c.resolution ?? null,
          resolutionIssue: c.resolutionIssue ?? null,
          resolutionSentiment: c.resolutionSentiment ?? null,
          resolvedAt: c.resolvedAt ?? null,
          ...(c.topics !== undefined ? { topics: c.topics as never } : {}),
        },
      });
    }

    await prisma.message.createMany({
      data: world.messages.map((m) => ({
        id: remember(m.id),
        workspaceId,
        conversationId: id(m.conversationId),
        from: m.from,
        body: `${m.from} ${m.id}`,
        t: m.createdAt.toISOString().slice(11, 16),
        createdAt: m.createdAt,
        sentById: m.sentById ? id(m.sentById) : null,
      })),
    });

    for (const p of world.pipelines) {
      await prisma.pipeline.create({
        data: { id: remember(p.id), workspaceId, key: p.key, name: p.name, nameAr: p.name, kind: p.kind },
      });
      await prisma.ticketStage.create({
        data: {
          id: remember(p.stageId),
          workspaceId,
          pipelineId: id(p.id),
          key: "open",
          label: "Open",
          labelAr: "مفتوحة",
          color: "info",
          order: 0,
          groupKey: `${p.key}_open`,
        },
      });
    }

    let number = 0;
    for (const t of world.tickets) {
      const pipeline = world.pipelines.find((p) => p.id === t.pipelineId);
      if (!pipeline) throw new Error(`fixture ticket ${t.id}: unknown pipeline`);
      const conv = world.conversations.find((c) => c.id === t.conversationId);
      await prisma.ticket.create({
        data: {
          id: remember(t.id),
          workspaceId,
          number: ++number,
          pipelineId: id(t.pipelineId),
          stageId: id(pipeline.stageId),
          contactId: id(`contact-${conv?.id ?? world.conversations[0].id}`),
          conversationId: t.conversationId ? id(t.conversationId) : null,
          title: `Ticket ${t.id}`,
          createdAt: t.createdAt,
          enteredStageAt: t.createdAt,
        },
      });
    }
  } catch (e) {
    await cleanupRows(prisma, workspaceId, createdUsers);
    throw e;
  }

  return {
    workspaceId,
    id,
    toLogical: (dbId) => (dbId === null ? null : (reverse.get(dbId) ?? dbId)),
    cleanup: () => cleanupRows(prisma, workspaceId, createdUsers),
  };
}

async function cleanupRows(prisma: PrismaClient, workspaceId: string, users: string[]): Promise<void> {
  // Tickets first (Ticket → TicketStage is a restricting relation), then the
  // workspace, which cascades to members, roles, channels, contacts,
  // conversations, messages, pipelines and stages.
  await prisma.ticket.deleteMany({ where: { workspaceId } });
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users } } });
}
