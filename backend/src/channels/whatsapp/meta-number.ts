import { randomInt } from "node:crypto";
import { Prisma, type Channel } from "@prisma/client";
import type { PrismaService } from "../../prisma/prisma.service";
import { decryptSecret, encryptSecret } from "../../common/token-crypto";
import { channelError } from "../channel-errors";
import { encryptChannelSecrets, type ChannelSecrets } from "../channel-credentials";
import { alignLegacyChannel, ensureDefaultPerKind, isUniqueViolation, type IntegrationLike } from "../legacy-mirror";

/**
 * SP-19 T4 — one place that attaches a Meta WhatsApp number to a workspace,
 * shared by the embedded signup and the old manual connect (ruling 4):
 *  - no WhatsApp Integration yet → the number becomes the legacy Integration
 *    (exactly what `main` writes, so its template / status / test-send paths
 *    keep working) and its mirrored channel;
 *  - the Integration already holds this number → refresh it in place;
 *  - the Integration holds ANOTHER number (or is a Zernio row) → the new
 *    number is a channel-only row with its token in `secretsEnc`. The first
 *    number and its Integration are never touched.
 */

/** Integration.provider values that are not "our own Meta app". */
export const NOT_META = ["zernio", "telegram", "native"];
/** A number in these states belongs to its workspace (connected_elsewhere). */
const LIVE = ["active", "needs_attention"];

/** statusReason values the WhatsApp flows write. */
export const META_REGISTER_FAILED = "meta_register_failed";
export const META_SUBSCRIBE_FAILED = "meta_subscribe_failed";

export type VerificationStage = "needs_number" | "awaiting_code" | "needs_registration";
export interface Verification {
  stage: VerificationStage;
  /** ISO time before which another request_code is refused (60 s cooldown). */
  resendAt?: string;
  method?: "SMS" | "VOICE";
  verifiedAt?: string;
}

