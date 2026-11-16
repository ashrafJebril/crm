import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { TemplatesService, type CreateTemplateInput } from "../templates/templates.service";
import { WorkflowsService } from "../workflows/workflows.service";
import {
  LIFECYCLE_CATALOG,
  LIFECYCLE_KEYS,
  MAX_RECIPIENT_USERS,
  RECIPIENT_KINDS,
  REMINDER_OFFSET_DEFAULT_MIN,
  REMINDER_OFFSET_MAX,
  REMINDER_OFFSET_MIN,
  isLifecycleKey,
  keyOfSystemKey,
  systemKeyOf,
  templateDraft,
  templateName,
  templateStepConfig,
  type LifecycleKey,
  type LifecycleLang,
} from "./lifecycle-catalog";
import { lifecycleError } from "./lifecycle-errors";

export interface TemplateVariantDto {
  templateId: string;
  name: string;
  language: string;
  status: string;
  rejectionReason: string | null;
  quality: string | null;
}

export type RecipientKind = "customer" | "assignee" | "permitted" | "members";

export interface LifecycleRowDto {
  key: LifecycleKey;
  audience: "customer" | "staff";
  setUp: boolean;
  enabled: boolean;
  workflowId: string | null;
  recipient: { kind: RecipientKind; userIds: string[] };
  offsetMinutes: number | null;
  variants: { ar: TemplateVariantDto | null; en: TemplateVariantDto | null } | null;
  blockedReason: "template_rejected" | "template_missing" | "whatsapp_not_connected" | null;
  lastSentAt: string | null;
  sent30d: number;
  /** Skipped runs of the last 30 days by reason (opted_out, channel_disconnected, …). */
  skipped30d: Record<string, number>;
}

export interface PatchLifecycleInput {
  enabled?: boolean;
  recipient?: { kind?: unknown; userIds?: unknown };
  offsetMinutes?: unknown;
}

const LANGS: LifecycleLang[] = ["ar", "en"];
/** Template statuses that block enabling (Fix and resubmit). */
const BLOCKING = new Set(["rejected", "disabled"]);
const DAY_MS = 86_400_000;

type WorkflowRow = { id: string; status: string; systemKey: string | null; triggerConfig: unknown; steps: unknown };
type TemplateRowLite = {
  id: string;
  name: string;
  lang: string;
  status: string;
  metaRejectionReason: string | null;
  quality: string | null;
};

/**
 * SP-24 lifecycle messages: a focused view over the system workflows (one per
 * catalog key, `Workflow.systemKey = "lifecycle.<key>"`). The only writer of
 * system rows. Nothing is created until Set up; a set-up message starts off.
 */
