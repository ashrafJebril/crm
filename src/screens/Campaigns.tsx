import { Fragment, memo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx, type Tx } from "@/lib/tx";
import { PageHeader } from "@/components/PageHeader";
import { Badge, statusKind } from "@/components/Badge";
import { PhonePreview } from "@/components/PhonePreview";
import {
  IconCheck,
  IconChev,
  IconPlus,
} from "@/icons";
import type { Campaign, CampaignPreviewV2, CustomFieldDef, Segment, Template, VarMap } from "@/lib/types";
import { useFetch, useMutation } from "@/api/useFetch";
import { usePermissions } from "@/auth/usePermissions";
import { api } from "@/api/client";
import { useToast } from "@/components/Toast";
import { WhatsAppGate, useWhatsAppConnection } from "@/components/WhatsAppGate";
import { gatedTitle } from "@/components/whatsAppGateCopy";
import { headerKind } from "@/components/media/mediaKinds";
import { useHashParam } from "@/lib/useHashParam";
import { InlineBar, MiniStat } from "./campaigns/ui";
import { CampaignDetail } from "./campaigns/CampaignDetail";
import { campaignErrorText, campaignKeyText, cancelErrorText, lastErrorText } from "./campaigns/campaignErrors";
import { LAUNCH_POLL_MS, campaignStatusLabel } from "./campaigns/campaignDetailModel";
import {
  defaultVarMap,
  normalizeVarMap,
  placeholderCount,
  renderTemplate,
  renderWithLabels,
  templateUnsupported,
  varMapComplete,
} from "./campaigns/varMap";
import { effectiveSelection, senderText, showSendFrom } from "./campaigns/senderModel";
import { useCampaignPreview, useCustomFields, type PreviewBody } from "./campaigns/useCampaignPreview";
import { SendFromField } from "./campaigns/SendFromField";
import { VariableMappingField } from "./campaigns/VariableMappingField";
import { HEADER_MEDIA_MAX_DAYS, HeaderMediaField } from "./campaigns/HeaderMediaField";
import { ReviewSamples } from "./campaigns/ReviewSamples";
import { LaunchProgress } from "./campaigns/LaunchProgress";

type View = "list" | "builder";
type CampaignStatus = Campaign["status"];
type TabId = "all" | CampaignStatus;

const INPUT_STYLE: CSSProperties = {
  height: 32,
  padding: "0 10px",
  borderRadius: 8,
  background: "var(--bg-1)",
  border: "1px solid var(--line-soft)",
  color: "var(--ink)",
  fontSize: 13,
  outline: 0,
  fontFamily: "inherit",
};

interface FieldProps {
  label: string;
  children: ReactNode;
}

function Field({ label, children }: FieldProps) {
  return (
    <label
      style={{
        display: "grid",
        gridTemplateColumns: "180px 1fr",
        alignItems: "center",
        gap: 12,
      }}
    >
      <span style={{ fontSize: 12, color: "var(--ink-2)" }}>{label}</span>
      {children}
    </label>
  );
}

interface AudienceStepProps {
  tx: Tx;
  segments: Segment[];
  segmentId: string | null;
  onSelect: (id: string | null) => void;
  count: number;
}

function AudienceStep({ tx, segments, segmentId, onSelect, count }: AudienceStepProps) {
  const options: { id: string | null; label: string; count: number }[] = [
    { id: null, label: tx("All contacts", "كل جهات الاتصال"), count: -1 },
    ...segments.map((s) => ({ id: s.id, label: s.name, count: s.count })),
  ];
  return (
    <div className="card">
      <div className="card-h">
        <h3>{tx("Audience", "الجمهور")}</h3>
        <span className="sub mono">
          {count.toLocaleString()} {tx("contacts match", "جهة اتصال")}
        </span>
      </div>
      <div style={{ padding: 18, display: "grid", gap: 8 }}>
        {options.map((opt) => {
          const active = segmentId === opt.id;
          return (
            <label
              key={opt.id ?? "__all"}
              style={{
                display: "flex", gap: 12, padding: 12, alignItems: "center", cursor: "pointer",
                background: active ? "var(--accent-soft)" : "var(--bg-1)",
                border: `1px solid ${active ? "var(--accent-ring)" : "var(--line-soft)"}`,
                borderRadius: 10,
              }}
            >
              <input
                type="radio"
                name="audience"
                checked={active}
                onChange={() => onSelect(opt.id)}
                style={{ accentColor: "var(--accent)" }}
              />
              <span style={{ flex: 1, fontWeight: 500, fontSize: 13 }}>{opt.label}</span>
              {opt.count >= 0 && (
                <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                  {opt.count.toLocaleString()}
                </span>
              )}
            </label>
          );
        })}
        {segments.length === 0 && (
          <div className="mono muted" style={{ fontSize: 11 }}>
            {tx("No segments yet — create them in Contacts.", "لا توجد شرائح بعد — أنشئها من جهات الاتصال.")}
          </div>
        )}
      </div>
    </div>
  );
}

interface MessageStepProps {
  tx: Tx;
  templates: Template[];
  templateId: string | null;
  onSelect: (id: string | null) => void;
  varMap: VarMap;
  onVarMap: (m: VarMap) => void;
  customDefs: CustomFieldDef[] | null;
  missingByKey: CampaignPreviewV2["missingByKey"] | null;
  header: ReactNode;
}

