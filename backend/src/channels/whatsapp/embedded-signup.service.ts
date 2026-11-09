import { Injectable, Logger } from "@nestjs/common";
import { Prisma, type Channel } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { RealtimeService } from "../../realtime/realtime.service";
import { channelError } from "../channel-errors";
import { toChannelDto, type ChannelDto } from "../channel-dto";
import { assertWhatsappCapacity } from "../channel-limits";
import { encryptChannelSecrets, secretsEncryptionEnabled } from "../channel-credentials";
import { ensureDefaultPerKind, ensureLegacyChannels } from "../legacy-mirror";
import { graphVersion, MetaGraphClient, MetaGraphError } from "./meta-graph.client";
import {
  addsWhatsappSlot,
  assertSecretsStorable,
  attachMetaNumber,
  findMetaNumber,
  generatePin,
  META_REGISTER_FAILED,
  META_SUBSCRIBE_FAILED,
  objectConfig,
  storedSecrets,
  verificationOf,
  withVerification,
  type Verification,
} from "./meta-number";

/** `GET /channels/whatsapp/embedded-signup/config`. */
export interface EmbeddedSignupConfigDto {
  enabled: boolean;
  appId?: string;
  configId?: string;
  solutionId?: string;
  graphVersion: string;
  /** Why it is off: channels.embedded_signup_not_configured |
   *  channels.encryption_unavailable. */
  reason?: string;
  /** Env NAMES (never values) still to set; only for channels.update holders. */
  missing?: string[];
}

export type SignupEvent = "FINISH" | "FINISH_ONLY_WABA";

export interface EmbeddedSignupInput {
  code: string;
  wabaId?: string;
  phoneNumberId?: string;
  signupEvent?: SignupEvent;
  displayName?: string;
}

const env = (k: string) => (process.env[k] ?? "").trim();

/** The Meta app settings, from env only — nothing is invented (R1). */
function metaApp() {
  return {
    appId: env("META_APP_ID_WA") || env("META_APP_ID"),
    appSecret: env("META_APP_SECRET_WA") || env("META_APP_SECRET"),
    configId: env("META_WA_CONFIG_ID"),
    solutionId: env("META_WA_SOLUTION_ID"),
  };
}

/**
 * Whether the embedded signup can run (R1). It needs the WhatsApp app id and
 * secret (`META_APP_ID_WA`/`META_APP_SECRET_WA`, falling back to
 * `META_APP_ID`/`META_APP_SECRET`) and the Login-for-Business configuration
 * `META_WA_CONFIG_ID`; `META_WA_SOLUTION_ID` is optional. In production it
 * also needs `TOKEN_ENC_KEY` (R5: new channel secrets are never stored in
 * plaintext there). The app secret is never returned.
 */
export function embeddedSignupConfig(opts: { includeMissing: boolean }): EmbeddedSignupConfigDto {
  const app = metaApp();
  const version = graphVersion();
  const missing: string[] = [];
  if (!app.appId) missing.push("META_APP_ID_WA");
  if (!app.appSecret) missing.push("META_APP_SECRET_WA");
  if (!app.configId) missing.push("META_WA_CONFIG_ID");
  if (missing.length) {
    return {
      enabled: false,
      graphVersion: version,
      reason: "channels.embedded_signup_not_configured",
      ...(opts.includeMissing ? { missing } : {}),
    };
  }
  if (process.env.NODE_ENV === "production" && !secretsEncryptionEnabled()) {
    return {
      enabled: false,
      graphVersion: version,
      reason: "channels.encryption_unavailable",
      ...(opts.includeMissing ? { missing: ["TOKEN_ENC_KEY"] } : {}),
    };
  }
  return {
    enabled: true,
    appId: app.appId,
    configId: app.configId,
    ...(app.solutionId ? { solutionId: app.solutionId } : {}),
    graphVersion: version,
  };
}

/** A repeated code (double submit, retried request) within this window gets
 *  the first result instead of a second exchange (codes are single-use). */
const IDEMPOTENCY_TTL_MS = 10 * 60_000;
const IDEMPOTENCY_MAX = 500;

