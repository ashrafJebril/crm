import { ForbiddenException, Injectable, Logger } from "@nestjs/common";
import * as crypto from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import type { TiremallCustomersWebhookDto } from "./tiremall-webhooks.dto";

/**
 * Inbound customer-sync webhook from Tiremall. Mirrors HjzWebhooksService:
 * constant-time secret check, lazily-created Workspace, Contact upsert keyed
 * by (workspaceId, externalSource="tiremall", externalId). Deletions soft-flip
 * the lifecycle to "churned".
 */
@Injectable()
export class TiremallWebhooksService {
  private readonly logger = new Logger(TiremallWebhooksService.name);
  private static readonly SOURCE = "tiremall";
  private static readonly TENANT = "tiremall";

  constructor(private readonly prisma: PrismaService) {}

  /** Constant-time compare of the shared webhook secret. */
  verifySecret(provided: string | undefined): void {
    const expected = process.env.TIREMALL_WEBHOOK_SECRET;
    if (!expected) {
      throw new ForbiddenException(
        "Webhook receiver not configured (TIREMALL_WEBHOOK_SECRET unset)",
      );
    }
    const a = Buffer.from(provided ?? "");
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new ForbiddenException("Invalid webhook secret");
    }
  }

  async handle(
    body: TiremallCustomersWebhookDto,
  ): Promise<{ ok: true; processed: number }> {
    const { event, customers } = body;
    const source = TiremallWebhooksService.SOURCE;

    const workspace = await this.prisma.workspace.upsert({
      where: { tiremallTenantId: TiremallWebhooksService.TENANT },
      update: {},
      create: {
        name: "Tiremall",
        slug: await this.allocateSlug("tiremall"),
        tiremallTenantId: TiremallWebhooksService.TENANT,
      },
    });

    for (const c of customers) {
      const existing = await this.prisma.contact.findUnique({
        where: {
          workspaceId_externalSource_externalId: {
            workspaceId: workspace.id,
            externalSource: source,
            externalId: c.id,
          },
        },
        select: { id: true },
      });

      if (event === "customer.deleted") {
        if (existing) {
          await this.prisma.contact.update({
            where: { id: existing.id },
            data: { lifecycle: "churned" },
          });
        }
        continue;
      }

      const data = {
        workspaceId: workspace.id,
        externalSource: source,
        externalId: c.id,
        name: c.name,
        phone: c.phone ?? null,
        industry: c.city || "—",
        lifecycle: "customer",
        source,
        value:
          c.totalSpent != null
            ? `IQD ${Math.round(c.totalSpent).toLocaleString("en-US")}`
            : null,
        lastSeen: "now",
      };
      if (existing) {
        await this.prisma.contact.update({ where: { id: existing.id }, data });
      } else {
        await this.prisma.contact.create({ data });
      }
    }

    this.logger.debug(
      `tiremall ${event}: ${customers.length} customers in workspace ${workspace.id}`,
    );
    return { ok: true, processed: customers.length };
  }

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