@Injectable()
export class LifecycleService {
  /** workspaceId → when Sync last reconciled templates (this process). */
  private readonly lastSynced = new Map<string, Date>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly workflows: WorkflowsService,
    private readonly templates: TemplatesService,
  ) {}

  private key(raw: string): LifecycleKey {
    if (!isLifecycleKey(raw)) throw lifecycleError("lifecycle.unknown_key");
    return raw;
  }

  /** A WhatsApp number that can send (not disconnected, not pending). */
  async whatsappConnected(workspaceId: string): Promise<boolean> {
    const ch = await this.prisma.channel.findFirst({
      where: { workspaceId, kind: "whatsapp", status: { notIn: ["disconnected", "pending"] } },
      select: { id: true },
    });
    return !!ch;
  }

  private async load(workspaceId: string, keys: readonly LifecycleKey[] = LIFECYCLE_KEYS) {
    const [workflows, templates, connected] = await Promise.all([
      this.prisma.workflow.findMany({
        where: { workspaceId, systemKey: { in: keys.map(systemKeyOf) } },
        select: { id: true, status: true, systemKey: true, triggerConfig: true, steps: true },
      }) as Promise<WorkflowRow[]>,
      this.prisma.template.findMany({
        where: { workspaceId, name: { in: keys.flatMap((k) => LANGS.map((l) => templateName(k, l))) } },
        select: { id: true, name: true, lang: true, status: true, metaRejectionReason: true, quality: true },
      }) as Promise<TemplateRowLite[]>,
      this.whatsappConnected(workspaceId),
    ]);
    const wfByKey = new Map<LifecycleKey, WorkflowRow>();
    for (const w of workflows) {
      const k = keyOfSystemKey(w.systemKey);
      if (k) wfByKey.set(k, w);
    }
    const stats = await this.stats(workspaceId, workflows.map((w) => w.id));
    return { wfByKey, templates, connected, stats };
  }

  /** Sent / skipped counts from the runs of the last 30 days. */
  private async stats(workspaceId: string, workflowIds: string[]) {
    const out = new Map<string, { sent: number; lastSentAt: Date | null; skipped: Record<string, number> }>();
    if (workflowIds.length === 0) return out;
    const runs = await this.prisma.workflowRun.findMany({
      where: { workspaceId, workflowId: { in: workflowIds }, isTest: false, startedAt: { gte: new Date(Date.now() - 30 * DAY_MS) } },
      select: { workflowId: true, startedAt: true, result: true, status: true, error: true },
    });
    for (const r of runs) {
      const s = out.get(r.workflowId) ?? { sent: 0, lastSentAt: null, skipped: {} };
      const steps = Object.values((r.result ?? {}) as Record<string, Record<string, unknown> | null>);
      const skip = steps.find((x) => x && x.skipped === true);
      const sent = steps.some((x) => x && x.ok === true);
      if (sent) {
        s.sent += 1;
        if (!s.lastSentAt || r.startedAt > s.lastSentAt) s.lastSentAt = r.startedAt;
      } else if (skip) {
        const reason = String(skip.reason ?? "skipped");
        s.skipped[reason] = (s.skipped[reason] ?? 0) + 1;
      } else if (r.status === "failed") {
        s.skipped.failed = (s.skipped.failed ?? 0) + 1;
      }
      out.set(r.workflowId, s);
    }
    return out;
  }

  private variant(templates: TemplateRowLite[], key: LifecycleKey, lang: LifecycleLang): TemplateVariantDto | null {
    const t = templates.find((x) => x.name === templateName(key, lang));
    return t
      ? { templateId: t.id, name: t.name, language: lang, status: t.status, rejectionReason: t.metaRejectionReason ?? null, quality: t.quality ?? null }
      : null;
  }

  private row(key: LifecycleKey, ctx: Awaited<ReturnType<LifecycleService["load"]>>): LifecycleRowDto {
    const def = LIFECYCLE_CATALOG[key];
    const wf = ctx.wfByKey.get(key) ?? null;
    const variants =
      def.audience === "customer" ? { ar: this.variant(ctx.templates, key, "ar"), en: this.variant(ctx.templates, key, "en") } : null;
    let blockedReason: LifecycleRowDto["blockedReason"] = null;
    if (variants) {
      if (!ctx.connected) blockedReason = "whatsapp_not_connected";
      else if (LANGS.some((l) => variants[l] && BLOCKING.has(variants[l]!.status))) blockedReason = "template_rejected";
      else if (LANGS.some((l) => !variants[l])) blockedReason = "template_missing";
    }
    const step = wf ? firstStep(wf.steps) : null;
    const recipient: LifecycleRowDto["recipient"] =
      def.audience === "customer"
        ? { kind: "customer", userIds: [] }
        : {
            kind: ((step?.config as { recipient?: RecipientKind } | undefined)?.recipient ?? "permitted") as RecipientKind,
            userIds: ((step?.config as { userIds?: string[] } | undefined)?.userIds ?? []) as string[],
          };
    const offsetMinutes =
      key === "booking_reminder"
        ? Number((wf?.triggerConfig as { offsetMinutes?: number } | null)?.offsetMinutes ?? REMINDER_OFFSET_DEFAULT_MIN)
        : null;
    const st = wf ? ctx.stats.get(wf.id) : undefined;
    return {
      key,
      audience: def.audience,
      setUp: !!wf,
      enabled: wf?.status === "active",
      workflowId: wf?.id ?? null,
      recipient,
      offsetMinutes,
      variants,
      blockedReason,
      lastSentAt: st?.lastSentAt ? st.lastSentAt.toISOString() : null,
      sent30d: st?.sent ?? 0,
      skipped30d: st?.skipped ?? {},
    };
  }

  /** `GET /lifecycle`: local rows only (no provider call). */
  async list(workspaceId: string) {
    const ctx = await this.load(workspaceId);
    return {
      rows: LIFECYCLE_KEYS.map((k) => this.row(k, ctx)),
      whatsappConnected: ctx.connected,
      lastSyncedAt: this.lastSynced.get(workspaceId)?.toISOString() ?? null,
    };
  }

  async getRow(workspaceId: string, key: LifecycleKey): Promise<LifecycleRowDto> {
    return this.row(key, await this.load(workspaceId, [key]));
  }

  /**
   * `POST /lifecycle/:key/setup`: creates the missing AR/EN templates (through
   * TemplatesService.create, which submits them on the default WhatsApp
   * number; an existing same-name template is reused, never overwritten) and
   * the system workflow as a draft. Idempotent.
   */
  async setup(workspaceId: string, rawKey: string): Promise<LifecycleRowDto> {
    const key = this.key(rawKey);
    const def = LIFECYCLE_CATALOG[key];
    if (def.audience === "customer") {
      if (!(await this.whatsappConnected(workspaceId))) throw lifecycleError("lifecycle.whatsapp_not_connected");
      const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } });
      const existing = await this.prisma.template.findMany({
        where: { workspaceId, name: { in: LANGS.map((l) => templateName(key, l)) } },
        select: { name: true },
      });
      const have = new Set(existing.map((t) => t.name));
      for (const lang of LANGS) {
        const d = templateDraft(key, lang, ws?.name ?? "");
        if (have.has(d.name)) continue;
        const input: CreateTemplateInput = {
          name: d.name,
          lang: d.lang,
          category: d.category,
          body: d.body,
          footer: d.footer,
          bodyExamples: d.bodyExamples,
        };
        await this.templates.create(workspaceId, input);
      }
    }
    const sk = systemKeyOf(key);
    const wf = await this.prisma.workflow.findFirst({ where: { workspaceId, systemKey: sk }, select: { id: true } });
    if (!wf) {
      await this.workflows.upsertSystemWorkflow(workspaceId, sk, {
        name: def.name,
        triggerType: def.triggerType,
        triggerConfig: def.triggerConfig,
        steps: defaultSteps(key),
      });
    }
    return this.getRow(workspaceId, key);
  }

  /** `PATCH /lifecycle/:key`. */
  async patch(workspaceId: string, rawKey: string, dto: PatchLifecycleInput): Promise<LifecycleRowDto> {
    const key = this.key(rawKey);
    const def = LIFECYCLE_CATALOG[key];
    const wf = (await this.prisma.workflow.findFirst({
      where: { workspaceId, systemKey: systemKeyOf(key) },
      select: { id: true, status: true, systemKey: true, triggerConfig: true, steps: true },
    })) as WorkflowRow | null;

    // Validate everything before writing anything.
    let offset: number | undefined;
    if (dto.offsetMinutes !== undefined) {
      const n = dto.offsetMinutes;
      if (key !== "booking_reminder" || typeof n !== "number" || !Number.isInteger(n) || n < REMINDER_OFFSET_MIN || n > REMINDER_OFFSET_MAX) {
        throw lifecycleError("lifecycle.invalid_offset", { min: REMINDER_OFFSET_MIN, max: REMINDER_OFFSET_MAX });
      }
      offset = n;
    }
    let recipient: { kind: string; userIds: string[] } | undefined;
    if (dto.recipient !== undefined) recipient = await this.validRecipient(workspaceId, def.audience, dto.recipient);
    if (!wf) throw lifecycleError("lifecycle.not_set_up");

    if (offset !== undefined || (recipient && def.audience === "staff")) {
      const triggerConfig = { ...((wf.triggerConfig ?? {}) as Record<string, unknown>), ...(offset !== undefined ? { offsetMinutes: offset } : {}) };
      const steps = recipient && def.audience === "staff" ? staffSteps(key, recipient) : wf.steps;
      await this.workflows.upsertSystemWorkflow(workspaceId, systemKeyOf(key), {
        name: def.name,
        triggerType: def.triggerType,
        triggerConfig,
        steps,
      });
    }

    if (dto.enabled === true) {
      await this.enableGate(workspaceId, key);
      await this.workflows.activate(workspaceId, wf.id);
    } else if (dto.enabled === false) {
      await this.workflows.deactivate(workspaceId, wf.id);
    }
    return this.getRow(workspaceId, key);
  }

  /** Both variants exist and neither is rejected/disabled; WhatsApp connected. */
  private async enableGate(workspaceId: string, key: LifecycleKey): Promise<void> {
    if (LIFECYCLE_CATALOG[key].audience !== "customer") return;
    if (!(await this.whatsappConnected(workspaceId))) throw lifecycleError("lifecycle.whatsapp_not_connected");
    const rows = (await this.prisma.template.findMany({
      where: { workspaceId, name: { in: LANGS.map((l) => templateName(key, l)) } },
      select: { id: true, name: true, lang: true, status: true, metaRejectionReason: true, quality: true },
    })) as TemplateRowLite[];
    for (const lang of LANGS) {
      const t = rows.find((r) => r.name === templateName(key, lang));
      if (!t) throw lifecycleError("lifecycle.template_missing", { language: lang });
      if (BLOCKING.has(t.status)) throw lifecycleError("lifecycle.template_rejected", { language: lang, reason: t.metaRejectionReason ?? null });
    }
  }

  private async validRecipient(
    workspaceId: string,
    audience: "customer" | "staff",
    raw: { kind?: unknown; userIds?: unknown },
  ): Promise<{ kind: string; userIds: string[] }> {
    const kind = raw?.kind;
    if (typeof kind !== "string" || !RECIPIENT_KINDS[audience].includes(kind)) throw lifecycleError("lifecycle.invalid_recipient");
    const ids = raw.userIds === undefined ? [] : raw.userIds;
    if (!Array.isArray(ids) || ids.length > MAX_RECIPIENT_USERS || ids.some((x) => typeof x !== "string")) {
      throw lifecycleError("lifecycle.invalid_recipient");
    }
    const unique = [...new Set(ids as string[])];
    if (kind === "members" && unique.length === 0) throw lifecycleError("lifecycle.invalid_recipient");
    if (unique.length) {
      const members = await this.prisma.workspaceMember.findMany({
        where: { workspaceId, userId: { in: unique } },
        select: { userId: true },
      });
      // One generic error: never reveals which id is foreign.
      if (members.length !== unique.length) throw lifecycleError("lifecycle.invalid_recipient");
    }
    return { kind, userIds: kind === "members" ? unique : [] };
  }

  /** `POST /lifecycle/sync`: the template reconcile `GET /templates` does. */
  async sync(workspaceId: string) {
    if (!(await this.whatsappConnected(workspaceId))) throw lifecycleError("lifecycle.whatsapp_not_connected");
    await this.templates.list(workspaceId);
    this.lastSynced.set(workspaceId, new Date());
    const { rows, lastSyncedAt } = await this.list(workspaceId);
    return { rows, lastSyncedAt };
  }
}

function firstStep(steps: unknown): { type?: string; config?: unknown } | null {
  const g = steps as { entry?: string | null; steps?: Record<string, { type?: string; config?: unknown }> } | null;
  return g?.entry && g.steps ? (g.steps[g.entry] ?? null) : null;
}

function staffSteps(key: LifecycleKey, recipient: { kind: string; userIds: string[] }) {
  return {
    entry: "notify",
    steps: {
      notify: {
        id: "notify",
        type: "notify_staff",
        config: {
          recipient: recipient.kind,
          ...(recipient.kind === "members" ? { userIds: recipient.userIds } : {}),
          messageKey: LIFECYCLE_CATALOG[key].messageKey,
        },
      },
    },
  };
}

/** The step graph a system workflow starts with. */
export function defaultSteps(key: LifecycleKey) {
  if (LIFECYCLE_CATALOG[key].audience === "staff") return staffSteps(key, { kind: "permitted", userIds: [] });
  return { entry: "send", steps: { send: { id: "send", type: "send_whatsapp_template", config: templateStepConfig(key) } } };
}
