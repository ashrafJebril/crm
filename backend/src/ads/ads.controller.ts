import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { CurrentUserId, CurrentWorkspace } from '../common/current-workspace.decorator';
import { WorkspaceRoles, WorkspaceRolesGuard } from '../common/workspace-roles.guard';
import { AdsChatSessionService } from './ads-chat-session.service';
import { AdsPendingActionService } from './ads-pending-action.service';
import { ADS_PROMPTS, ADS_TIPS } from './ads-prompt-catalog';
import { AdsWalletService } from './ads-wallet.service';
import { AdsChatOverloadedError } from './ads-chat.service';
import { AdsInsufficientBalanceException } from './ads.exceptions';
import { PAYMENT_GATEWAY } from './payment-gateway.port';
import type { PaymentGatewayPort } from './payment-gateway.port';
import { ADS_TOPUP_MAX_JOD } from './ads.types';
import type { GetAdsPromptsResponse, PostAdsChatRequest } from './ads.types';
import { PostAdsChatDto, PostAdsTopupDto } from './ads.dto';

// After a create_* executes, Pipeboard returns { id: "<new entity id>" } (measured).
// Surface it in the outcome note so Salma (next turn) can ACT on what she just made —
// e.g. activate the campaign she just created. Without it she only knows the name and
// has to guess the id (measured failure: she passed campaign_name → the update failed).
function createdIdLine(tool: string, result: unknown): string {
  const id = (result as { id?: unknown } | null | undefined)?.id;
  if (id == null) return '';
  const label =
    tool === 'create_campaign' ? 'معرّف الحملة'
      : tool === 'create_adset' ? 'معرّف المجموعة الإعلانية'
        : tool === 'create_ad' ? 'معرّف الإعلان'
          : tool === 'create_ad_creative' ? 'معرّف التصميم'
            : 'المعرّف';
  return `\n🆔 ${label} (id): ${String(id)}`;
}

// Post-flush error → { code, message } for an SSE `event: error`. The headers are
// already sent by then, so we can no longer throw an HTTP status; instead we hand
// the web the SAME `code` the HTTP exception filter would have produced, so its
// existing post.error.code branches (ADS_SERVICE_BUSY / PROMPT_NOT_AVAILABLE) light
// up unchanged. Anything unclassified is a generic 'ERROR' whose message the web
// surfaces (e.g. the per-request-limit ServiceUnavailableException text).
function sseErrorPayload(e: unknown): { code: string; message: string } {
  if (e instanceof AdsChatOverloadedError) {
    return { code: 'ADS_SERVICE_BUSY', message: 'Ads Assistant is temporarily busy' };
  }
  if (e instanceof HttpException) {
    const resp = e.getResponse();
    const code =
      resp && typeof resp === 'object' && 'code' in resp
        ? String((resp as { code: unknown }).code)
        : 'ERROR';
    return { code, message: e.message || 'error' };
  }
  return { code: 'ERROR', message: e instanceof Error ? e.message : 'error' };
}

/**
 * Ads Assistant HTTP surface. The global AuthGuard (JWT) already protects every
 * route here — nothing is @Public() in this controller.
 *
 * hjz gated each handler with @RequiresPermission('ads.view' | 'ads.connect');
 * the CRM has no permission catalog, so the mapping is:
 *  - chat / wallet / prompts / sessions → any authenticated workspace member
 *    (hjz's ads.view — "access IS authority", one tier: whoever can open the
 *    assistant can approve its proposals),
 *  - wallet/topup + actions/:id/approve|reject → WorkspaceRolesGuard
 *    ('owner','admin'), the CRM equivalent of hjz's owner-level ads.connect for
 *    money/write paths.
 *
 * Every handler takes @CurrentWorkspace() even where the body never reads it:
 * the decorator 401s a workspace-less JWT BEFORE the handler reaches a
 * workspace-scoped service, which would otherwise surface as a deeper 500 from
 * the tenancy extension. The services themselves resolve the workspace from the
 * AsyncLocalStorage context WorkspaceInterceptor opens per request (that is why
 * they take no workspaceId argument), so the parameter is a gate, not data.
 */
@Controller('ads')
export class AdsController {
  constructor(
    private readonly sessions: AdsChatSessionService,
    private readonly wallet: AdsWalletService,
    private readonly pending: AdsPendingActionService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGatewayPort,
  ) {}