/**
 * SP-19 T4 — WhatsApp embedded signup (`POST /channels/whatsapp/embedded-signup`).
 * Order: config check → plan limit (409 before any Meta call) → code exchange
 * → subscribe the app to the WABA → for a FINISH with a number: read it,
 * register it with a PIN kept in `secretsEnc` and attach it (a second number
 * never touches the first) → otherwise a `pending` channel whose landline
 * card adds the number. Idempotent for a repeated code (per machine) and for
 * a re-run on the same number or WABA (the row is refreshed, never doubled).
 */
@Injectable()
export class EmbeddedSignupService {
  private readonly log = new Logger(EmbeddedSignupService.name);
  private readonly recent = new Map<string, { at: number; result: Promise<ChannelDto> }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: MetaGraphClient,
    private readonly realtime: RealtimeService,
  ) {}

  async signup(workspaceId: string, input: EmbeddedSignupInput): Promise<ChannelDto> {
    const cfg = embeddedSignupConfig({ includeMissing: false });
    if (!cfg.enabled) throw channelError("channels.embedded_signup_unavailable", { reason: cfg.reason });

    const key = `${workspaceId}:${createHash("sha256").update(String(input.code ?? "")).digest("hex")}`;
    const now = Date.now();
    for (const [k, v] of this.recent) if (now - v.at > IDEMPOTENCY_TTL_MS) this.recent.delete(k);
    const hit = this.recent.get(key);
    if (hit) return hit.result;
    if (this.recent.size >= IDEMPOTENCY_MAX) this.recent.delete(this.recent.keys().next().value as string);

    const result = this.run(workspaceId, input);
    this.recent.set(key, { at: now, result });
    // A failed attempt is not cached: the caller sees the error once.
    result.catch(() => this.recent.delete(key));
    return result;
  }

  private async run(workspaceId: string, input: EmbeddedSignupInput): Promise<ChannelDto> {
    const app = metaApp();
    const phoneNumberId = input.phoneNumberId?.trim() || undefined;
    const event: SignupEvent = input.signupEvent ?? (phoneNumberId ? "FINISH" : "FINISH_ONLY_WABA");
    const withNumber = event === "FINISH" && !!phoneNumberId;

    // 1. Limit, before the (single-use) code is spent.
    await ensureLegacyChannels(this.prisma, workspaceId);
    const reuse = !withNumber && input.wabaId ? await this.pendingFor(workspaceId, input.wabaId) : null;
    const addsSlot = withNumber ? await addsWhatsappSlot(this.prisma, workspaceId, phoneNumberId!) : !reuse;
    if (addsSlot) await assertWhatsappCapacity(this.prisma, workspaceId);
    assertSecretsStorable();

    // 2. Code → business token.
    let token: string;
    try {
      token = await this.graph.exchangeCode(app.appId, app.appSecret, input.code);
    } catch (e) {
      throw failed("exchange", e);
    }

    let wabaId = input.wabaId?.trim() || "";
    if (!wabaId) {
      let ids: string[] = [];
      try {
        ids = await this.graph.grantedWabaIds(token, app.appId, app.appSecret);
      } catch (e) {
        throw failed("waba", e);
      }
      if (ids.length !== 1) throw channelError("channels.embedded_signup_failed", { step: "waba" });
      wabaId = ids[0];
    }

    // 3. Subscribe our app to the WABA (webhooks). A refusal does not lose
    //    the signup: the row records it and a reconnect retries.
    let subscribed = true;
    try {
      await this.graph.subscribeApp(wabaId, token);
    } catch (e) {
      subscribed = false;
      this.log.warn(`subscribed_apps failed for a signup WABA: code=${(e as MetaGraphError).code ?? "-"}`);
    }

    const row = withNumber
      ? await this.attachNumber(workspaceId, { token, wabaId, phoneNumberId: phoneNumberId!, subscribed, displayName: input.displayName })
      : await this.pendingNumber(workspaceId, { token, wabaId, subscribed, reuse: reuse ?? (await this.pendingFor(workspaceId, wabaId)), displayName: input.displayName });

    this.realtime.emitToWorkspace(workspaceId, "channels.updated", { channelId: row.id });
    return toChannelDto(row);
  }

  /** 4. FINISH with a number: read it, register it, attach it. */
  private async attachNumber(
    workspaceId: string,
    a: { token: string; wabaId: string; phoneNumberId: string; subscribed: boolean; displayName?: string },
  ): Promise<Channel> {
    let info;
    try {
      info = await this.graph.getPhoneNumber(a.phoneNumberId, a.token);
    } catch (e) {
      throw failed("phone", e);
    }
    const existing = await findMetaNumber(this.prisma, workspaceId, a.phoneNumberId);
    const pin = storedSecrets(existing).registrationPin ?? generatePin();

    // A number Meta already lists on Cloud API carries a PIN that may not be
    // ours: registering it again would be refused (and could break it).
    let registered = true;
    if (info.platform_type !== "CLOUD_API") {
      try {
        await this.graph.register(a.phoneNumberId, a.token, pin);
      } catch (e) {
        registered = false;
        this.log.warn(`register failed for a signup number: code=${(e as MetaGraphError).code ?? "-"}`);
      }
    }
    const status = !registered ? "pending" : a.subscribed ? "active" : "error";
    const statusReason = !registered ? META_REGISTER_FAILED : a.subscribed ? null : META_SUBSCRIBE_FAILED;
    const verification: Verification | null = registered ? null : { stage: "needs_registration" };
    const label = a.displayName?.trim() || info.verified_name?.trim() || info.display_phone_number?.trim() || "WhatsApp";

    const { channel } = await attachMetaNumber(this.prisma, workspaceId, {
      phoneNumberId: a.phoneNumberId,
      wabaId: a.wabaId,
      accessToken: a.token,
      displayName: label,
      displayPhoneNumber: info.display_phone_number ?? null,
      verifiedName: info.verified_name ?? null,
      registrationPin: pin,
      status,
      statusReason,
      verification,
      // Only used when this becomes the legacy Integration (Meta webhook handshake).
      verifyToken: `aram-wa-${randomBytes(6).toString("hex")}`,
    });
    return channel;
  }

  /** 5. FINISH_ONLY_WABA (or no number): a pending row for the landline card. */
  private async pendingNumber(
    workspaceId: string,
    a: { token: string; wabaId: string; subscribed: boolean; reuse: Channel | null; displayName?: string },
  ): Promise<Channel> {
    const verification: Verification = { stage: "needs_number" };
    const statusReason = a.subscribed ? null : META_SUBSCRIBE_FAILED;
    const secretsEnc = encryptChannelSecrets({ ...storedSecrets(a.reuse), accessToken: a.token });
    if (a.reuse) {
      return this.prisma.channel.update({
        where: { id: a.reuse.id },
        data: {
          secretsEnc,
          statusReason,
          disconnectedAt: null,
          config: withVerification({ ...objectConfig(a.reuse.config), wabaId: a.wabaId }, verification) as Prisma.InputJsonValue,
        },
      });
    }
    const row = await this.prisma.channel.create({
      data: {
        workspaceId,
        kind: "whatsapp",
        provider: "meta",
        externalId: null,
        displayName: a.displayName?.trim() || "WhatsApp",
        status: "pending",
        statusReason,
        isDefault: false,
        config: withVerification({ wabaId: a.wabaId }, verification) as Prisma.InputJsonValue,
        secretsEnc,
      },
    });
    await ensureDefaultPerKind(this.prisma, workspaceId);
    return row;
  }

  /** A pending row of this workspace still waiting for a number on `wabaId`. */
  private async pendingFor(workspaceId: string, wabaId: string): Promise<Channel | null> {
    const rows = await this.prisma.channel.findMany({
      where: { workspaceId, kind: "whatsapp", provider: "meta", externalId: null, status: "pending" },
      orderBy: { createdAt: "asc" },
    });
    return (
      rows.find((r) => objectConfig(r.config).wabaId === wabaId && verificationOf(r)?.stage === "needs_number") ?? null
    );
  }
}

function failed(step: "exchange" | "waba" | "phone", e: unknown) {
  const metaCode = e instanceof MetaGraphError ? e.code : null;
  return channelError("channels.embedded_signup_failed", { step, ...(metaCode !== null ? { metaCode } : {}) });
}
