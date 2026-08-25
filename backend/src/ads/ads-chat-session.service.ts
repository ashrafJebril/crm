import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  PostAdsChatRequest,
  PostAdsChatResponse,
  AdsChatMessageDto,
  ListAdsChatSessionsResponse,
  GetAdsChatSessionResponse,
  AdsPendingActionDto,
} from './ads.types';
import { extractSpend, approvalWarnJod, spendWarns } from './ads-spend';
import { PrismaService } from '../prisma/prisma.service';
import { getWorkspaceContext } from '../common/workspace-context';
import {
  AdsChatService,
  AdsChatLimitError,
  type AdsChatTurn,
  type AdsChatUsage,
} from './ads-chat.service';
import { AdsWalletService, InsufficientBalanceError } from './ads-wallet.service';
import { AdsPendingActionService } from './ads-pending-action.service';
import { resolveUserMessage } from './ads-prompt-catalog';
import type { PendingProposal } from './ads-chat.service';

// Salma's timezone follows Workspace.timezone. hjz read this through a shared
// common/time-utils helper that has no CRM counterpart, so the minimal equivalent is
// inlined here: same 60s cache, same Asia/Amman fallback. Workspace is NOT a
// workspace-scoped model, so it is read through the base client (prisma.raw).
const DEFAULT_TZ = 'Asia/Amman';
const TZ_TTL_MS = 60_000;
const tzCache = new Map<string, { tz: string; expires: number }>();

async function getWorkspaceTimezone(prisma: PrismaService, workspaceId: string): Promise<string> {
  const cached = tzCache.get(workspaceId);
  if (cached && cached.expires > Date.now()) return cached.tz;
  const row = await prisma.raw.workspace.findUnique({
    where: { id: workspaceId },
    select: { timezone: true },
  });
  const tz = (row?.timezone && row.timezone.trim()) || DEFAULT_TZ;
  tzCache.set(workspaceId, { tz, expires: Date.now() + TZ_TTL_MS });
  return tz;
}

// DB role is UPPERCASE (persistence boundary); the wire/loop role is lowercase.
const toWireRole = (r: string): 'user' | 'assistant' => (r === 'ASSISTANT' ? 'assistant' : 'user');

function titleFrom(message: string): string {
  const t = message.trim().slice(0, 50);
  return t.length ? t : 'محادثة جديدة';
}

// Short, human-readable label for the workspace's wallet transaction log.
function descFrom(message: string): string {
  return message.trim().slice(0, 40);
}

function toMessageDto(m: any): AdsChatMessageDto {
  return { id: m.id, role: toWireRole(m.role), content: m.content, createdAt: m.createdAt.toISOString() };
}

function toSessionDto(s: any) {
  return { id: s.id, title: s.title, createdAt: s.createdAt.toISOString(), updatedAt: s.updatedAt.toISOString() };
}

