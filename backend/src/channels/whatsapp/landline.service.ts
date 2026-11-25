import { Injectable, Logger, OnModuleInit, Optional } from "@nestjs/common";
import { Prisma, type Channel } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { RealtimeService } from "../../realtime/realtime.service";
import { channelError } from "../channel-errors";
import { toChannelDto, type ChannelDto } from "../channel-dto";
import { assertWhatsappCapacity } from "../channel-limits";
import { credentialsFor, encryptChannelSecrets } from "../channel-credentials";
import { ChannelTransportRegistry } from "../channel-transport";
import { isUniqueViolation } from "../legacy-mirror";
import { MetaGraphClient, MetaGraphError } from "./meta-graph.client";
import {
  assertNotConnectedElsewhere,
  attachMetaNumber,
  findMetaNumber,
  generatePin,
  META_REGISTER_FAILED,
  META_SUBSCRIBE_FAILED,
  NOT_META,
  objectConfig,
  storedSecrets,
  toE164,
  verificationOf,
  withVerification,
  type Verification,
  type VerificationStage,
} from "./meta-number";

/** Seconds between two request_code calls for one number. */
export const LANDLINE_RESEND_SECONDS = 60;

export interface LandlineNumberInput {
  cc: string;
  phoneNumber: string;
  verifiedName: string;
}
export interface LandlineRequestCodeInput {
  method: "SMS" | "VOICE";
  language?: string;
}
export interface LandlineVerifyInput {
  code: string;
}

type Step = "add_number" | "request_code" | "verify_code" | "register";

/** Graph codes for throttling: 4 / 80007 / 130429 (rate limits), 133016
 *  (too many register attempts), 133008 / 133009 (PIN guessed too often or
 *  too fast). Documented in Meta's WhatsApp error-code reference. */
const RATE_LIMITED = new Set([4, 80007, 130429, 133016, 133008, 133009]);
/** verify_code: the code is wrong or expired. */
const WRONG_CODE = 136025;
/** add_number: the number is already on this WhatsApp Business Account. */
const NUMBER_ON_WABA = 2388012;
/** Graph "invalid parameter". */
const INVALID_PARAMETER = 100;

/** Meta's error → a specific `channels.landline_*` key (only the code is kept). */
export function landlineError(step: Step, e: unknown) {
  const metaCode = e instanceof MetaGraphError ? e.code : null;
  const extra = { metaCode };
  if (metaCode !== null && RATE_LIMITED.has(metaCode)) return channelError("channels.landline_rate_limited", extra);
  if (step === "verify_code" && metaCode === WRONG_CODE) return channelError("channels.landline_wrong_code", extra);
  if (step === "add_number" && metaCode === NUMBER_ON_WABA) return channelError("channels.landline_number_in_use", extra);
  if (metaCode === INVALID_PARAMETER) return channelError("channels.landline_invalid_input", extra);
  return channelError("channels.landline_meta_error", extra);
}

const invalid = (field: string) => channelError("channels.landline_invalid_input", { field });
const digits = (s: string) => s.replace(/\D/g, "");

/**
 * SP-19 T4 — landline (and any number added after a FINISH_ONLY_WABA signup)
 * verification, a state machine on `config.verification.stage`:
 *
 *   needs_number ──number──▶ awaiting_code ──verify──▶ needs_registration ──register──▶ active
 *                            (request-code, 60 s cooldown)
 *
 * A call in another stage is 409 channels.landline_wrong_state {stage}. Meta's
 * refusals map to channels.landline_* keys. The business token from the
 * signup (`secretsEnc`) drives every call; the registration PIN is generated
 * once, stored in `secretsEnc` before the first register and reused.
 *
 * Also registers the `meta` ChannelTransport whose `reconnect` backs
 * `POST /channels/:id/reconnect` for Meta numbers. Meta sends keep their
 * dedicated routes, so its `sendText` answers channels.transport_unavailable
 * exactly as before.
 */
