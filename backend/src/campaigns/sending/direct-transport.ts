import { HttpException } from "@nestjs/common";
import { LAUNCH_UNCONFIRMED, providerFailure } from "../tracking/failure-codes";
import type { LaunchJob } from "./launch-context";
import type { PartitionRow } from "./broadcast-transport";

/** Zernio keeps an Idempotency-Key 24 h; past 23 h an unconfirmed attempt is never re-sent. */
export const DIRECT_GIVE_UP_MS = 23 * 3_600_000;
/** This many identical rejections in a row mean the problem is not the recipients (m1). */
export const DIRECT_REJECT_STREAK_MAX = 20;

/** The Idempotency-Key of one recipient row (stable across retries and resumes). */
export const directIdempotencyKey = (rowId: string) => `crm-cr-${rowId}`;

const statusOf = (e: unknown) => (e instanceof HttpException ? e.getStatus() : null);

/** Zernio refused this one message (bad number, bad parameter): the row fails, the job goes on. */
const isRowRejection = (e: unknown) => [400, 422].includes(statusOf(e) ?? 0);

/**
 * Fix round 1 (m1): a 4xx that is about the account or the template, not
 * the recipient (revoked or blocked number, auth, missing or paused
 * template). The first one fails the job instead of failing every row.
 */
const ACCOUNT_WIDE =
  /whatsapp (connection|account)|removed by meta|reconnect whatsapp|unauthori[sz]ed|forbidden|access token|template[^.]*(not found|does not exist|paused|disabled|not approved)|(number|account|phone)[^.]*(blocked|banned|restricted|revoked|disabled)/i;
export const isAccountWideRejection = (e: unknown) => isRowRejection(e) && ACCOUNT_WIDE.test((e as Error).message ?? "");

export interface DirectContext {
  template: { name: string; lang: string };
  /** Resolved once per partition and stored (`variables.__headerLink`), so the body never changes across retries. */
  headerMedia?: { link: string };
}

/**
 * One direct batch: every queued row of the partition, one
 * `POST /inbox/conversations` each, in id order.
 * - A row is claimed (`sendAttemptedAt`, compare-and-set on a null value)
 *   before its send, and sent with `Idempotency-Key: crm-cr-<rowId>` and a
 *   body that is byte-identical on every retry (fix round 1, I4).
 * - The returned message id is stamped as `messageId` with status `sent`,
 *   even when a cancel landed meanwhile (m2), so SP-12's tracker matches
 *   the webhooks at once. Each stamp is durable progress (I3).
 * - On resume, a claimed row without `messageId` is re-sent with the SAME
 *   key while the attempt is under 23 h old (Zernio replays the original
 *   response); past that, or when Zernio answers 409/422 for that key, it is
 *   marked `failed` `launch:unconfirmed` and never re-sent.
 * - A rejection of one row (400/422) fails that row; an account-wide one,
 *   or DIRECT_REJECT_STREAK_MAX identical ones in a row, fails the job (m1).
 * Sends pass the campaign bucket and the stricter direct bucket.
 */
export async function sendDirectPartition(job: LaunchJob, p: PartitionRow, ctx: DirectContext): Promise<void> {
  const { prisma, zernio } = job;
  const ws = job.workspaceId;
  const resolve = async (id: string, data: Record<string, unknown>) => {
    await job.fence({ progress: true });
    await prisma.campaignRecipient.updateMany({ where: { id, workspaceId: ws, status: "queued", messageId: null }, data });
  };
  let cursor: string | null = null;
  for (;;) {
    const rows = (await prisma.campaignRecipient.findMany({
      where: {
        workspaceId: ws,
        campaignId: job.campaignId,
        broadcastId: p.id,
        status: "queued",
        messageId: null,
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: job.directPageSize,
      select: { id: true, phone: true, templateParams: true, sendAttemptedAt: true },
    })) as Array<{ id: string; phone: string; templateParams: unknown; sendAttemptedAt: Date | null }>;
    if (rows.length === 0) break;
    for (const r of rows) {
      cursor = r.id;
      const prior = !!r.sendAttemptedAt;
      if (r.sendAttemptedAt && job.now() - r.sendAttemptedAt.getTime() >= DIRECT_GIVE_UP_MS) {
        await resolve(r.id, { status: "failed", failureCode: LAUNCH_UNCONFIRMED });
        continue;
      }
      if (!prior) {
        await job.fence();
        const claim = await prisma.campaignRecipient.updateMany({
          where: { id: r.id, workspaceId: ws, status: "queued", messageId: null, sendAttemptedAt: null },
          data: { sendAttemptedAt: new Date(job.now()) },
        });
        if (claim.count === 0) continue;
      }
      let res: { messageId: string | null };
      try {
        res = await job.call(
          () =>
            zernio.sendTemplateToPhone({
              accountId: p.accountId,
              phone: r.phone,
              templateName: ctx.template.name,
              templateLanguage: ctx.template.lang,
              templateParams: Array.isArray(r.templateParams) ? (r.templateParams as string[]) : [],
              ...(ctx.headerMedia ? { headerMedia: ctx.headerMedia } : {}),
              idempotencyKey: directIdempotencyKey(r.id),
            }),
          { direct: true },
        );
      } catch (e) {
        // I4: the key was used before; Zernio would not replay it. The first
        // attempt may well have been delivered, so never re-send: unconfirmed.
        if (prior && [409, 422].includes(statusOf(e) ?? 0)) {
          await resolve(r.id, { status: "failed", failureCode: LAUNCH_UNCONFIRMED });
          continue;
        }
        if (!isRowRejection(e) || isAccountWideRejection(e)) throw e;
        const message = (e as Error).message;
        job.rejectStreak.count = job.rejectStreak.message === message ? job.rejectStreak.count + 1 : 1;
        job.rejectStreak.message = message;
        await resolve(r.id, { status: "failed", ...providerFailure(message, null, null) });
        if (job.rejectStreak.count >= DIRECT_REJECT_STREAK_MAX) throw e;
        continue;
      }
      job.rejectStreak.count = 0;
      job.rejectStreak.message = null;
      // m2: the message went out; record it even if a cancel landed meanwhile.
      await job.fence({ allowCancel: true, progress: true });
      await prisma.campaignRecipient.updateMany({
        where: { id: r.id, workspaceId: ws, status: "queued" },
        data: { status: "sent", messageId: res.messageId, sentAt: new Date(job.now()) },
      });
    }
    await job.yieldTick();
  }
  await job.updatePartition(p.id, { stage: "sent" });
  p.stage = "sent";
}
