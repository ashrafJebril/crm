import { Injectable, Logger, Optional } from "@nestjs/common";
import { Prisma, type Channel } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { ZernioService } from "../integrations/zernio.service";
import { redactUrl } from "../common/redact-url";
import { channelError } from "./channel-errors";
import { toChannelDto, type ChannelDto } from "./channel-dto";
import { ChannelTransportRegistry } from "./channel-transport";
import { whatsappUsage } from "./channel-limits";
import { secretsEncryptionEnabled } from "./channel-credentials";
import { ensureDefaultPerKind, ensureLegacyChannels, isUniqueViolation } from "./legacy-mirror";
import { USER_DISCONNECTED } from "./zernio-mirror";
import { originOptions, validateWebchatConfig } from "./webchat/origin-match";
import type { ChannelLimitsDto, CreateChannelDto, UpdateChannelDto } from "./channels.dto";

/**
 * Member-editable web chat config (allowedOrigins, greeting, greetingAr,
 * color, position, askName, lang), validated by T3's origin-match rules:
 * https-only origins in production, `https://*.domain` wildcards, greeting
 * <= 280 chars, `#rrggbb` colours. Server-managed keys (wabaId,
 * verification, botUsername) are written only by the connect flows.
 */
function editableConfig(config: Record<string, unknown> | undefined): Record<string, unknown> {
  return validateWebchatConfig(config, originOptions());
}

/**
 * The channels hub (`/channels`). Every response goes through toChannelDto,
 * so no secret ever leaves. A foreign or unknown id is 404 channels.not_found.
 */
@Injectable()
export class ChannelsService {
  private readonly log = new Logger(ChannelsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly transports: ChannelTransportRegistry,
    private readonly realtime: RealtimeService,
    @Optional() private readonly zernio?: ZernioService,
  ) {}

  async list(workspaceId: string, kind?: string): Promise<ChannelDto[]> {
    await ensureLegacyChannels(this.prisma, workspaceId);
    const rows = await this.prisma.channel.findMany({
      where: { workspaceId, ...(kind ? { kind } : {}) },
      orderBy: [{ kind: "asc" }, { isDefault: "desc" }, { createdAt: "asc" }],
    });
    return rows.map((r) => toChannelDto(r));
  }

  async get(workspaceId: string, id: string): Promise<ChannelDto> {
    return toChannelDto(await this.load(workspaceId, id));
  }

  /** Web chat only; the config is validated by validateWebchatConfig. */
  async createWebchat(workspaceId: string, dto: CreateChannelDto): Promise<ChannelDto> {
    if (dto.kind !== "webchat") throw channelError("channels.invalid_config", { field: "kind" });
    const hasDefault = await this.prisma.channel.findFirst({
      where: { workspaceId, kind: "webchat", isDefault: true },
      select: { id: true },
    });
    const data = {
      workspaceId,
      kind: "webchat",
      provider: "native",
      externalId: null,
      displayName: dto.displayName.trim(),
      status: "active",
      config: editableConfig(dto.config) as Prisma.InputJsonValue,
    };
    let row: Channel;
    try {
      row = await this.prisma.channel.create({ data: { ...data, isDefault: !hasDefault } });
    } catch (e) {
      // A concurrent first create took the default: this one is not.
      if (hasDefault || !isUniqueViolation(e)) throw e;
      row = await this.prisma.channel.create({ data: { ...data, isDefault: false } });
    }
    this.changed(workspaceId, row.id);
    return toChannelDto(row);
  }