  // Streams over SSE. A creative-analysis turn can run ~90s inside chat(); a
  // buffered POST goes byte-silent and the platform proxy kills the idle
  // connection at ~60s. Streaming + a 15s heartbeat keeps it alive; a single
  // terminal event carries the byte-identical PostAdsChatResponse (`done`) or an
  // error `code` (`error`).
  @Post('chat')
  async postMessage(
    @Body() body: PostAdsChatDto,
    @CurrentWorkspace() _workspaceId: string,
    @CurrentUserId() userId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // ── PRE-FLUSH gates: must throw an HTTP status BEFORE a single byte is sent ──
    // class-validator (400) already ran in the global pipe, but it cannot express
    // hjz's cross-field zod `.refine()` — so the exactly-one-of rule runs here,
    // still before the wallet gate: a malformed request is the client's 400, never
    // a payment error. Exactly-one (not at-least-one) so sending both can never
    // silently drop the typed message.
    const provided = (body.message?.trim() ? 1 : 0) + (body.promptId ? 1 : 0);
    if (provided !== 1) {
      throw new BadRequestException('provide exactly one of message or promptId');
    }
    // zod applied `.default('ar')` inside the request schema; the DTO leaves
    // locale optional, so the default is substituted here instead.
    const request: PostAdsChatRequest = { ...body, locale: body.locale ?? 'ar' };

    // The balance gate (402) has to stay an HTTP status too — the web reads
    // post.error.status === 402 to show the top-up card — so pre-check it HERE,
    // before the stream opens. postMessage re-checks the same gate internally;
    // the duplicate read is harmless and keeps postMessage untouched.
    if (!(await this.wallet.hasBalance())) throw new AdsInsufficientBalanceException();

    // ── Open the SSE stream ─────────────────────────────────────────────────────
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx/proxy buffering for SSE
    res.flushHeaders?.();
    res.write(': connected\n\n');

    // 15s heartbeat keeps the proxy/LB from killing the idle socket while chat()
    // runs; cleared in finally (and on client disconnect) so it never leaks.
    const heartbeat = setInterval(() => {
      try { res.write(':\n\n'); } catch { /* socket gone; close handler clears this */ }
    }, 15_000);
    req.on('close', () => clearInterval(heartbeat));

    try {
      // UNCHANGED: same call, same return shape, same server-side session-save.
      const result = await this.sessions.postMessage(userId, request);
      // Final event = byte-identical PostAdsChatResponse (the 90s-timeout reply,
      // if any, rides here as a normal reply — chat() surfaces it as text, not an error).
      res.write(`event: done\ndata: ${JSON.stringify(result)}\n\n`);
    } catch (e) {
      // POST-FLUSH: headers are already sent, so we CANNOT throw an HTTP status.
      // Emit an SSE error event carrying the same { code } the HTTP exception would
      // have, then close. Never throw after flush.
      res.write(`event: error\ndata: ${JSON.stringify(sseErrorPayload(e))}\n\n`);
    } finally {
      clearInterval(heartbeat);
      try { res.end(); } catch { /* already closed */ }
    }
  }

  @Get('wallet')
  getWallet(@CurrentWorkspace() _workspaceId: string) {
    return this.wallet.getWallet();
  }

  // Starter prompt catalog + tips. Both languages per entry; the web renders per
  // locale and locks coming_soon rows. Static — no provider call.
  @Get('prompts')
  getPrompts(@CurrentWorkspace() _workspaceId: string): GetAdsPromptsResponse {
    return { prompts: ADS_PROMPTS, tips: ADS_TIPS };
  }