/** A random 6-digit two-step PIN for `/register`. */
export function generatePin(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/** "+962 7 9000 0001" → "+962790000001"; null when there are no digits. */
export function toE164(display: string | null | undefined): string | null {
  const digits = (display ?? "").replace(/\D/g, "");
  return digits ? `+${digits}` : null;
}

export function objectConfig(config: unknown): Record<string, unknown> {
  return config && typeof config === "object" && !Array.isArray(config) ? { ...(config as Record<string, unknown>) } : {};
}

export function verificationOf(row: Pick<Channel, "config">): Verification | null {
  const v = objectConfig(row.config).verification;
  if (!v || typeof v !== "object") return null;
  const stage = (v as { stage?: unknown }).stage;
  return stage === "needs_number" || stage === "awaiting_code" || stage === "needs_registration" ? (v as Verification) : null;
}

/**
 * The secrets stored on the row itself, read regardless of an Integration
 * link (a legacy slot keeps its token on the Integration but its PIN here).
 * Unreadable or absent → {}. Never logs anything.
 */
export function storedSecrets(row: Pick<Channel, "secretsEnc"> | null | undefined): ChannelSecrets {
  if (!row?.secretsEnc) return {};
  try {
    const parsed = JSON.parse(decryptSecret(row.secretsEnc)) as ChannelSecrets;
    const out: ChannelSecrets = {};
    for (const k of ["accessToken", "botToken", "registrationPin"] as const) {
      if (typeof parsed?.[k] === "string" && parsed[k]) out[k] = parsed[k];
    }
    return out;
  } catch {
    return {};
  }
}

/** R5 pre-flight: throws 400 channels.encryption_unavailable in production
 *  without TOKEN_ENC_KEY, before anything irreversible (a spent signup code). */
export function assertSecretsStorable(): void {
  encryptChannelSecrets({});
}

/** This workspace's Meta WhatsApp row for a phone number id, any status. */
export async function findMetaNumber(prisma: PrismaService, workspaceId: string, phoneNumberId: string): Promise<Channel | null> {
  return prisma.channel.findFirst({
    where: { workspaceId, kind: "whatsapp", externalId: phoneNumberId, provider: { notIn: NOT_META } },
    orderBy: { updatedAt: "desc" },
  });
}

/** Whether attaching `phoneNumberId` takes a new slot of the plan limit. */
export async function addsWhatsappSlot(prisma: PrismaService, workspaceId: string, phoneNumberId: string): Promise<boolean> {
  const row = await findMetaNumber(prisma, workspaceId, phoneNumberId);
  return !row || row.status === "disconnected";
}

/** 409 channels.connected_elsewhere when another workspace has this number
 *  live as a channel. Cross-tenant read, so it goes through `prisma.raw`. */
export async function assertNotConnectedElsewhere(prisma: PrismaService, workspaceId: string, phoneNumberId: string): Promise<void> {
  const db = (prisma.raw ?? prisma) as unknown as PrismaService;
  const other = await db.channel.findFirst({
    where: {
      externalId: phoneNumberId,
      provider: { notIn: NOT_META },
      kind: "whatsapp",
      workspaceId: { not: workspaceId },
      status: { in: LIVE },
    },
    select: { id: true },
  });
  if (other) throw channelError("channels.connected_elsewhere");
}

export interface AttachMetaNumberInput {
  phoneNumberId: string;
  wabaId: string;
  accessToken: string;
  /** Label for a new row (an existing row keeps the user's name). */
  displayName: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  registrationPin?: string;
  status: "active" | "pending" | "error";
  statusReason: string | null;
  /** null removes `config.verification`. */
  verification: Verification | null;
  /** Written into a NEW legacy Integration's raw (webhook verify token). */
  verifyToken?: string;
}

export interface AttachMetaNumberResult {
  channel: Channel;
  /** true when the number is (or became) the legacy Integration. */
  legacy: boolean;
}

/**
 * Attach a Meta number (see the file comment for the three cases). Callers
 * check the plan limit first (`addsWhatsappSlot` + `assertWhatsappCapacity`).
 * Throws channels.connected_elsewhere for a channel-only number live in
 * another workspace, channels.encryption_unavailable per R5.
 */
export async function attachMetaNumber(
  prisma: PrismaService,
  workspaceId: string,
  a: AttachMetaNumberInput,
): Promise<AttachMetaNumberResult> {
  const integ = await prisma.integration.findFirst({ where: { workspaceId, platform: "whatsapp" } });
  const sameLegacy = !!integ && !NOT_META.includes(integ.provider) && integ.pageId === a.phoneNumberId;

  if (!integ || sameLegacy) {
    const prevRaw = parseRaw(integ?.raw ?? null);
    const data = {
      platform: "whatsapp",
      pageId: a.phoneNumberId,
      pageName: a.displayName,
      accessToken: encryptSecret(a.accessToken),
      scopes: null,
      expiresAt: null,
      raw: JSON.stringify({
        ...prevRaw,
        wabaId: a.wabaId,
        verifyToken: a.verifyToken ?? prevRaw.verifyToken,
        displayPhoneNumber: a.displayPhoneNumber,
        verifiedName: a.verifiedName,
      }),
    };
    const row = integ
      ? await prisma.integration.update({ where: { id: integ.id }, data })
      : await prisma.integration.create({ data: { ...data, workspaceId } });
    // An explicit connect: the slot is reactivated even after a disconnect.
    const slot = await alignLegacyChannel(prisma, row as IntegrationLike, { explicit: true });
    if (!slot) throw new Error(`could not mirror the WhatsApp Integration ${row.id}`);
    // The token lives on the Integration; the row keeps only its PIN.
    const pin = a.registrationPin ?? storedSecrets(slot).registrationPin;
    const channel = await finish(prisma, slot, a, pin ? { registrationPin: pin } : null);
    return { channel, legacy: true };
  }

  await assertNotConnectedElsewhere(prisma, workspaceId, a.phoneNumberId);
  const existing = await findMetaNumber(prisma, workspaceId, a.phoneNumberId);
  const secrets: ChannelSecrets = {
    ...storedSecrets(existing),
    accessToken: a.accessToken,
    ...(a.registrationPin ? { registrationPin: a.registrationPin } : {}),
  };
  if (existing) {
    if (existing.integrationId) {
      // A stale link (the Integration moved on): refresh the token where
      // credentialsFor reads it for a linked row.
      await prisma.integration.updateMany({
        where: { id: existing.integrationId, workspaceId },
        data: { accessToken: encryptSecret(a.accessToken) },
      });
    }
    return { channel: await finish(prisma, existing, a, secrets), legacy: false };
  }
  let created: Channel;
  try {
    created = await prisma.channel.create({
      data: {
        workspaceId,
        kind: "whatsapp",
        provider: "meta",
        externalId: a.phoneNumberId,
        displayName: a.displayName,
        phoneNumber: toE164(a.displayPhoneNumber),
        status: a.status,
        statusReason: a.statusReason,
        isDefault: false,
        config: withVerification({ wabaId: a.wabaId }, a.verification) as Prisma.InputJsonValue,
        secretsEnc: encryptChannelSecrets(secrets),
      },
    });
  } catch (e) {
    // A concurrent connect of the same number won the unique index.
    if (isUniqueViolation(e)) throw channelError("channels.already_connected");
    throw e;
  }
  await ensureDefaultPerKind(prisma, workspaceId);
  return { channel: (await prisma.channel.findFirst({ where: { id: created.id, workspaceId } })) ?? created, legacy: false };
}

/** Bring an existing row (legacy slot or channel-only) to the attach result. */
async function finish(
  prisma: PrismaService,
  row: Channel,
  a: AttachMetaNumberInput,
  secrets: ChannelSecrets | null,
): Promise<Channel> {
  const data: Prisma.ChannelUpdateInput = {
    status: a.status,
    statusReason: a.statusReason,
    disconnectedAt: null,
    config: withVerification({ ...objectConfig(row.config), wabaId: a.wabaId }, a.verification) as Prisma.InputJsonValue,
  };
  const e164 = toE164(a.displayPhoneNumber);
  if (e164) data.phoneNumber = e164;
  if (secrets) data.secretsEnc = encryptChannelSecrets(secrets);
  // Only an active channel can stay the default (it is re-picked below).
  if (a.status !== "active" && row.isDefault) data.isDefault = false;
  await prisma.channel.update({ where: { id: row.id }, data });
  await ensureDefaultPerKind(prisma, row.workspaceId);
  return (await prisma.channel.findFirst({ where: { id: row.id, workspaceId: row.workspaceId } })) ?? row;
}

export function withVerification(config: Record<string, unknown>, v: Verification | null): Record<string, unknown> {
  const out = { ...config };
  if (v) out.verification = v;
  else delete out.verification;
  return out;
}

function parseRaw(raw: string | null): Record<string, unknown> & { verifyToken?: string } {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
