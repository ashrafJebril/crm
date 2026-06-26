import { ForbiddenException, Injectable, Logger } from "@nestjs/common";
import * as crypto from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import type { HjzClientWebhookDto } from "./hjz-webhooks.dto";

/**
 * Inbound client-sync webhook from hjz-v2.
 *
 * hjz POSTs every client create/update/delete here with an
 * `x-marketing-secret` header. We verify the secret in constant time, resolve
 * the hjz tenant → tkana Workspace (lazy-creating it so sync works even
 * before anyone has logged in via SSO), then upsert a Contact row tagged by
 * (workspaceId, externalSource="hjz", externalId=hjz client id) — the
 * existing composite unique on Contact handles the dedupe.
 *
 * Deletions soft-update the lifecycle to "churned"; we don't destroy the row
 * so any linked conversations/tickets stay valid. Re-upserts on a later
 * `client.upserted` flip the lifecycle back to "customer".
 */
@Injectable()
export class HjzWebhooksService {
  private readonly logger = new Logger(HjzWebhooksService.name);
  private static readonly SOURCE = "hjz";

  constructor(private readonly prisma: PrismaService) {}

  /** Constant-time compare of the shared webhook secret. */
  verifySecret(provided: string | undefined): void {
    const expected = process.env.HJZ_WEBHOOK_SECRET;
    if (!expected) {
      throw new ForbiddenException(
        "Webhook receiver not configured (HJZ_WEBHOOK_SECRET unset)",
      );
    }
    const a = Buffer.from(provided ?? "");
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new ForbiddenException("Invalid webhook secret");
    }
  }

  async handle(body: HjzClientWebhookDto): Promise<{ ok: true }> {
    const { event, client } = body;

    // Resolve (or lazily create) the Workspace mirror for this hjz tenant so
    // sync works even before anyone has SSO'd in. Idempotent.
    const workspace = await this.prisma.workspace.upsert({
      where: { externalTenantId: client.tenantId },
      update: {},
      create: {
        name: `HJZ ${client.tenantId.slice(0, 8)}`,
        slug: await this.allocateSlug(`hjz-${client.tenantId}`),
        externalTenantId: client.tenantId,
      },
    });

    // Look up by the existing composite unique (workspaceId, externalSource,
    // externalId) — the same key the FB/IG integration uses.
    const existing = await this.prisma.contact.findUnique({
      where: {
        workspaceId_externalSource_externalId: {
          workspaceId: workspace.id,
          externalSource: HjzWebhooksService.SOURCE,
          externalId: client.id,
        },
      },
      select: { id: true },
    });

    // Deletion (event or implicit via deletedAt) → soft-flip lifecycle to
    // "churned". Linked conversations/tickets remain valid.
    if (event === "client.deleted" || client.deletedAt) {
      if (existing) {
        await this.prisma.contact.update({
          where: { id: existing.id },
          data: { lifecycle: "churned" },
        });
      }
      this.logger.debug(
        `hjz client ${client.id} → churned in workspace ${workspace.id}`,
      );
      return { ok: true };
    }

    const tagsJson = JSON.stringify(client.tags ?? []);
    const data = {
      workspaceId: workspace.id,
      externalSource: HjzWebhooksService.SOURCE,
      externalId: client.id,
      name: client.name,
      phone: client.phone ?? null,
      industry: "—",
      lifecycle: client.blocked ? "blocked" : "customer",
      source: HjzWebhooksService.SOURCE,
      tags: tagsJson,
      lastSeen: "now",
    };

    if (existing) {
      await this.prisma.contact.update({ where: { id: existing.id }, data });
    } else {
      await this.prisma.contact.create({ data });
    }

    this.logger.debug(
      `hjz client ${client.id} → ${existing ? "updated" : "created"} in workspace ${workspace.id}`,
    );
    return { ok: true };
  }

  /** Mirror of WorkspacesService slug allocation — guarantees a unique slug. */
  private async allocateSlug(seed: string): Promise<string> {
    const base =
      seed
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "workspace";
    let candidate = base;
    let i = 1;
    while (await this.prisma.workspace.findUnique({ where: { slug: candidate } })) {
      i += 1;
      candidate = `${base}-${i}`;
      if (i > 50) {
        throw new Error("Could not allocate a unique slug");
      }
    }
    return candidate;
  }
}