// Map a persisted AdsPendingAction row → the wire DTO the approval card renders.
// Spend is recomputed from the RAW argsJson (budgets aren't PII); currency is null
// until STEP-5 renderers fetch the real account currency (never guessed). The
// summary was already redacted at propose time, so no PII enters the card.
function toProposalDto(row: any): AdsPendingActionDto {
  const spend = extractSpend(row.argsJson);
  const warnJod = approvalWarnJod();
  return {
    actionId: row.id,
    tool: row.tool,
    summary: row.summary,
    summaryIsPlaceholder: row.summaryIsPlaceholder,
    status: row.status,
    currency: null,
    spend: spend.map((s) => ({ field: s.field, minorValue: s.minorValue, majorEstimate: s.majorEstimate })),
    spendWarn: spendWarns(spend, warnJod),
    spendWarnThresholdJod: warnJod,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

/**
 * Persistence + orchestration for the Ads Assistant chat. Wraps AdsChatService
 * (stateless agent loop) with per-workspace history. All DB access goes through the
 * workspace-scoped client, so workspaceId is injected automatically and a
 * cross-workspace session reads back null (→ 404). By-id reads use findFirst (not
 * findUnique) so the injected workspaceId applies as a plain filter — no
 * extendedWhereUnique reliance — matching the existing CRM module precedent.
 */
@Injectable()
export class AdsChatSessionService {
  private readonly log = new Logger(AdsChatSessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chat: AdsChatService,
    private readonly wallet: AdsWalletService,
    private readonly pending: AdsPendingActionService,
  ) {}

  // Single owner-scope choke point. EVERY session query (continue, read, list)
  // ANDs `createdById: this.ownerId()` onto the workspace scope: a session is
  // private to the user who created it — its thread carries spend figures paid
  // from that user's wallet — so another ads.view user in the same workspace can't
  // read it even with the id, whether by GET or by POST-to-continue. Throws the
  // same NotFound as a missing row → no existence/ownership info leak. The next
  // session endpoint added can't forget it if it routes through here.
  private ownerId(): string {
    const userId = getWorkspaceContext()?.userId;
    if (!userId) throw new NotFoundException('Ads chat session not found');
    return userId;
  }

  async postMessage(userId: string, body: PostAdsChatRequest): Promise<PostAdsChatResponse> {
    // Resolve the user message FIRST. A promptId is looked up in the catalog
    // (unknown → 400; coming_soon → 400 PROMPT_NOT_AVAILABLE) BEFORE the wallet
    // gate — a malformed request is the client's error, not a payment one.
    const userMessage = resolveUserMessage(body);

    const db = this.prisma;
    const sessionId = body.sessionId ?? null;

    // 0) PRE-SPEND GATE — the ONLY place the overdraw loss is preventable.
    //    Refuse BEFORE any Claude call: nothing persisted, no tokens spent.
    //    hasBalance() uses the ADS_MIN_BALANCE_JOD ceiling, not `> 0`. The
    //    controller maps this typed error to HTTP 402.
    if (!(await this.wallet.hasBalance())) {
      throw new InsufficientBalanceError(await this.wallet.getBalance());
    }

    // 1) Existing session → verify ownership (workspace-scoped) + load prior turns.
    let priorTurns: AdsChatTurn[] = [];
    if (sessionId) {
      const existing = await db.adsChatSession.findFirst({
        where: { id: sessionId, deletedAt: null, createdById: this.ownerId() },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException('Ads chat session not found');
      const rows = await db.adsChatMessage.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } });
      priorTurns = rows.map((m) => ({ role: toWireRole(m.role), content: m.content }));
    }

    // 2) Loop history = prior turns + the new user message.
    const history: AdsChatTurn[] = [...priorTurns, { role: 'user', content: userMessage }];

    // Salma's timezone follows Workspace.timezone (getWorkspaceTimezone caches 60s;
    // falls back to Asia/Amman). Passed into the system prompt per request.
    const tzWorkspaceId = getWorkspaceContext()?.workspaceId;
    // Workspace is NOT a workspace-scoped model, so it is read through the base
    // client (prisma.raw); safety comes from tzWorkspaceId originating in
    // workspace-context — no ambient unscoped handle beyond this one read.
    const timezone = tzWorkspaceId ? await getWorkspaceTimezone(this.prisma, tzWorkspaceId) : 'Asia/Amman';

    // 3) Run the agent FIRST, then persist — a failed Claude call leaves no
    //    half-written session (nothing is created until we hold a reply).
    let result;
    try {
      result = await this.chat.chat(history, body.locale, timezone);
    } catch (err) {
      if (err instanceof AdsChatLimitError) {
        // Caps hit, but tokens were already spent + billed. Persist the user
        // turn + partial usage FIRST, then meter it — never drop a spend.
        await this.persist(db, userId, sessionId, userMessage, {
          reply: '',
          toolCalls: err.toolCalls,
          usage: err.usage,
        });
        await this.meter(err.usage, userMessage, this.chat.model); // separate tx; failure-isolated
        throw new ServiceUnavailableException(
          'Ads Assistant hit its per-request limit. Please try a narrower question.',
        );
      }
      throw err; // generic failure → nothing persisted → no half-written session
    }

    // 4) Success — persist the conversation FIRST (own tx), so a later debit
    //    failure can never roll back a reply the workspace already received.
    const persisted = await this.persist(db, userId, sessionId, userMessage, {
      reply: result.reply,
      toolCalls: result.toolCalls,
      usage: result.usage,
    });

    // 4b) Persist any GATED proposals as PENDING actions, linked to this session.
    //     Isolated + failure-swallowed like the debit: a proposal that fails to
    //     persist just can't be approved (its action_id 404s — fail-closed, safe),
    //     and must never roll back the reply the workspace already received.
    await this.persistProposals(userId, persisted.sessionId, result.proposals);

    // 5) DEBIT — SEPARATE tx, AFTER the conversation is durably committed.
    const balanceAfterJod = await this.meter(result.usage, userMessage, this.chat.model);

    // 6) Surface the still-open proposals for this session (PENDING + not expired) so
    //    the web renders approval cards on THIS turn — the fix for the swallow point:
    //    result.proposals used to die here. Same source + mapper as getSession, so a
    //    live card and a reloaded card are identical.
    const openProposals = await this.pending.listPendingForSession(persisted.sessionId);

    return {
      sessionId: persisted.sessionId,
      reply: result.reply,
      messages: [toMessageDto(persisted.userMsg), toMessageDto(persisted.assistantMsg)],
      balanceAfterJod,
      proposals: openProposals.map(toProposalDto),
    };
  }

  /**
   * Debit accumulated usage in its OWN transaction, AFTER persistence. Isolated
   * from the conversation write: a debit failure is logged (with workspaceId, so
   * it's findable/reconcilable) and swallowed — the spend stays in usageJson, so
   * the workspace never loses a reply they already received. Returns the balance
   * string for the UI. `model` is the model ACTUALLY used for this reply — Sonnet
   * today (callers pass this.chat.model); the cheap gate will pass its Haiku model
   * so a Haiku reply bills at Haiku's rate, never Sonnet's. Cache tokens are
   * PRICED here (ads-pricing.ts:132-135: reads 0.10x, writes 1.25x) and frozen
   * into breakdownJson — measured on row 553b62ad (2026-07-17), cacheRead's
   * 0.0040176 USD is inside the stored usdCost.
   */
  private async meter(usage: AdsChatUsage, message: string, model: string): Promise<string> {
    try {
      const { balanceAfter } = await this.wallet.debit({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        model,
        description: descFrom(message),
      });
      return balanceAfter.toFixed(4);
    } catch (e) {
      const workspaceId = getWorkspaceContext()?.workspaceId ?? 'unknown';
      this.log.error(
        `ads wallet debit failed (workspace=${workspaceId}; spend recorded in usageJson, reconcilable): ${String(e)}`,
      );
      return (await this.wallet.getBalance()).toFixed(4);
    }
  }

  // Persist gated proposals as PENDING actions. Each is independent and
  // failure-isolated: one bad row is logged (with its action_id, reconcilable) and
  // skipped, never aborting the others or the turn. createdById = the session owner
  // (proposal context); the APPROVER is recorded separately at approve time.
  private async persistProposals(userId: string, sessionId: string, proposals: PendingProposal[]): Promise<void> {
    for (const p of proposals) {
      try {
        await this.pending.propose({
          actionId: p.actionId,
          createdById: userId,
          sessionId,
          tool: p.tool,
          args: p.args,
          argsHash: p.argsHash,
          summary: p.summary,
          summaryIsPlaceholder: p.summaryIsPlaceholder,
        });
      } catch (e) {
        const workspaceId = getWorkspaceContext()?.workspaceId ?? 'unknown';
        this.log.error(`ads pending-action persist failed (workspace=${workspaceId}, action=${p.actionId}): ${String(e)}`);
      }
    }
  }

  /**
   * Item-10 UX: after an approved action executes (or is rejected), the outcome
   * lands as a NEW assistant message in the session that proposed it. The original
   * tool_result is never rewritten — it is immutable history (and the audit's
   * proof of what was proposed). Because the note is persisted as a normal
   * ASSISTANT message, it ALSO flows into priorTurns on the user's next turn, so
   * Salma knows the action ran/was refused without any extra mechanism.
   * Failure-isolated: a note that fails to write never fails the approval —
   * the approve response itself already told the approving UI the outcome.
   */
  async appendActionOutcomeNote(sessionId: string, text: string): Promise<void> {
    const db = this.prisma;
    try {
      await db.$transaction(async (tx: any) => {
        // Guard deletedAt like every read path: don't resurrect/append to a session
        // the owner deleted (the action row's TTL can outlive a session deletion).
        const touched = await tx.adsChatSession.updateMany({ where: { id: sessionId, deletedAt: null }, data: { updatedAt: new Date() } });
        if (touched.count === 0) return;
        await tx.adsChatMessage.create({ data: { sessionId, role: 'ASSISTANT', content: text } });
      });
    } catch (e) {
      const workspaceId = getWorkspaceContext()?.workspaceId ?? 'unknown';
      this.log.error(`ads action-outcome note failed (workspace=${workspaceId}, session=${sessionId}): ${String(e)}`);
    }
  }

  // One transaction: create-or-touch the session, then write the user +
  // assistant rows. workspaceId is auto-injected by the scoped client, including
  // here inside $transaction — verified Prisma 5 behavior: the tenancy extension
  // applies inside interactive transactions (create-payload injection, read
  // filters, WHERE, upsert), and fails loud with "Argument workspace is missing"
  // if the context is absent.
  private async persist(
    db: any,
    userId: string,
    sessionId: string | null,
    userMessage: string,
    assistant: { reply: string; toolCalls: unknown; usage: unknown },
  ) {
    return db.$transaction(async (tx: any) => {
      let id: string;
      if (sessionId) {
        // Ownership already verified upstream. Bump updatedAt via updateMany so
        // the injected workspaceId applies as a plain filter (no by-id update).
        await tx.adsChatSession.updateMany({ where: { id: sessionId }, data: { updatedAt: new Date() } });
        id = sessionId;
      } else {
        const created = await tx.adsChatSession.create({
          data: { createdById: userId, title: titleFrom(userMessage) },
        });
        id = created.id;
      }

      const userMsg = await tx.adsChatMessage.create({
        data: { sessionId: id, role: 'USER', content: userMessage },
      });
      const assistantMsg = await tx.adsChatMessage.create({
        data: {
          sessionId: id,
          role: 'ASSISTANT',
          content: assistant.reply,
          toolCallsJson: assistant.toolCalls,
          usageJson: assistant.usage,
        },
      });
      return { sessionId: id, userMsg, assistantMsg };
    });
  }

  async listSessions(): Promise<ListAdsChatSessionsResponse> {
    const rows = await this.prisma.adsChatSession.findMany({
      where: { deletedAt: null, createdById: this.ownerId() },
      orderBy: { updatedAt: 'desc' },
    });
    return { sessions: rows.map(toSessionDto) };
  }

  async getSession(id: string): Promise<GetAdsChatSessionResponse> {
    // Owner-scoped: workspace isolation comes from the scoped client, but the ROW is
    // ALSO filtered to the current user — ads threads carry spend figures and are
    // paid from that user's wallet, so another ads.view user in the same workspace
    // must not read them even with the id. (createdById is non-null; the audit
    // found 0 null/orphaned rows, so this hides nothing existing.)
    const session = await this.prisma.adsChatSession.findFirst({
      where: { id, deletedAt: null, createdById: this.ownerId() },
    });
    if (!session) throw new NotFoundException('Ads chat session not found');
    const rows = await this.prisma.adsChatMessage.findMany({
      where: { sessionId: id },
      orderBy: { createdAt: 'asc' },
    });
    // Session ownership verified above → safe to surface its open proposals so a
    // reload re-hydrates the approval cards instead of orphaning a waiting proposal.
    const pendingRows = await this.pending.listPendingForSession(id);
    return {
      session: toSessionDto(session),
      messages: rows.map(toMessageDto),
      pendingActions: pendingRows.map(toProposalDto),
    };
  }
}
