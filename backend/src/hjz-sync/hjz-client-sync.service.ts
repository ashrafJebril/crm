import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { hjzWebhookUrl, postToHjz } from "./hjz-api";

/** A failed push is retried after this long, not on every sweep. */
const RETRY_AFTER_MS = 60 * 60 * 1000;
const SWEEP_BATCH = 100;

/**
 * CRM → HJZ half of the client sync: every customer that appears in a
 * workspace connected to HJZ (Workspace.externalTenantId) gets an HJZ client.
 *
 * Contacts are created on many paths — the contacts API, the MCP tool, and
 * the WhatsApp / FB / IG / Zernio / L webhooks writing Prisma directly — so
 * ContactsService.create pushes immediately and a one-minute sweep picks up
 * everything else plus failed pushes.
 *
 * HJZ links to an existing client with the same phone/email instead of
 * creating a duplicate, and does not echo the create back; the returned id is
 * stored in Contact.hjzClientId, which is how HJZ's later client.upserted
 * webhooks find this row.
 */
@Injectable()
export class HjzClientSyncService {
  private readonly logger = new Logger(HjzClientSyncService.name);
  private sweeping = false;

  constructor(private readonly prisma: PrismaService) {}

  isConfigured(): boolean {
    return hjzWebhookUrl("clients") !== null;
  }

  /** Push one contact. Never throws — sync must not break contact creation. */
  async pushContact(contactId: string): Promise<boolean> {
    if (!this.isConfigured()) return false;
    try {
      const contact = await this.prisma.raw.contact.findUnique({
        where: { id: contactId },
        include: { workspace: { select: { externalTenantId: true } } },
      });
      const tenantId = contact?.workspace.externalTenantId;
      if (!contact || !tenantId || contact.hjzClientId || contact.externalSource === "hjz") return false;

      // Claim the row so the sweep and an immediate push (or two app
      // instances) never create the same client twice.
      const claimed = await this.prisma.raw.contact.updateMany({
        where: {
          id: contact.id,
          hjzClientId: null,
          OR: [{ hjzSyncAttemptAt: null }, { hjzSyncAttemptAt: { lt: new Date(Date.now() - RETRY_AFTER_MS) } }],
        },
        data: { hjzSyncAttemptAt: new Date() },
      });
      if (claimed.count === 0) return false;

      const res = await postToHjz("clients", {
        event: "contact.created",
        contact: {
          id: contact.id,
          tenantId,
          name: contact.name,
          phone: contact.phone,
          tags: parseTags(contact.tags),
        },
      });
      const clientId = (res.body as { clientId?: unknown } | null)?.clientId;
      if (!res.ok || typeof clientId !== "string") {
        this.logger.warn(`hjz client push for contact ${contact.id} -> HTTP ${res.status}`);
        return false;
      }
      await this.prisma.raw.contact.update({ where: { id: contact.id }, data: { hjzClientId: clientId } });
      return true;
    } catch (e: unknown) {
      // P2002 = another contact here is already linked to that HJZ client
      // (same phone twice in the CRM). Left unlinked; retried after back-off.
      this.logger.warn(`hjz client push for contact ${contactId} failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async sweep(): Promise<void> {
    if (!this.isConfigured() || this.sweeping) return;
    this.sweeping = true;
    try {
      const pending = await this.prisma.raw.contact.findMany({
        where: {
          hjzClientId: null,
          OR: [{ externalSource: null }, { externalSource: { not: "hjz" } }],
          AND: [{ OR: [{ hjzSyncAttemptAt: null }, { hjzSyncAttemptAt: { lt: new Date(Date.now() - RETRY_AFTER_MS) } }] }],
          workspace: { externalTenantId: { not: null } },
        },
        select: { id: true },
        orderBy: { createdAt: "asc" },
        take: SWEEP_BATCH,
      });
      for (const c of pending) await this.pushContact(c.id);
    } catch (e: unknown) {
      this.logger.warn(`hjz client sweep failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.sweeping = false;
    }
  }
}

function parseTags(raw: string): string[] {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}