  // Owner-level: spending money. hjz used ads.connect (NOT ads.view) — the CRM
  // equivalent is the owner/admin workspace role.
  @Post('wallet/topup')
  @UseGuards(WorkspaceRolesGuard)
  @WorkspaceRoles('owner', 'admin')
  async topup(@CurrentWorkspace() workspaceId: string, @Body() body: PostAdsTopupDto) {
    // STRUCTURAL rules ported from postAdsTopupRequestSchema, which ran in hjz's
    // request pipe. class-validator has no decimals check, so they run here:
    //  - ≤2 decimals: JOD is a THREE-decimal Stripe currency and Stripe requires
    //    the minor-unit amount to be a multiple of 10 (thousandths digit 0);
    //    ≤2 decimals guarantees it (× 1000 = cents × 10). The regex also rejects
    //    exponential notation, which String() would emit for extreme values.
    //  - a sane absolute max: a runaway-value guard, not policy.
    const amountJod = String(body.amountJod);
    if (!/^\d+(\.\d{1,2})?$/.test(amountJod)) {
      throw new BadRequestException('amountJod must have at most 2 decimal places');
    }
    if (body.amountJod > ADS_TOPUP_MAX_JOD) {
      throw new BadRequestException(`amountJod must not exceed ${ADS_TOPUP_MAX_JOD} JOD`);
    }

    // Business floor — the ONLY lower bound, and env-configurable in BOTH
    // directions (default 5). Stripe's fixed fee makes tiny top-ups uneconomic.
    // Lives here (not in ads.types.ts) because env can't be read from the
    // isomorphic schema; keeping it single-source means ADS_MIN_TOPUP_JOD=3
    // genuinely lowers it and =10 genuinely raises it.
    const floor = Number(process.env.ADS_MIN_TOPUP_JOD ?? '5');
    if (body.amountJod < floor) {
      throw new BadRequestException(`الحد الأدنى للشحن هو ${floor} د.أ`);
    }

    // MUST be set in staging/prod to the deployed web origin. The localhost
    // default is DEV ONLY — without it, Stripe redirects the user's browser to
    // localhost after paying. `#/ads?...` because the CRM web is a HASH router.
    const base = process.env.ADS_PUBLIC_WEB_URL ?? 'http://localhost:5174';
    const { checkoutUrl } = await this.gateway.createTopupCheckout({
      workspaceId,
      // The port takes a decimal STRING (Stripe amounts are exact); `amountJod`
      // is already the 2-decimal-verified rendering of the JSON number.
      amountJod,
      successUrl: `${base}/#/ads?topup=success`,
      cancelUrl: `${base}/#/ads?topup=cancel`,
    });

    // ⚠️ Creates a Checkout Session ONLY. NOTHING is credited here — the balance
    // does not move. AdsWalletService.credit() is reachable ONLY from the
    // signature-verified Stripe webhook (ads-webhook.controller.ts); a
    // created-but-unpaid session must never touch the wallet.
    return { checkoutUrl };
  }

  // The ONLY path that executes a gated (write) action. NO request body is read:
  // approval IS this authenticated POST, so any "approved" flag a client or the
  // model might supply is ignored by construction. hjz gated this with ads.view —
  // access IS authority (Feras 2026-07-17): whoever can open the assistant can
  // approve its proposals. The CRM tightens that to owner/admin because it has no
  // per-permission catalog and the coarsest honest equivalent of "can spend the
  // workspace's ad budget" is the same role that can top the wallet up. Executed
  // exactly once, idempotent by id, inside AdsPendingActionService. On first
  // execution the outcome is appended to the proposing chat session as a new
  // assistant message — only on 'executed', so an idempotent replay can't
  // duplicate it.
  @Post('actions/:id/approve')
  @UseGuards(WorkspaceRolesGuard)
  @WorkspaceRoles('owner', 'admin')
  async approveAction(
    @CurrentWorkspace() _workspaceId: string,
    @CurrentUserId() userId: string,
    @Param('id') id: string,
  ) {
    const res = await this.pending.approveAndExecute(id, userId);
    if (res.status === 'executed' && res.sessionId) {
      await this.sessions.appendActionOutcomeNote(
        res.sessionId,
        `✅ تمت الموافقة على الإجراء وتم تنفيذه:\n${res.summary}${createdIdLine(res.tool, res.result)}`,
      );
    }
    return res;
  }

  // Rejection. Same guard as approve (declining is strictly safer than approving).
  // Body-less like approve. Nothing executes; the proposing session gets a note so
  // the thread (and Salma, next turn) knows the proposal was declined instead of
  // silently pending forever.
  @Post('actions/:id/reject')
  @UseGuards(WorkspaceRolesGuard)
  @WorkspaceRoles('owner', 'admin')
  async rejectAction(
    @CurrentWorkspace() _workspaceId: string,
    @CurrentUserId() userId: string,
    @Param('id') id: string,
  ) {
    const res = await this.pending.reject(id, userId);
    if (res.status === 'rejected' && res.sessionId) {
      await this.sessions.appendActionOutcomeNote(
        res.sessionId,
        `🚫 تم رفض الإجراء المقترح (${res.tool}) — لن يُنفَّذ.`,
      );
    }
    return res;
  }

  @Get('chat/sessions')
  listSessions(@CurrentWorkspace() _workspaceId: string) {
    return this.sessions.listSessions();
  }

  @Get('chat/sessions/:id')
  getSession(@CurrentWorkspace() _workspaceId: string, @Param('id') id: string) {
    return this.sessions.getSession(id);
  }
}