  async update(workspaceId: string, id: string, dto: UpdateChannelDto): Promise<ChannelDto> {
    const row = await this.load(workspaceId, id);
    const data: Prisma.ChannelUpdateInput = {};
    if (dto.displayName !== undefined) data.displayName = dto.displayName.trim();
    if (dto.config !== undefined) {
      const current = (row.config && typeof row.config === "object" && !Array.isArray(row.config) ? row.config : {}) as Record<string, unknown>;
      data.config = { ...current, ...editableConfig(dto.config) } as Prisma.InputJsonValue;
    }
    let updated: Channel;
    if (dto.isDefault === true && !row.isDefault) {
      if (row.status !== "active") throw channelError("channels.default_requires_active");
      // One transaction: clear the kind's other default, then set this one
      // (the partial unique index rejects two defaults at any instant). A
      // concurrent make-default makes one of them lose: 409, rolled back.
      try {
        const [, next] = await this.prisma.$transaction([
          this.prisma.channel.updateMany({
            where: { workspaceId, kind: row.kind, isDefault: true, id: { not: row.id } },
            data: { isDefault: false },
          }),
          this.prisma.channel.update({ where: { id: row.id }, data: { ...data, isDefault: true } }),
        ]);
        updated = next;
      } catch (e) {
        if (isUniqueViolation(e)) throw channelError("channels.default_conflict");
        throw e;
      }
    } else {
      // A kind keeps exactly one default: to move it, make another channel
      // the default. Unsetting the current one is refused (M1).
      if (dto.isDefault === false && row.isDefault) throw channelError("channels.default_required");
      updated = await this.prisma.channel.update({ where: { id: row.id }, data });
    }
    this.changed(workspaceId, row.id);
    return toChannelDto(updated);
  }

  /**
   * Soft disconnect (R9): history and conversation.channelId are kept, sends
   * return 409 channels.disconnected. Provider teardown (e.g. Telegram
   * deleteWebhook) is best effort. A default is handed to the next active
   * channel of the kind.
   */
  async disconnect(workspaceId: string, id: string): Promise<ChannelDto> {
    const row = await this.load(workspaceId, id);
    if (row.status === "disconnected") return toChannelDto(row);
    const transport = this.transports.get(row.provider);
    if (transport?.disconnect) {
      try {
        await transport.disconnect(row);
      } catch (e) {
        this.log.warn(`provider teardown failed for channel ${row.id}: ${redactUrl((e as Error).message ?? "")}`);
      }
    }
    const updated = await this.prisma.channel.update({
      where: { id: row.id },
      data: { status: "disconnected", statusReason: USER_DISCONNECTED, disconnectedAt: new Date(), isDefault: false },
    });
    if (row.isDefault) await ensureDefaultPerKind(this.prisma, workspaceId);
    this.changed(workspaceId, row.id);
    return toChannelDto(updated);
  }

  /**
   * `POST /channels/:id/reconnect`: re-run the provider registration through
   * the transport's `reconnect` hook (Telegram: rotate the webhook secret and
   * setWebhook again). Reactivates a soft-disconnected row (R9) or retries an
   * `error` one. Providers without a hook: 400 channels.transport_unavailable.
   */
  async reconnect(workspaceId: string, id: string): Promise<ChannelDto> {
    const row = await this.load(workspaceId, id);
    const transport = this.transports.get(row.provider);
    if (!transport?.reconnect) throw channelError("channels.transport_unavailable", { provider: row.provider });
    const updated = await transport.reconnect(row);
    await ensureDefaultPerKind(this.prisma, workspaceId);
    this.changed(workspaceId, row.id);
    return toChannelDto((await this.prisma.channel.findFirst({ where: { id: row.id, workspaceId } })) ?? updated);
  }

  /** Zernio resync (one channel per account) plus the legacy mirror. */
  async sync(workspaceId: string): Promise<ChannelDto[]> {
    if (this.zernio) await this.zernio.syncAccounts(workspaceId);
    await ensureLegacyChannels(this.prisma, workspaceId);
    await ensureDefaultPerKind(this.prisma, workspaceId);
    return this.list(workspaceId);
  }

  async limits(workspaceId: string, includeWarnings: boolean): Promise<ChannelLimitsDto> {
    const whatsapp = await whatsappUsage(this.prisma, workspaceId);
    return includeWarnings
      ? { whatsapp, secretsEncryption: secretsEncryptionEnabled() ? "on" : "off" }
      : { whatsapp };
  }

  private async load(workspaceId: string, id: string): Promise<Channel> {
    const row = await this.prisma.channel.findFirst({ where: { id, workspaceId } });
    if (!row) throw channelError("channels.not_found");
    return row;
  }

  private changed(workspaceId: string, channelId: string): void {
    this.realtime.emitToWorkspace(workspaceId, "channels.updated", { channelId });
  }
}
