/**
 * SP-20 guided onboarding (ruling 5): business name → website → the
 * assistant reads the site (an SP-21 website source) → a "What I learned"
 * card → try the agent → live. Skippable and resumable on any device.
 *
 *  - Only workspaces whose onboarding was started (signup, or the "Set up your
 *    agent" card) ever have a state; `null` = never shown (ruling 10).
 *  - Driving it needs `settings.update` (the routes) and being its starter
 *    while it is in progress (409 `onboarding.not_owner`); `done` is final.
 *  - Only the URL the owner typed is read, through SP-21's website crawler
 *    (same-origin pages, scope `site`, the first run capped at
 *    LEARN_PAGES_MAX pages, schedule `weekly`).
 *  - The learn card is model output: validated, capped and shown; nothing is
 *    written until the owner presses Apply, and Apply writes only the sections
 *    the owner kept, through the normal services, with the owner's
 *    permissions checked per part (knowledge.update / knowledge.create /
 *    agent.update). Services are never created (ruling 6).
 *  - State writes are serialized per workspace with an advisory lock.
 */
import { ForbiddenException, HttpException, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { PermissionService } from "../../permissions/permission.service";
import type { Viewer } from "../../permissions/visibility";
import { ClaudeService } from "../../ai/claude.service";
import { ClaudeFailure } from "../../ai/claude-errors";
import { WebsitesService } from "../../knowledge-sources/website/websites.service";
import { KnowledgeSourcesService } from "../../knowledge-sources/knowledge-sources.service";
import { LEARN_PAGES_MAX, type OnboardingStatus, type OnboardingStep } from "../agent-constants";
import { agentError } from "../agent-errors";
import { AgentSettingsService } from "../agent-settings.service";
import type { LearnCard } from "./learn-schema";
import { descriptionNodes, runLearn, type LearnPage } from "./learn";
import { assertDriver, isStuck, readState, rescue, transition, type OnboardingAction, type OnboardingState } from "./onboarding-state";

export interface OnboardingDto {
  status: OnboardingStatus;
  step: OnboardingStep;
  businessName: string | null;
  websiteUrl: string | null;
  website: { sourceId: string; status: string; pagesSynced: number } | null;
  learned: LearnCard | null;
  /** Applying the card's hours would switch the agent to working-hours mode (`within`); the UI says so. */
  hoursApplyEnablesWorkingHours: boolean;
  /** In progress but its starter left or nothing moved for 24 h: a settings.manage member may take over or reset. */
  stuck: boolean;
  /** The caller is the member driving this onboarding (review M3). */
  isStarter: boolean;
  /** The starter's name while it is in progress (others see "X is setting this up"). */
  startedByName: string | null;
  canManage: boolean;
}

export interface ApplyBody {
  description?: "replace" | "append" | "skip";
  faqs?: number[];
  hours?: boolean;
}
export interface ApplyResult {
  applied: { content: "replaced" | "appended" | "written" | "skipped"; faqsAdded: number; faqsSkipped: number; hours: boolean };
}

const errKey = (e: unknown): string | null => {
  if (!(e instanceof HttpException)) return null;
  const body = e.getResponse() as { message?: unknown };
  return typeof body?.message === "string" ? body.message : null;
};

@Injectable()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perm: PermissionService,
    private readonly claude: ClaudeService,
    private readonly websites: WebsitesService,
    private readonly knowledge: KnowledgeSourcesService,
    private readonly settings: AgentSettingsService,
  ) {}

  private async state(workspaceId: string): Promise<OnboardingState | null> {
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { onboardingState: true } });
    return readState(ws?.onboardingState);
  }

  /** Read-modify-write of the state under the workspace's onboarding lock. */
  private async mutate(workspaceId: string, fn: (s: OnboardingState | null) => OnboardingState | Promise<OnboardingState>): Promise<OnboardingState> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`onboarding:${workspaceId}`}))`;
      const ws = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { onboardingState: true } });
      const next = await fn(readState(ws?.onboardingState));
      await tx.workspace.update({ where: { id: workspaceId }, data: { onboardingState: next as unknown as Prisma.InputJsonValue } });
      return next;
    });
  }

  private async isMember(workspaceId: string, userId: string | null): Promise<boolean> {
    if (!userId) return false;
    const m = await this.prisma.workspaceMember.findFirst({ where: { workspaceId, userId }, select: { userId: true } });
    return !!m;
  }

  private async can(workspaceId: string, viewer: Viewer, permission: string): Promise<boolean> {
    return this.perm.viewerCan(workspaceId, viewer, permission);
  }

  async get(workspaceId: string, viewer: Viewer): Promise<OnboardingDto> {
    const [state, canManage] = await Promise.all([this.state(workspaceId), this.can(workspaceId, viewer, "settings.update")]);
    const hoursMode = state?.card?.hours
      ? ((await this.prisma.agentSettings.findUnique({ where: { workspaceId }, select: { hoursMode: true } }))?.hoursMode ?? "always")
      : "always";
    const stuck = state?.status === "in_progress" ? isStuck(state, new Date(), await this.isMember(workspaceId, state.startedBy)) : false;
    const starter =
      state?.status === "in_progress" && state.startedBy
        ? await this.prisma.user.findUnique({ where: { id: state.startedBy }, select: { name: true } })
        : null;
    let website: OnboardingDto["website"] = null;
    if (state?.websiteSourceId) {
      // The website source lives on l; gone (or the agent off) shows no website.
      const src = await this.knowledge.get(workspaceId, state.websiteSourceId).catch(() => null);
      if (src && src.kind === "website") {
        website = { sourceId: src.id, status: src.status, pagesSynced: src.pageCounts?.synced ?? 0 };
      }
    }
    return {
      status: state?.status ?? "not_started",
      step: state?.step ?? "business",
      businessName: state?.businessName ?? null,
      websiteUrl: state?.websiteUrl ?? null,
      website,
      learned: state?.card ?? null,
      hoursApplyEnablesWorkingHours: !!state?.card?.hours && hoursMode !== "within",
      stuck,
      isStarter: !!state?.startedBy && state.startedBy === viewer.userId,
      startedByName: starter?.name ?? null,
      canManage,
    };
  }

  async patch(
    workspaceId: string,
    viewer: Viewer,
    body: { action: OnboardingAction; step?: unknown; businessName?: unknown },
    now = new Date(),
  ): Promise<OnboardingDto> {
    if (body.action === "takeover" || body.action === "reset") {
      // Review: a stuck onboarding (starter left, or 24 h with no step) can be rescued by settings.manage.
      if (!(await this.can(workspaceId, viewer, "settings.manage"))) throw new ForbiddenException();
      const cur = await this.state(workspaceId);
      const starterIsMember = await this.isMember(workspaceId, cur?.startedBy ?? null);
      const action = body.action;
      await this.mutate(workspaceId, (s) => rescue(s, action, { userId: viewer.userId, now, starterIsMember }));
      return this.get(workspaceId, viewer);
    }
    const next = await this.mutate(workspaceId, (s) => transition(s, body.action, { userId: viewer.userId, now, step: body.step, businessName: body.businessName }));
    // The business name the owner typed names the workspace too.
    if (body.businessName !== undefined && next.businessName) {
      await this.prisma.workspace.update({ where: { id: workspaceId }, data: { name: next.businessName } });
    }
    return this.get(workspaceId, viewer);
  }

  /** Create (or reuse) the SP-21 website source for the URL the owner typed, and start its first read. */
  async website(workspaceId: string, viewer: Viewer, body: { url?: unknown }, now = new Date()): Promise<OnboardingDto> {
    assertDriver(await this.state(workspaceId), viewer.userId);
    // Review: creating a knowledge source needs knowledge.create, as Apply does.
    if (!(await this.can(workspaceId, viewer, "knowledge.create"))) throw new ForbiddenException();
    let sourceId: string;
    let url: string;
    try {
      const src = await this.websites.create(workspaceId, viewer.userId, { url: body.url, scope: "site", schedule: "weekly" }, { firstRunPageCap: LEARN_PAGES_MAX });
      sourceId = src.id;
      url = src.url ?? String(body.url);
    } catch (e) {
      if (errKey(e) !== "knowledge.website_exists") throw e;
      // The same site is already a knowledge source: reuse it.
      const checked = await this.websites.check(workspaceId, body.url);
      const { items } = await this.knowledge.list(workspaceId, { kind: "website" });
      const existing = items.find((w) => w.url === checked.normalizedUrl);
      if (!existing) throw e;
      sourceId = existing.id;
      url = existing.url ?? checked.normalizedUrl;
    }
    await this.mutate(workspaceId, (s) => {
      const cur = assertDriver(s, viewer.userId);
      return { ...cur, websiteUrl: url, websiteSourceId: sourceId, step: "learn", card: null, learnedAt: null, updatedAt: now.toISOString() };
    });
    return this.get(workspaceId, viewer);
  }

  /** The read pages of the onboarding website (from l's preview), home page first. */
  private async pages(workspaceId: string, sourceId: string): Promise<LearnPage[]> {
    const src = await this.knowledge.get(workspaceId, sourceId).catch(() => null);
    if (!src || src.kind !== "website") return [];
    const preview = await this.knowledge.preview(workspaceId, sourceId);
    const byUrl = new Map<string, string[]>();
    for (const g of preview.groups) {
      for (const it of g.items) {
        if (!it.url) continue;
        const lines = byUrl.get(it.url) ?? [];
        lines.push(g.heading ? `${g.heading}\n${it.text}` : it.text);
        byUrl.set(it.url, lines);
      }
    }
    const home = src.url ?? "";
    const urls = [...byUrl.keys()].sort((a, b) => {
      const ah = a === home ? 0 : 1;
      const bh = b === home ? 0 : 1;
      return ah - bh || a.length - b.length || a.localeCompare(b);
    });
    return urls.slice(0, LEARN_PAGES_MAX).map((url) => ({ url, text: (byUrl.get(url) ?? []).join("\n") }));
  }

  /** Build the "What I learned" card. Writes nothing but the card itself. */
  async learn(workspaceId: string, viewer: Viewer, now = new Date()): Promise<OnboardingDto> {
    const state = assertDriver(await this.state(workspaceId), viewer.userId);
    if (!state.websiteSourceId) throw agentError("onboarding.no_website");
    const pages = await this.pages(workspaceId, state.websiteSourceId);
    if (!pages.some((p) => p.text.trim())) throw agentError("onboarding.no_website");
    if (!this.claude.available()) throw agentError("onboarding.ai_unavailable");
    let card: LearnCard;
    try {
      card = await runLearn(this.claude, pages);
    } catch (e) {
      if (e instanceof ClaudeFailure) throw agentError(e.key === "ai_unavailable" ? "onboarding.ai_unavailable" : "onboarding.ai_failed");
      throw e;
    }
    await this.mutate(workspaceId, (s) => {
      const cur = assertDriver(s, viewer.userId);
      return { ...cur, card, learnedAt: now.toISOString(), updatedAt: now.toISOString() };
    });
    return this.get(workspaceId, viewer);
  }

  /** Write only the sections the owner kept, with the owner's own permissions. */
  async apply(workspaceId: string, viewer: Viewer, body: ApplyBody): Promise<ApplyResult> {
    const state = assertDriver(await this.state(workspaceId), viewer.userId);
    const card = state.card;
    if (!card) throw agentError("onboarding.not_learned");
    const description = body.description ?? "skip";
    const faqIdx = [...new Set(body.faqs ?? [])].filter((i) => Number.isInteger(i) && i >= 0 && i < card.faqs.length);
    const hours = body.hours === true && !!card.hours;
    const hasDescription = !!(card.business.descriptionEn || card.business.descriptionAr);

    // Permission per part, before anything is written.
    if (description !== "skip" && hasDescription && !(await this.can(workspaceId, viewer, "knowledge.update"))) throw new ForbiddenException();
    if (faqIdx.length && !(await this.can(workspaceId, viewer, "knowledge.create"))) throw new ForbiddenException();
    if (hours && !(await this.can(workspaceId, viewer, "agent.update"))) throw new ForbiddenException();

    let content: ApplyResult["applied"]["content"] = "skipped";
    if (description !== "skip" && hasDescription) {
      const cur = (await this.knowledge.list(workspaceId, { kind: "content" })).items[0];
      const existing = (cur?.bodyJson as { content?: unknown[] } | null)?.content;
      const empty = !cur || !(cur.body ?? "").trim() || !Array.isArray(existing) || existing.length === 0;
      const nodes =
        empty || description === "replace"
          ? descriptionNodes(card, false)
          : [...(existing as Record<string, unknown>[]), ...descriptionNodes(card, true)];
      await this.knowledge.putContent(workspaceId, viewer.userId, { bodyJson: { type: "doc", content: nodes }, version: cur?.version ?? 0 });
      content = empty ? "written" : description === "replace" ? "replaced" : "appended";
    }

    let faqsAdded = 0;
    let faqsSkipped = 0;
    for (const i of faqIdx) {
      try {
        await this.knowledge.createFaq(workspaceId, viewer.userId, card.faqs[i]);
        faqsAdded++;
      } catch (e) {
        const key = errKey(e);
        if (key !== "knowledge.faq_duplicate" && key !== "knowledge.faq_limit" && key !== "knowledge.faq_too_long") throw e;
        faqsSkipped++;
      }
    }

    if (hours) {
      const s = await this.settings.get(workspaceId);
      await this.settings.update(workspaceId, { hours: { mode: "within", schedule: card.hours as Record<string, unknown> }, version: s.version });
    }
    return { applied: { content, faqsAdded, faqsSkipped, hours } };
  }
}