function MessageStep({ tx, templates, templateId, onSelect, varMap, onVarMap, customDefs, missingByKey, header }: MessageStepProps) {
  return (
    <div className="card">
      <div className="card-h">
        <div>
          <h3>{tx("Message", "الرسالة")}</h3>
          <div className="sub">{tx("An approved WhatsApp template", "قالب واتساب معتمد")}</div>
        </div>
      </div>
      <div style={{ padding: 18, display: "grid", gap: 14 }}>
        <Field label={tx("Template", "القالب")}>
          <select style={INPUT_STYLE} value={templateId ?? ""} onChange={(e) => onSelect(e.target.value || null)}>
            <option value="">{tx("Select a template…", "اختر قالبًا…")}</option>
            {templates.map((t) => {
              const unsupported = templateUnsupported(t);
              return (
                <option key={t.id} value={t.id} disabled={t.status !== "approved" || unsupported}>
                  {t.name} · {t.lang.toUpperCase()}
                  {t.status !== "approved"
                    ? ` · ${tx("not approved yet", "غير معتمد بعد")}`
                    : unsupported
                      ? ` · ${tx("Not supported for campaigns yet", "غير مدعوم في الحملات بعد")}`
                      : ""}
                </option>
              );
            })}
          </select>
        </Field>

        <VariableMappingField tx={tx} value={varMap} onChange={onVarMap} customDefs={customDefs} missingByKey={missingByKey} />
        {header}

        {templates.length > 0 && !templates.some((t) => t.status === "approved") && (
          <div style={{ fontSize: 12, color: "var(--warn)" }}>
            {tx(
              "None of your templates is approved by Meta yet, so nothing can be sent. Create one in Templates and wait for approval.",
              "لا يوجد قالب معتمد من ميتا بعد، لذا لا يمكن الإرسال. أنشئ قالبًا من القوالب وانتظر الموافقة.",
            )}
          </div>
        )}
        {templates.length === 0 && (
          <div className="mono muted" style={{ fontSize: 11 }}>
            {tx("No templates with a body yet — create one in Templates.", "لا توجد قوالب بعد — أنشئ واحدًا من القوالب.")}
          </div>
        )}
      </div>
    </div>
  );
}

type ScheduleChoice = "now" | "later";

interface ScheduleStepProps {
  tx: Tx;
  choice: ScheduleChoice;
  onChoose: (c: ScheduleChoice) => void;
  when: string;
  onWhen: (v: string) => void;
  /** A campaign with its own header file can be scheduled at most 6 days ahead (ruling 9). */
  maxDays: number | null;
}

/** "YYYY-MM-DDTHH:mm" in local time, the format <input type="datetime-local"> uses. */
const toLocalInput = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function ScheduleStep({ tx, choice, onChoose, when, onWhen, maxDays }: ScheduleStepProps) {
  const options = [
    { id: "now" as const, label: tx("Send now", "إرسال الآن"), sub: tx("Starts sending as soon as you confirm", "يبدأ الإرسال فور التأكيد") },
    { id: "later" as const, label: tx("Schedule for later", "جدولة لاحقاً"), sub: tx("Pick a date and time", "اختر التاريخ والوقت") },
  ];
  return (
    <div className="card">
      <div className="card-h"><h3>{tx("Schedule", "الموعد")}</h3></div>
      <div style={{ padding: 18, display: "grid", gap: 14 }}>
        {options.map((opt) => {
          const on = choice === opt.id;
          return (
            <label
              key={opt.id}
              onClick={() => onChoose(opt.id)}
              style={{
                display: "flex", gap: 12, padding: 14, alignItems: "center", cursor: "pointer",
                background: on ? "var(--accent-soft)" : "var(--bg-1)",
                border: `1px solid ${on ? "var(--accent-ring)" : "var(--line-soft)"}`,
                borderRadius: 10,
              }}
            >
              <span style={{ width: 16, height: 16, borderRadius: "50%", border: `2px solid ${on ? "var(--accent)" : "var(--line)"}`, display: "grid", placeItems: "center" }}>
                {on && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)" }} />}
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 500 }}>{opt.label}</div>
                <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>{opt.sub}</div>
              </div>
            </label>
          );
        })}
        {choice === "later" && (
          <Field label={tx("Send at", "وقت الإرسال")}>
            <input
              type="datetime-local"
              style={INPUT_STYLE}
              value={when}
              min={toLocalInput(new Date())}
              max={maxDays ? toLocalInput(new Date(Date.now() + maxDays * 86_400_000)) : undefined}
              onChange={(e) => onWhen(e.target.value)}
            />
          </Field>
        )}
        {choice === "later" && maxDays && (
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
            {campaignKeyText("campaigns.header_media_schedule_too_far", { days: maxDays }, tx)}
          </div>
        )}
        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
          {tx(
            "To message people when something happens (a new contact, a finished appointment), use Workflows.",
            "لإرسال رسائل عند حدوث أمر ما (جهة اتصال جديدة، موعد مكتمل) استخدم الأتمتة.",
          )}
        </div>
      </div>
    </div>
  );
}