@Injectable()
export class LandlineService implements OnModuleInit {
  private readonly log = new Logger(LandlineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: MetaGraphClient,
    private readonly realtime: RealtimeService,
    @Optional() private readonly transports?: ChannelTransportRegistry,
  ) {}

  onModuleInit(): void {
    if (!this.transports || this.transports.get("meta")) return;
    this.transports.register({
      provider: "meta",
      sendText: async () => {
        throw channelError("channels.transport_unavailable", { provider: "meta" });
      },
      reconnect: (channel) => this.reconnect(channel),
    });
  }

  // ── Steps ────────────────────────────────────────────────────────────────

  async addNumber(workspaceId: string, id: string, input: LandlineNumberInput): Promise<ChannelDto> {
    const cc = digits(String(input?.cc ?? ""));
    if (!/^\+?\s*\d{1,4}\s*$/.test(String(input?.cc ?? "")) || !cc) throw invalid("cc");
    const rawPhone = String(input?.phoneNumber ?? "");
    const phone = digits(rawPhone);
    if (!/^[\d\s().-]+$/.test(rawPhone) || phone.length < 4 || phone.length > 15) throw invalid("phoneNumber");
    const verifiedName = String(input?.verifiedName ?? "").trim();
    if (!verifiedName || verifiedName.length > 120) throw invalid("verifiedName");

    const { row, token, wabaId } = await this.load(workspaceId, id, ["needs_number"]);
    // Meta lists numbers without the national trunk "0".
    const national = phone.replace(/^0+/, "");
    let phoneNumberId: string;
    let display = `+${cc}${national}`;
    try {
      ({ id: phoneNumberId } = await this.graph.addPhoneNumber(wabaId, token, { cc, phoneNumber: phone, verifiedName }));
    } catch (e) {
      if (!(e instanceof MetaGraphError) || e.code !== NUMBER_ON_WABA) throw landlineError("add_number", e);
      // Already on the WABA (an earlier attempt, or added in WhatsApp
      // Manager): adopt it when the WABA lists it.
      let listed: Awaited<ReturnType<MetaGraphClient["listPhoneNumbers"]>> = [];
      try {
        listed = await this.graph.listPhoneNumbers(wabaId, token);
      } catch (e2) {
        throw landlineError("add_number", e2);
      }
      const match = listed.find((n) => digits(n.display_phone_number ?? "") === `${cc}${national}`);
      if (!match) throw landlineError("add_number", e);
      phoneNumberId = match.id;
      display = match.display_phone_number ?? display;
    }

    const clash = await findMetaNumber(this.prisma, workspaceId, phoneNumberId);
    if (clash && clash.id !== row.id) throw channelError("channels.already_connected");
    await assertNotConnectedElsewhere(this.prisma, workspaceId, phoneNumberId);

    const verification: Verification = { stage: "awaiting_code" };
    let updated: Channel;
    try {
      updated = await this.prisma.channel.update({
        where: { id: row.id },
        data: {
          externalId: phoneNumberId,
          phoneNumber: toE164(display),
          displayName: verifiedName.slice(0, 80),
          statusReason: null,
          config: withVerification(objectConfig(row.config), verification) as Prisma.InputJsonValue,
        },
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw channelError("channels.already_connected");
      throw e;
    }
    return this.changed(updated);
  }

  async requestCode(workspaceId: string, id: string, input: LandlineRequestCodeInput): Promise<ChannelDto> {
    const method = input?.method;
    if (method !== "SMS" && method !== "VOICE") throw invalid("method");
    const language = (input?.language ?? "en_US").trim();
    if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(language)) throw invalid("language");

    const { row, token, verification } = await this.load(workspaceId, id, ["awaiting_code"]);
    const now = Date.now();
    const resendAt = verification.resendAt ? Date.parse(verification.resendAt) : NaN;
    if (Number.isFinite(resendAt) && resendAt > now) {
      throw channelError("channels.landline_cooldown", {
        retryAfter: Math.ceil((resendAt - now) / 1000),
        resendAt: new Date(resendAt).toISOString(),
      });
    }
    // The cooldown is claimed before Meta is asked and kept when Meta
    // refuses, which also spares Meta's own attempt counter.
    const next: Verification = { ...verification, resendAt: new Date(now + LANDLINE_RESEND_SECONDS * 1000).toISOString(), method };
    const claimed = await this.prisma.channel.update({
      where: { id: row.id },
      data: { config: withVerification(objectConfig(row.config), next) as Prisma.InputJsonValue },
    });
    try {
      await this.graph.requestCode(row.externalId!, token, method, language);
    } catch (e) {
      throw landlineError("request_code", e);
    }
    return this.changed(claimed);
  }

  async verify(workspaceId: string, id: string, input: LandlineVerifyInput): Promise<ChannelDto> {
    const code = String(input?.code ?? "").trim();
    if (!/^\d{6}$/.test(code)) throw invalid("code");
    const { row, token, verification } = await this.load(workspaceId, id, ["awaiting_code"]);
    try {
      await this.graph.verifyCode(row.externalId!, token, code);
    } catch (e) {
      throw landlineError("verify_code", e);
    }
    const next: Verification = { stage: "needs_registration", verifiedAt: new Date().toISOString() };
    if (verification.method) next.method = verification.method;
    const updated = await this.prisma.channel.update({
      where: { id: row.id },
      data: { config: withVerification(objectConfig(row.config), next) as Prisma.InputJsonValue },
    });
    return this.changed(updated);
  }

  async register(workspaceId: string, id: string): Promise<ChannelDto> {
    const loaded = await this.load(workspaceId, id, ["needs_registration"]);
    return this.changed(await this.registerRow(loaded.row, loaded.token, loaded.wabaId));
  }

  // ── Reconnect hook (POST /channels/:id/reconnect) ─────────────────────────

  /**
   * Meta reconnect: a number waiting for registration is registered; one in an
   * earlier landline stage is 409 landline_wrong_state (use the landline
   * card). Otherwise the token is checked against the number (400
   * channels.meta_token_invalid, row untouched), the app is re-subscribed to
   * the WABA and the row reactivated — `error` / meta_subscribe_failed when
   * Meta refuses the subscription. Reviving a disconnected number needs a
   * free slot under the plan limit.
   */
  async reconnect(channel: Channel): Promise<Channel> {
    const row = (await this.prisma.channel.findFirst({ where: { id: channel.id, workspaceId: channel.workspaceId } })) ?? channel;
    const v = verificationOf(row);
    if (v?.stage === "needs_registration") {
      const loaded = await this.load(row.workspaceId, row.id, ["needs_registration"]);
      return this.registerRow(loaded.row, loaded.token, loaded.wabaId);
    }
    if (v) throw channelError("channels.landline_wrong_state", { stage: v.stage });
    if (row.status === "disconnected") await assertWhatsappCapacity(this.prisma, row.workspaceId);

    const creds = await credentialsFor(this.prisma, row);
    if (!creds.accessToken || !creds.externalId || NOT_META.includes(creds.provider)) {
      throw channelError("channels.not_connected");
    }
    if (!row.integrationId) await assertNotConnectedElsewhere(this.prisma, row.workspaceId, creds.externalId);
    try {
      await this.graph.getPhoneNumber(creds.externalId, creds.accessToken);
    } catch {
      throw channelError("channels.meta_token_invalid");
    }
    const wabaId = await this.wabaIdOf(row);
    let subscribed = true;
    if (wabaId) {
      try {
        await this.graph.subscribeApp(wabaId, creds.accessToken);
      } catch (e) {
        subscribed = false;
        this.log.warn(`reconnect: subscribed_apps refused for channel ${row.id}: code=${(e as MetaGraphError).code ?? "-"}`);
      }
    }
    return this.prisma.channel.update({
      where: { id: row.id },
      data: subscribed
        ? { status: "active", statusReason: null, disconnectedAt: null }
        : { status: "error", statusReason: META_SUBSCRIBE_FAILED, disconnectedAt: null, isDefault: false },
    });
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /** Register (PIN stored first, then reused), subscribe, activate. */
  private async registerRow(row: Channel, token: string, wabaId: string): Promise<Channel> {
    const secrets = storedSecrets(row);
    let pin = secrets.registrationPin;
    if (!pin) {
      pin = generatePin();
      // A linked legacy slot keeps its token on the Integration: store the PIN only.
      const keep = row.integrationId ? { registrationPin: pin } : { ...secrets, registrationPin: pin };
      await this.prisma.channel.update({ where: { id: row.id }, data: { secretsEnc: encryptChannelSecrets(keep) } });
    }
    const fail = async (step: Step, reason: string, e: unknown) => {
      await this.prisma.channel.update({ where: { id: row.id }, data: { statusReason: reason } });
      this.realtime.emitToWorkspace(row.workspaceId, "channels.updated", { channelId: row.id });
      return landlineError(step, e);
    };
    try {
      await this.graph.register(row.externalId!, token, pin);
    } catch (e) {
      throw await fail("register", META_REGISTER_FAILED, e);
    }
    try {
      await this.graph.subscribeApp(wabaId, token);
    } catch (e) {
      throw await fail("register", META_SUBSCRIBE_FAILED, e);
    }
    // Done: attach like the FINISH signup (m2). A workspace's first WhatsApp
    // number becomes the legacy Integration (template submit, status and
    // test-send read it), and this row becomes its slot; a later number stays
    // channel-only. Either way `verification` is cleared and the row active.
    const { channel } = await attachMetaNumber(this.prisma, row.workspaceId, {
      phoneNumberId: row.externalId!,
      wabaId,
      accessToken: token,
      displayName: row.displayName,
      displayPhoneNumber: row.phoneNumber,
      verifiedName: null,
      registrationPin: pin,
      status: "active",
      statusReason: null,
      verification: null,
      verifyToken: `aram-wa-${randomBytes(6).toString("hex")}`,
    });
    return channel;
  }

  /** The row in one of `stages`, with the token and WABA the steps need. */
  private async load(workspaceId: string, id: string, stages: VerificationStage[]) {
    const row = await this.prisma.channel.findFirst({ where: { id, workspaceId } });
    if (!row) throw channelError("channels.not_found");
    const verification = verificationOf(row);
    const stage = verification?.stage ?? null;
    const metaWhatsapp = row.kind === "whatsapp" && !NOT_META.includes(row.provider);
    if (!metaWhatsapp || row.status === "disconnected" || !verification || !stages.includes(verification.stage)) {
      throw channelError("channels.landline_wrong_state", { stage });
    }
    if (verification.stage !== "needs_number" && !row.externalId) {
      throw channelError("channels.landline_wrong_state", { stage });
    }
    const creds = await credentialsFor(this.prisma, row);
    const wabaId = await this.wabaIdOf(row);
    if (!creds.accessToken || !wabaId) throw channelError("channels.not_connected");
    return { row, verification, token: creds.accessToken, wabaId };
  }

  /** config.wabaId, else the legacy Integration's raw.wabaId. */
  private async wabaIdOf(row: Channel): Promise<string | null> {
    const own = objectConfig(row.config).wabaId;
    if (typeof own === "string" && own) return own;
    if (!row.integrationId) return null;
    const integ = await this.prisma.integration.findFirst({ where: { id: row.integrationId }, select: { raw: true } });
    try {
      const w = JSON.parse(integ?.raw ?? "{}")?.wabaId;
      return typeof w === "string" && w ? w : null;
    } catch {
      return null;
    }
  }

  private changed(row: Channel): ChannelDto {
    this.realtime.emitToWorkspace(row.workspaceId, "channels.updated", { channelId: row.id });
    return toChannelDto(row);
  }
}