interface ReviewStepProps {
  tx: Tx;
  audienceLabel: string;
  preview: CampaignPreviewV2 | null;
  previewLoading: boolean;
  previewError: string | null;
  template: Template | null;
  scheduleLabel: string;
  senderLabel: string | null;
  samples: ReactNode;
}

function ReviewStep({ tx, audienceLabel, preview, previewLoading, previewError, template, scheduleLabel, senderLabel, samples }: ReviewStepProps) {
  const reach = preview
    ? `${preview.reachable.toLocaleString()} ${tx("of", "من")} ${preview.total.toLocaleString()} ${tx("contacts", "جهة")}`
    : previewLoading
      ? tx("Counting…", "جارٍ العد…")
      : "—";
  const sk = preview?.skipped;
  const skipped = sk ? sk.noPhone + sk.optedOut + sk.duplicate + sk.missingValue : 0;
  const rows: [string, string][] = [
    [tx("Audience", "الجمهور"), audienceLabel],
    [tx("Will receive it", "سيستلمها"), reach],
    [tx("Template", "القالب"), template ? `${template.name} · ${template.lang.toUpperCase()}` : tx("None selected", "لم يُختر")],
    ...(senderLabel ? ([[tx("Send from", "الإرسال من"), senderLabel]] as [string, string][]) : []),
    [tx("Schedule", "الموعد"), scheduleLabel],
  ];
  return (
    <div className="card">
      <div className="card-h">
        <h3>{tx("Review", "مراجعة")}</h3>
        {previewLoading && preview && <span className="sub">{tx("Updating…", "جارٍ التحديث…")}</span>}
      </div>
      <div style={{ padding: 18, display: "grid", gap: 10 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13 }}>
            <span style={{ color: "var(--ink-3)" }}>{k}</span>
            <span style={{ fontWeight: 500, textAlign: "end" }}>{v}</span>
          </div>
        ))}
        {previewError && (
          <div role="alert" style={{ fontSize: 12, color: "var(--bad)" }}>
            {previewError}
          </div>
        )}
        {sk && skipped > 0 && (
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
            {tx(
              `Left out: ${sk.noPhone} without a phone number with a country code, ${sk.optedOut} opted out, ${sk.duplicate} duplicate numbers, ${sk.missingValue} missing a value without a fallback.`,
              `مستبعدون: ${sk.noPhone} بلا رقم برمز الدولة، ${sk.optedOut} ألغوا الاشتراك، ${sk.duplicate} أرقام مكررة، ${sk.missingValue} بلا قيمة ولا بديل.`,
            )}
          </div>
        )}
        {preview && preview.reachable === 0 && (
          <div style={{ fontSize: 12, color: "var(--warn)" }}>
            {tx(
              "No one in this audience can receive it (no WhatsApp number with a country code, opted out, or a missing value without a fallback), so the campaign can't be sent.",
              "لا أحد في هذا الجمهور يمكنه استلامها (لا رقم واتساب برمز الدولة، أو ألغى الاشتراك، أو قيمة ناقصة بلا بديل)، لذا لا يمكن إرسال الحملة.",
            )}
          </div>
        )}
        {samples}
        {preview && preview.reachable > 0 && (
          <div
            style={{
              marginTop: 6, padding: 12, borderRadius: 10, fontSize: 12.5, lineHeight: 1.5,
              background: "var(--accent-soft)", border: "1px solid var(--accent-ring)", color: "var(--ink-1)",
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {tx("Estimated Meta charge", "تكلفة ميتا التقديرية")}: ≈ ${preview.estimate.usd.toFixed(2)}
              {preview.estimate.unpriced > 0 &&
                tx(` + ${preview.estimate.unpriced} numbers in other countries`, ` + ${preview.estimate.unpriced} أرقام في دول أخرى`)}
            </div>
            {tx(
              "Meta bills this directly to the card on your WhatsApp Business account (Meta Business Suite → Billing), at its marketing rate. Without a card there, Meta stops delivery. A newly connected number can reach 250 people a day at first.",
              "تحتسب ميتا هذه التكلفة مباشرة على البطاقة في حساب واتساب للأعمال (Meta Business Suite ← الفوترة) بسعر الرسائل التسويقية. بدون بطاقة هناك توقف ميتا التسليم. الرقم المتصل حديثًا يصل إلى 250 شخصًا يوميًا في البداية.",
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Draft PATCH/POST takes the varMap's shape only: slots whose fixed value is still empty are left out until filled. */
function draftVarMap(map: VarMap): VarMap {
  const out: VarMap = {};
  for (const [slot, s] of Object.entries(normalizeVarMap(map))) {
    if (s.source === "static" && !s.value) continue;
    out[slot] = s;
  }
  return out;
}

interface CampaignBuilderProps {
  tx: Tx;
  onBack: () => void;
  onDone: (message: string, openId?: string) => void;
}

function CampaignBuilder({ tx, onBack, onDone }: CampaignBuilderProps) {
  const steps = [
    { id: 1, label: tx("Audience", "الجمهور") },
    { id: 2, label: tx("Message", "الرسالة") },
    { id: 3, label: tx("Schedule", "الموعد") },
    { id: 4, label: tx("Review", "مراجعة") },
  ];
  const [step, setStep] = useState(1);

  const segmentsQ = useFetch<Segment[]>("/segments");
  const templatesQ = useFetch<Template[]>("/templates");
  const { connected, senders } = useWhatsAppConnection();
  const { defs: customDefs, labels: customLabels } = useCustomFields();

  const [name, setName] = useState("");
  const [segmentId, setSegmentId] = useState<string | null>(null); // null = all contacts
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [varMap, setVarMap] = useState<VarMap>({});
  // [] = the default number.
  const [senderIds, setSenderIds] = useState<string[]>([]);
  const [headerOverride, setHeaderOverride] = useState(false);
  const [headerMediaId, setHeaderMediaId] = useState<string | null>(null);
  const [scheduleChoice, setScheduleChoice] = useState<ScheduleChoice>("now");
  const [when, setWhen] = useState(() => toLocalInput(new Date(Date.now() + 3_600_000)));
  // A failed launch keeps its saved draft, so retrying doesn't create a second one.
  const [draftId, setDraftId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const segments = segmentsQ.data ?? [];
  const templates = (templatesQ.data ?? []).filter((t) => !!t.body);
  const selectedSegment = segments.find((s) => s.id === segmentId) ?? null;
  const audienceLabel = selectedSegment ? selectedSegment.name : tx("All contacts", "كل جهات الاتصال");
  const selectedTemplate = templates.find((t) => t.id === templateId) ?? null;
  const varCount = placeholderCount(selectedTemplate?.body);
  const hKind = headerKind(selectedTemplate);
  const mediaKind = hKind && hKind !== "text" ? hKind : null;
  const customKeys = customDefs ? new Set(customDefs.filter((d) => !d.archivedAt).map((d) => d.key)) : null;
  const mapOk = varMapComplete(varMap, varCount, customKeys);
  const useHeaderFile = !!mediaKind && headerOverride && !!headerMediaId;

  // POST /campaigns/preview: debounced, never per keystroke (it reads each sender's templates live).
  const previewBody: PreviewBody = {
    ...(segmentId ? { segmentId } : {}),
    ...(templateId ? { templateId } : {}),
    ...(senderIds.length ? { senderChannelIds: senderIds } : {}),
    ...(templateId && varCount > 0 && mapOk ? { varMap: normalizeVarMap(varMap) } : {}),
    ...(useHeaderFile ? { headerMediaId: headerMediaId! } : {}),
  };
  const preview = useCampaignPreview(previewBody);
  const pv = preview.data;
  const errCtx = { senders: senders?.senders ?? [] };
  const audienceCount = pv?.total ?? selectedSegment?.count ?? 0;

  const selectTemplate = (id: string | null) => {
    setTemplateId(id);
    const t = templates.find((x) => x.id === id);
    setVarMap(defaultVarMap(placeholderCount(t?.body)));
    setHeaderOverride(false);
    setHeaderMediaId(null);
  };

  const body = selectedTemplate?.body ?? "";
  const sample = preview.current ? pv?.samples.find((s) => !s.skippedFor) : undefined;
  const previewBody_ = selectedTemplate?.body
    ? sample
      ? renderTemplate(body, sample.values)
      : renderWithLabels(body, varMap, tx, customLabels)
    : tx("Select a template to preview it.", "اختر قالبًا للمعاينة.");
  let previewButtons: string[] = [];
  try {
    const parsed = selectedTemplate?.buttons ? JSON.parse(selectedTemplate.buttons) as { text?: string }[] : [];
    previewButtons = parsed.map((b) => b.text ?? "").filter(Boolean);
  } catch { previewButtons = []; }

  const whenDate = scheduleChoice === "later" ? new Date(when) : null;
  const maxDays = useHeaderFile ? HEADER_MEDIA_MAX_DAYS : null;
  const whenValid =
    !whenDate ||
    (!Number.isNaN(whenDate.getTime()) &&
      whenDate.getTime() > Date.now() &&
      (!maxDays || whenDate.getTime() <= Date.now() + maxDays * 86_400_000));
  const scheduleLabel =
    scheduleChoice === "now"
      ? tx("Send now", "إرسال الآن")
      : whenDate && !Number.isNaN(whenDate.getTime())
        ? whenDate.toLocaleString()
        : tx("Pick a time", "اختر الوقت");

  const sendersList = senders?.senders ?? [];
  const pickerShown = !!senders && showSendFrom(sendersList, senderIds);
  const chosen = effectiveSelection(senderIds, sendersList);
  const senderLabel = senders
    ? chosen
        .map((id) => sendersList.find((s) => s.channelId === id))
        .filter((s) => !!s)
        .map((s) => senderText(s))
        .join(", ") || null
    : null;

  const { can } = usePermissions();
  const mayLaunch = can("campaigns.manage");
  // saveDraft() PATCHes an existing draft (campaigns.update) or POSTs a new one (campaigns.create).
  const mayDraft = draftId ? can("campaigns.update") : can("campaigns.create");
  const noPerm = tx("You don't have permission to do this", "ليست لديك صلاحية للقيام بذلك");
  const gate = gatedTitle(scheduleChoice === "now" ? "campaign.launch" : "campaign.schedule", connected === false || pv?.connected === false ? false : connected, tx);
  const canLaunch =
    mayLaunch &&
    mayDraft &&
    !gate &&
    !!name.trim() &&
    selectedTemplate?.status === "approved" &&
    !templateUnsupported(selectedTemplate) &&
    mapOk &&
    whenValid &&
    (!mediaKind || !headerOverride || !!headerMediaId) &&
    preview.current &&
    !!pv &&
    pv.connected &&
    pv.reachable > 0 &&
    pv.templateMissing.length === 0 &&
    (pv.templateCheckFailed ?? []).length === 0 &&
    pv.transport.kind !== "too_varied";

  const draftBody = () => ({
    name: name.trim(),
    audience: audienceLabel,
    channel: "Broadcast",
    recipients: audienceCount,
    schedule: scheduleLabel,
    segmentId: segmentId ?? undefined,
    templateId: templateId ?? undefined,
    senderChannelIds: senderIds,
    varMap: varCount > 0 ? draftVarMap(varMap) : null,
    headerMediaId: useHeaderFile ? headerMediaId : null,
  });

  async function saveDraft(): Promise<string> {
    if (draftId) {
      await api.patch(`/campaigns/${draftId}`, draftBody());
      return draftId;
    }
    const created = await api.post<Campaign>("/campaigns", draftBody());
    setDraftId(created.id);
    return created.id;
  }

  async function onSaveDraft() {
    setBusy(true);
    setError(null);
    try {
      await saveDraft();
      onDone(tx("Draft saved", "تم حفظ المسودة"));
    } catch (e) {
      setError(campaignErrorText(e, tx, errCtx));
    } finally {
      setBusy(false);
    }
  }

  async function onLaunch() {
    setBusy(true);
    setError(null);
    try {
      const id = await saveDraft();
      // 202: the campaign is `launching`; the background job plans and sends it (the varMap is stored on the draft).
      await api.post<Campaign>(`/campaigns/${id}/launch`, {
        mode: scheduleChoice === "now" ? "now" : "schedule",
        scheduledAt: whenDate ? whenDate.toISOString() : undefined,
      });
      onDone(tx("Preparing your campaign…", "جارٍ تجهيز حملتك…"), id);
    } catch (e) {
      setError(campaignErrorText(e, tx, errCtx));
    } finally {
      setBusy(false);
    }
  }

  const headerField = mediaKind ? (
    <HeaderMediaField
      tx={tx}
      kind={mediaKind}
      value={headerMediaId}
      onChange={setHeaderMediaId}
      override={headerOverride}
      onOverride={setHeaderOverride}
    />
  ) : null;

  return (
    <div style={{ overflowY: "auto", flex: 1 }}>
      <div
        style={{
          padding: "20px 24px 0",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <button className="btn ghost icon" onClick={onBack} aria-label={tx("Back to campaigns", "العودة للحملات")}>
          <IconChev w={14} className="flip-rtl" style={{ transform: "rotate(180deg)" }} />
        </button>
        <div style={{ flex: 1 }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={tx("Campaign name", "اسم الحملة")}
            style={{
              width: "100%",
              border: 0,
              outline: 0,
              background: "transparent",
              padding: 0,
              margin: 0,
              fontSize: 20,
              fontWeight: 600,
              letterSpacing: "-0.02em",
              color: "var(--ink)",
              fontFamily: "inherit",
            }}
          />
        </div>
      </div>

      {(connected === false || pv?.connected === false) && (
        <div style={{ padding: "16px 24px 0" }}>
          <WhatsAppGate connected={false} tx={tx} />
        </div>
      )}

      <div style={{ padding: "20px 24px 0", display: "flex", gap: 8, flexWrap: "wrap" }}>
        {steps.map((s, i) => {
          const done = step > s.id;
          const active = step === s.id;
          return (
            <Fragment key={s.id}>
              <button
                onClick={() => setStep(s.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 14px",
                  borderRadius: 999,
                  background: active
                    ? "var(--accent-soft)"
                    : done
                      ? "var(--bg-2)"
                      : "transparent",
                  color: active
                    ? "var(--accent)"
                    : done
                      ? "var(--ink-1)"
                      : "var(--ink-3)",
                  border: `1px solid ${active ? "var(--accent-ring)" : "var(--line-soft)"}`,
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: 500,
                }}
              >
                <span className="mono" style={{ fontSize: 11, opacity: 0.7 }}>
                  {String(s.id).padStart(2, "0")}
                </span>
                <span>{s.label}</span>
                {done && <IconCheck w={12} />}
              </button>
              {i < steps.length - 1 && (
                <span style={{ alignSelf: "center", color: "var(--ink-4)" }}>—</span>
              )}
            </Fragment>
          );
        })}
      </div>

      <div
        style={{
          padding: 24,
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 360px",
          gap: 24,
        }}
      >
        <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
          {step === 1 && (
            <>
              <AudienceStep tx={tx} segments={segments} segmentId={segmentId} onSelect={setSegmentId} count={audienceCount} />
              {pickerShown && senders && (
                <SendFromField
                  tx={tx}
                  senders={senders}
                  value={senderIds}
                  onChange={setSenderIds}
                  audienceCount={pv && preview.current ? pv.reachable : null}
                />
              )}
            </>
          )}
          {step === 2 && (
            <MessageStep
              tx={tx}
              templates={templates}
              templateId={templateId}
              onSelect={selectTemplate}
              varMap={varMap}
              onVarMap={setVarMap}
              customDefs={customDefs}
              missingByKey={pv?.missingByKey ?? null}
              header={headerField}
            />
          )}
          {step === 3 && (
            <ScheduleStep tx={tx} choice={scheduleChoice} onChoose={setScheduleChoice} when={when} onWhen={setWhen} maxDays={maxDays} />
          )}
          {step === 4 && (
            <ReviewStep
              tx={tx}
              audienceLabel={audienceLabel}
              preview={pv}
              previewLoading={preview.loading}
              previewError={preview.error ? campaignErrorText(preview.error, tx, errCtx) : null}
              template={selectedTemplate}
              scheduleLabel={scheduleLabel}
              senderLabel={pickerShown ? senderLabel : null}
              samples={
                pv && selectedTemplate ? (
                  <ReviewSamples
                    tx={tx}
                    preview={pv}
                    body={body}
                    lang={selectedTemplate.lang}
                    varMap={varMap}
                    customLabels={customLabels}
                    senders={sendersList}
                    headerOverride={useHeaderFile}
                  />
                ) : null
              }
            />
          )}

          {error && (
            <div
              role="alert"
              style={{
                padding: 10, fontSize: 12.5, borderRadius: 8, color: "var(--bad)",
                background: "color-mix(in oklch, var(--bad) 10%, transparent)",
                border: "1px solid color-mix(in oklch, var(--bad) 35%, transparent)",
              }}
            >
              {error}
            </div>
          )}

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 8,
              paddingTop: 8,
            }}
          >
            <button
              className="btn"
              disabled={step === 1}
              onClick={() => setStep((s) => Math.max(1, s - 1))}
            >
              {tx("Back", "رجوع")}
            </button>
            {step === 4 ? (
              <div style={{ display: "flex", gap: 8 }}>
                {mayDraft && (
                  <button className="btn" disabled={!name.trim() || busy} onClick={onSaveDraft}>
                    {tx("Save draft", "حفظ مسودة")}
                  </button>
                )}
                {mayLaunch && (
                  <button
                    className="btn primary"
                    disabled={!canLaunch || busy}
                    title={!mayDraft ? noPerm : (gate ?? undefined)}
                    onClick={onLaunch}
                  >
                    {busy
                      ? tx("Working…", "جارٍ التنفيذ…")
                      : scheduleChoice === "now"
                        ? tx("Send campaign", "إرسال الحملة")
                        : tx("Schedule campaign", "جدولة الحملة")}
                  </button>
                )}
              </div>
            ) : (
              <button className="btn primary" onClick={() => setStep((s) => Math.min(4, s + 1))}>
                {tx("Continue", "متابعة")}
                <IconChev w={12} />
              </button>
            )}
          </div>
        </div>

        <PhonePreview
          body={previewBody_}
          buttons={previewButtons}
          tx={tx}
          dir={selectedTemplate?.lang === "ar" ? "rtl" : "ltr"}
          caption={sample ? tx(`Preview for ${sample.name?.trim() || "a contact"}`, `معاينة لـ ${sample.name?.trim() || "جهة اتصال"}`) : undefined}
        />
      </div>
    </div>
  );
}

/** A launching row polls its own campaign (GET /campaigns/:id carries `launch`) every 5 s. */
function LaunchingRowProgress({ id, tx }: { id: string; tx: Tx }) {
  const q = useFetch<Campaign>(`/campaigns/${encodeURIComponent(id)}`, { pollMs: LAUNCH_POLL_MS });
  if (!q.data || q.data.status !== "launching") return null;
  return <LaunchProgress tx={tx} campaign={q.data} compact />;
}

function CampaignsImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const [view, setView] = useState<View>("list");
  const [tab, setTab] = useState<TabId>("all");
  const [query, setQuery] = useState("");
  // SP-12: `#/campaigns?id=<id>` opens the report; Back (hash history) returns here.
  const [openId, setOpenId] = useHashParam("id");

  const { toast } = useToast();
  // Sending campaigns update every minute while the page is open; every 5 s while one is launching.
  const pollRef = useRef(60_000);
  const { data, loading, error, refetch } = useFetch<Campaign[]>("/campaigns", { pollMs: pollRef.current });
  const campaigns: Campaign[] = data ?? [];
  pollRef.current = campaigns.some((c) => c.status === "launching") ? LAUNCH_POLL_MS : 60_000;
  const { connected } = useWhatsAppConnection(view === "list" && !openId);
  const totals = campaigns.reduce(
    (a, c) => ({
      sent: a.sent + c.sent,
      delivered: a.delivered + c.delivered,
      read: a.read + c.read,
      failed: a.failed + (c.failed ?? 0),
    }),
    { sent: 0, delivered: 0, read: 0, failed: 0 },
  );
  const rate = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 1000) / 10}%` : "—");

  const { can } = usePermissions();
  const noPerm = tx("You don't have permission to do this", "ليست لديك صلاحية للقيام بذلك");
  const cancelCampaign = useMutation<{ id: string }, Campaign>(({ id }) =>
    api.post<Campaign>(`/campaigns/${id}/cancel`),
  );
  const refreshCampaign = useMutation<{ id: string }, Campaign>(({ id }) =>
    api.post<Campaign>(`/campaigns/${id}/refresh`),
  );
  const deleteCampaign = useMutation<{ id: string }, { ok: true }>(({ id }) =>
    api.delete<{ ok: true }>(`/campaigns/${id}`),
  );

  const run = (p: Promise<unknown>, ok: string, errText: (e: unknown) => string = (e) => campaignErrorText(e, tx)) =>
    p
      .then(() => {
        toast(ok, "success");
        refetch();
      })
      .catch((e: unknown) => {
        toast(errText(e), "error");
        refetch();
      });

  // While launching, cancel is a request the background job finishes (it stays `launching` briefly).
  const handleCancel = (c: Campaign) =>
    run(
      cancelCampaign.mutate({ id: c.id }),
      c.status === "launching" ? tx("Cancelling the campaign…", "جارٍ إلغاء الحملة…") : tx("Campaign cancelled", "تم إلغاء الحملة"),
      (e) => cancelErrorText(e, tx),
    );
  const handleRefresh = (c: Campaign) =>
    run(refreshCampaign.mutate({ id: c.id }), tx("Stats updated", "تم تحديث الإحصاءات"));
  const handleDelete = (c: Campaign) =>
    run(deleteCampaign.mutate({ id: c.id }), tx("Campaign deleted", "تم حذف الحملة"));

  const tabs: { id: TabId; label: string; count: number }[] = [
    { id: "all", label: tx("All", "الكل"), count: campaigns.length },
    {
      id: "running",
      label: tx("Running", "نشطة"),
      count: campaigns.filter((c) => c.status === "running").length,
    },
    ...(campaigns.some((c) => c.status === "launching")
      ? [{ id: "launching" as const, label: tx("Preparing", "قيد التحضير"), count: campaigns.filter((c) => c.status === "launching").length }]
      : []),
    {
      id: "scheduled",
      label: tx("Scheduled", "مجدولة"),
      count: campaigns.filter((c) => c.status === "scheduled").length,
    },
    {
      id: "draft",
      label: tx("Drafts", "مسودات"),
      count: campaigns.filter((c) => c.status === "draft").length,
    },
    {
      id: "completed",
      label: tx("Completed", "منتهية"),
      count: campaigns.filter((c) => c.status === "completed").length,
    },
  ];
  const filtered = (tab === "all" ? campaigns : campaigns.filter((c) => c.status === tab)).filter(
    (c) => c.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  if (openId) {
    return (
      <CampaignDetail
        id={openId}
        onBack={() => {
          setOpenId(null);
          refetch();
        }}
      />
    );
  }

  if (view === "builder") {
    return (
      <CampaignBuilder
        tx={tx}
        onBack={() => {
          setView("list");
          refetch();
        }}
        onDone={(msg, id) => {
          toast(msg, "success");
          setView("list");
          refetch();
          // A launched campaign opens its report, which shows the launch progress.
          if (id) setOpenId(id);
        }}
      />
    );
  }

  return (
    <div style={{ overflowY: "auto", flex: 1 }}>
      <PageHeader
        title={tx("Campaigns", "الحملات")}
        subtitle={tx(
          "WhatsApp broadcasts sent with your approved templates",
          "رسائل واتساب جماعية بقوالبك المعتمدة",
        )}
        actions={
          <>
            {can("campaigns.create") && (
              <button className="btn primary" onClick={() => setView("builder")}>
                <IconPlus w={13} />
                {tx("New campaign", "حملة جديدة")}
              </button>
            )}
          </>
        }
      />

      <div style={{ padding: "0 24px 24px", display: "grid", gap: 14 }}>
        <WhatsAppGate connected={connected} tx={tx} />
        <div
          style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 }}
        >
          <MiniStat
            label={tx("Sent", "المرسلة")}
            value={totals.sent.toLocaleString()}
            sub={tx("across all campaigns", "عبر كل الحملات")}
          />
          <MiniStat
            label={tx("Delivered rate", "معدل التسليم")}
            value={rate(totals.delivered, totals.sent)}
            sub={`${totals.delivered.toLocaleString()} ${tx("delivered", "مسلّمة")}`}
          />
          <MiniStat
            label={tx("Read rate", "معدل القراءة")}
            value={rate(totals.read, totals.delivered)}
            sub={`${totals.read.toLocaleString()} ${tx("read", "مقروءة")}`}
          />
          <MiniStat
            label={tx("Failed", "فشلت")}
            value={totals.failed.toLocaleString()}
            sub={tx("not delivered by WhatsApp", "لم يسلّمها واتساب")}
          />
        </div>

        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            borderBottom: "1px solid var(--line-soft)",
            paddingInlineEnd: 8,
          }}
        >
          {tabs.map((tb) => (
            <button
              key={tb.id}
              className={`tab ${tab === tb.id ? "active" : ""}`}
              style={{
                background: "transparent",
                border: 0,
                padding: "10px 0",
                marginInlineEnd: 18,
                cursor: "pointer",
                color: tab === tb.id ? "var(--ink)" : "var(--ink-3)",
                borderBottom: `2px solid ${
                  tab === tb.id ? "var(--accent)" : "transparent"
                }`,
                fontSize: 13,
                fontWeight: 500,
                marginBottom: -1,
              }}
              onClick={() => setTab(tb.id)}
            >
              {tb.label}
              <span
                className="mono"
                style={{ marginInlineStart: 6, fontSize: 11, color: "var(--ink-3)" }}
              >
                {tb.count}
              </span>
            </button>
          ))}
          <span style={{ flex: 1 }} />
          <input
            placeholder={tx("Search campaigns…", "ابحث في الحملات…")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ ...INPUT_STYLE, width: 220 }}
          />
        </div>

        {error && (
          <div
            style={{
              padding: 10,
              fontSize: 12,
              color: "var(--danger, #c33)",
              border: "1px solid var(--line-soft)",
              borderRadius: 8,
              background: "var(--bg-1)",
            }}
          >
            {campaignErrorText(new Error(error), tx)}
          </div>
        )}

        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>{tx("Campaign", "الحملة")}</th>
                <th>{tx("Audience", "الجمهور")}</th>
                <th>{tx("Recipients", "المستقبلون")}</th>
                <th>{tx("Delivered", "مسلّمة")}</th>
                <th>{tx("Read", "قراءة")}</th>
                <th>{tx("Failed", "فشلت")}</th>
                <th>{tx("Schedule", "الموعد")}</th>
                <th>{tx("Status", "الحالة")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={9} style={{ padding: 24, color: "var(--ink-3)", fontSize: 13 }}>
                    {tx("Loading campaigns…", "جاري التحميل…")}
                  </td>
                </tr>
              )}
              {!loading && !error && filtered.length === 0 && (
                <tr>
                  <td colSpan={9} style={{ padding: 24, color: "var(--ink-3)", fontSize: 13 }}>
                    {tx("No campaigns yet.", "لا توجد حملات بعد.")}
                  </td>
                </tr>
              )}
              {filtered.map((c) => {
                const pct = (n: number) => (c.recipients ? Math.round((n / c.recipients) * 100) : 0);
                const readPct = pct(c.read);
                const deliveredPct = pct(c.delivered);
                const when = c.scheduledAt ?? c.launchedAt;
                return (
                  <tr key={c.id} style={{ cursor: "pointer" }} onClick={() => setOpenId(c.id)}>
                    <td>
                      <a
                        href={`#/campaigns?id=${encodeURIComponent(c.id)}`}
                        dir="auto"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setOpenId(c.id);
                        }}
                        style={{ fontWeight: 500, color: "inherit", textDecoration: "none" }}
                      >
                        {c.name}
                      </a>
                      {c.status === "launching" && <LaunchingRowProgress id={c.id} tx={tx} />}
                      {c.lastError && (
                        <div dir="auto" style={{ fontSize: 11, color: "var(--bad)", marginTop: 2, maxWidth: 320 }}>
                          {lastErrorText(c.lastError, tx)}
                        </div>
                      )}
                      {!c.lastError && (c.skipped ?? 0) > 0 && (
                        <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                          {tx(
                            `${c.skipped} contacts left out (no number or opted out)`,
                            `${c.skipped} جهات مستبعدة (بلا رقم أو ألغت الاشتراك)`,
                          )}
                        </div>
                      )}
                    </td>
                    <td className="muted">{c.audience}</td>
                    <td className="mono">{c.recipients.toLocaleString()}</td>
                    <td>
                      <InlineBar pct={deliveredPct} label={`${deliveredPct}%`} color="var(--info)" />
                    </td>
                    <td>
                      <InlineBar pct={readPct} label={`${readPct}%`} />
                    </td>
                    <td className="mono">{(c.failed ?? 0).toLocaleString()}</td>
                    <td className="muted mono">
                      {when
                        ? new Date(when).toLocaleString(t.lang === "ar" ? "ar" : "en", { dateStyle: "medium", timeStyle: "short" })
                        : c.schedule}
                    </td>
                    <td>
                      <Badge kind={statusKind(c.status)} dot>
                        {campaignStatusLabel(c.status, tx)}
                      </Badge>
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                        {c.status !== "draft" && c.status !== "launching" && (
                          <button
                            className="btn ghost sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpenId(c.id);
                            }}
                          >
                            {tx("View report", "عرض التقرير")}
                          </button>
                        )}
                        {c.zernioBroadcastId && (
                          <button
                            className="btn ghost sm"
                            disabled={refreshCampaign.loading || !can("campaigns.update")}
                            title={can("campaigns.update") ? undefined : noPerm}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRefresh(c);
                            }}
                          >
                            {tx("Refresh", "تحديث")}
                          </button>
                        )}
                        {(c.status === "launching" ||
                          ((c.status === "running" || c.status === "scheduled") && (c.zernioBroadcastId || c.sendTransport === "direct"))) &&
                          can("campaigns.manage") && (
                          <button
                            className="btn ghost sm danger"
                            disabled={cancelCampaign.loading || !!c.cancelRequestedAt}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCancel(c);
                            }}
                          >
                            {tx("Cancel", "إلغاء")}
                          </button>
                        )}
                        <button
                          className="btn ghost sm"
                          title={
                            !can("campaigns.delete")
                              ? noPerm
                              : c.status === "running" || c.status === "scheduled" || c.status === "launching"
                                ? tx("Cancel it first", "ألغِها أولاً")
                                : undefined
                          }
                          disabled={
                            deleteCampaign.loading ||
                            !can("campaigns.delete") ||
                            c.status === "running" ||
                            c.status === "scheduled" ||
                            c.status === "launching"
                          }
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(c);
                          }}
                        >
                          {tx("Delete", "حذف")}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

const Campaigns = memo(CampaignsImpl);
export default Campaigns;
