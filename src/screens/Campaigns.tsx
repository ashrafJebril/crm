import { Fragment, memo, useState, type CSSProperties, type ReactNode } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx, type Tx } from "@/lib/tx";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/Badge";
import { PhonePreview } from "@/components/PhonePreview";
import {
  IconCheck,
  IconChev,
  IconPlus,
} from "@/icons";
import type { Campaign, CampaignPreview, CampaignVariable, Segment, Template } from "@/lib/types";
import { mappingComplete, placeholderCount, renderCampaignPreview } from "./campaigns/campaignVars";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import { useToast } from "@/components/Toast";

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

interface MiniStatProps {
  label: string;
  value: string;
  sub: string;
}

function MiniStat({ label, value, sub }: MiniStatProps) {
  return (
    <div className="stat" style={{ padding: 14 }}>
      <div className="label">{label}</div>
      <div className="value" style={{ fontSize: 22 }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{sub}</div>
    </div>
  );
}

interface InlineBarProps {
  pct: number;
  label: string;
  color?: string;
}

function InlineBar({ pct, label, color = "var(--accent)" }: InlineBarProps) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 90 }}>
      <div
        style={{
          flex: 1,
          height: 4,
          background: "var(--bg-2)",
          borderRadius: 2,
          overflow: "hidden",
        }}
      >
        <div
          style={{ width: `${pct}%`, height: "100%", background: color, opacity: 0.7 }}
        />
      </div>
      <span className="mono" style={{ fontSize: 11, color: "var(--ink-2)" }}>
        {label}
      </span>
    </div>
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
  mapping: CampaignVariable[];
  onMapping: (m: CampaignVariable[]) => void;
}

const fieldLabels = (tx: Tx): Record<CampaignVariable["field"], string> => ({
  name: tx("Customer name", "اسم العميل"),
  phone: tx("Customer phone", "هاتف العميل"),
  custom: tx("Fixed text", "نص ثابت"),
});

function MessageStep({ tx, templates, templateId, onSelect, mapping, onMapping }: MessageStepProps) {
  const selected = templates.find((t) => t.id === templateId) ?? null;
  const count = placeholderCount(selected?.body);
  const labels = fieldLabels(tx);
  const setVar = (i: number, v: CampaignVariable) => {
    const next = Array.from({ length: count }, (_, j) => mapping[j] ?? ({ field: "name" } as CampaignVariable));
    next[i] = v;
    onMapping(next);
  };
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
          <select
            style={INPUT_STYLE}
            value={templateId ?? ""}
            onChange={(e) => {
              const id = e.target.value || null;
              onSelect(id);
              const t = templates.find((x) => x.id === id);
              onMapping(Array.from({ length: placeholderCount(t?.body) }, () => ({ field: "name" }) as CampaignVariable));
            }}
          >
            <option value="">{tx("Select a template…", "اختر قالبًا…")}</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id} disabled={t.status !== "approved"}>
                {t.name} · {t.lang.toUpperCase()}
                {t.status !== "approved" ? ` · ${tx("not approved yet", "غير معتمد بعد")}` : ""}
              </option>
            ))}
          </select>
        </Field>

        {Array.from({ length: count }, (_, i) => {
          const v = mapping[i] ?? ({ field: "name" } as CampaignVariable);
          return (
            <Field key={i} label={`${tx("Variable", "المتغير")} {{${i + 1}}}`}>
              <div style={{ display: "flex", gap: 8 }}>
                <select
                  style={{ ...INPUT_STYLE, width: 170 }}
                  value={v.field}
                  onChange={(e) => {
                    const field = e.target.value as CampaignVariable["field"];
                    setVar(i, field === "custom" ? { field, customValue: "" } : { field });
                  }}
                >
                  {(["name", "phone", "custom"] as const).map((f) => (
                    <option key={f} value={f}>
                      {labels[f]}
                    </option>
                  ))}
                </select>
                {v.field === "custom" && (
                  <input
                    style={{ ...INPUT_STYLE, flex: 1 }}
                    value={v.customValue}
                    onChange={(e) => setVar(i, { field: "custom", customValue: e.target.value })}
                    placeholder={tx("Same for everyone, e.g. 20%", "نفس القيمة للجميع، مثل 20%")}
                  />
                )}
              </div>
            </Field>
          );
        })}
        {count > 0 && (
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
            {tx(
              "Customer name and phone are filled in for each person. A contact without a name gets “Customer”.",
              "يُملأ اسم العميل وهاتفه لكل شخص. جهة الاتصال بلا اسم تظهر كـ «Customer».",
            )}
          </div>
        )}

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
}

/** "YYYY-MM-DDTHH:mm" in local time, the format <input type="datetime-local"> uses. */
const toLocalInput = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function ScheduleStep({ tx, choice, onChoose, when, onWhen }: ScheduleStepProps) {
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
              onChange={(e) => onWhen(e.target.value)}
            />
          </Field>
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
  preview: CampaignPreview | null;
  previewLoading: boolean;
  template: Template | null;
  scheduleLabel: string;
}

function ReviewStep({ tx, audienceLabel, preview, previewLoading, template, scheduleLabel }: ReviewStepProps) {
  const reach = preview
    ? `${preview.reachable.toLocaleString()} ${tx("of", "من")} ${preview.total.toLocaleString()} ${tx("contacts", "جهة")}`
    : previewLoading
      ? tx("Counting…", "جارٍ العد…")
      : "—";
  const skipped = preview ? preview.skipped.noPhone + preview.skipped.optedOut + preview.skipped.duplicate : 0;
  const rows: [string, string][] = [
    [tx("Audience", "الجمهور"), audienceLabel],
    [tx("Will receive it", "سيستلمها"), reach],
    [tx("Template", "القالب"), template ? `${template.name} · ${template.lang.toUpperCase()}` : tx("None selected", "لم يُختر")],
    [tx("Schedule", "الموعد"), scheduleLabel],
  ];
  return (
    <div className="card">
      <div className="card-h"><h3>{tx("Review", "مراجعة")}</h3></div>
      <div style={{ padding: 18, display: "grid", gap: 10 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13 }}>
            <span style={{ color: "var(--ink-3)" }}>{k}</span>
            <span style={{ fontWeight: 500, textAlign: "end" }}>{v}</span>
          </div>
        ))}
        {preview && skipped > 0 && (
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
            {tx(
              `Left out: ${preview.skipped.noPhone} without a phone number with a country code, ${preview.skipped.optedOut} opted out, ${preview.skipped.duplicate} duplicate numbers.`,
              `مستبعدون: ${preview.skipped.noPhone} بلا رقم برمز الدولة، ${preview.skipped.optedOut} ألغوا الاشتراك، ${preview.skipped.duplicate} أرقام مكررة.`,
            )}
          </div>
        )}
        {preview && preview.reachable === 0 && (
          <div style={{ fontSize: 12, color: "var(--warn)" }}>
            {tx(
              "No one in this audience has a WhatsApp number with a country code, so the campaign can't be sent.",
              "لا أحد في هذا الجمهور لديه رقم واتساب برمز الدولة، لذا لا يمكن إرسال الحملة.",
            )}
          </div>
        )}
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

interface CampaignBuilderProps {
  tx: Tx;
  onBack: () => void;
  onDone: (message: string) => void;
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

  const [name, setName] = useState("");
  const [segmentId, setSegmentId] = useState<string | null>(null); // null = all contacts
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [mapping, setMapping] = useState<CampaignVariable[]>([]);
  const [scheduleChoice, setScheduleChoice] = useState<ScheduleChoice>("now");
  const [when, setWhen] = useState(() => toLocalInput(new Date(Date.now() + 3_600_000)));
  // A failed launch keeps its saved draft, so retrying doesn't create a second one.
  const [draftId, setDraftId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const previewQ = useFetch<CampaignPreview>(
    step === 4 ? `/campaigns/preview${segmentId ? `?segmentId=${encodeURIComponent(segmentId)}` : ""}` : null,
  );

  const segments = segmentsQ.data ?? [];
  const templates = (templatesQ.data ?? []).filter((t) => !!t.body);
  const selectedSegment = segments.find((s) => s.id === segmentId) ?? null;
  const audienceCount = previewQ.data?.total ?? selectedSegment?.count ?? 0;
  const audienceLabel = selectedSegment ? selectedSegment.name : tx("All contacts", "كل جهات الاتصال");
  const selectedTemplate = templates.find((t) => t.id === templateId) ?? null;
  const varCount = placeholderCount(selectedTemplate?.body);

  const previewBody = selectedTemplate?.body
    ? renderCampaignPreview(selectedTemplate.body, mapping)
    : tx("Select a template to preview it.", "اختر قالبًا للمعاينة.");
  let previewButtons: string[] = [];
  try {
    const parsed = selectedTemplate?.buttons ? JSON.parse(selectedTemplate.buttons) as { text?: string }[] : [];
    previewButtons = parsed.map((b) => b.text ?? "").filter(Boolean);
  } catch { previewButtons = []; }

  const whenDate = scheduleChoice === "later" ? new Date(when) : null;
  const whenValid = !whenDate || (!Number.isNaN(whenDate.getTime()) && whenDate.getTime() > Date.now());
  const scheduleLabel =
    scheduleChoice === "now"
      ? tx("Send now", "إرسال الآن")
      : whenDate && !Number.isNaN(whenDate.getTime())
        ? whenDate.toLocaleString()
        : tx("Pick a time", "اختر الوقت");

  const canLaunch =
    !!name.trim() &&
    selectedTemplate?.status === "approved" &&
    mappingComplete(mapping, varCount) &&
    whenValid &&
    (previewQ.data?.reachable ?? 0) > 0;

  const draftBody = () => ({
    name: name.trim(),
    audience: audienceLabel,
    channel: "Broadcast",
    recipients: audienceCount,
    schedule: scheduleLabel,
    segmentId: segmentId ?? undefined,
    templateId: templateId ?? undefined,
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
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onLaunch() {
    setBusy(true);
    setError(null);
    try {
      const id = await saveDraft();
      await api.post(`/campaigns/${id}/launch`, {
        mode: scheduleChoice === "now" ? "now" : "schedule",
        scheduledAt: whenDate ? whenDate.toISOString() : undefined,
        variables: mapping.slice(0, varCount),
      });
      onDone(
        scheduleChoice === "now"
          ? tx("Campaign is sending", "بدأ إرسال الحملة")
          : tx("Campaign scheduled", "تمت جدولة الحملة"),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

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

      <div style={{ padding: "20px 24px 0", display: "flex", gap: 8 }}>
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
          gridTemplateColumns: "1fr 360px",
          gap: 24,
        }}
      >
        <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
          {step === 1 && (
            <AudienceStep tx={tx} segments={segments} segmentId={segmentId} onSelect={setSegmentId} count={audienceCount} />
          )}
          {step === 2 && (
            <MessageStep
              tx={tx}
              templates={templates}
              templateId={templateId}
              onSelect={setTemplateId}
              mapping={mapping}
              onMapping={setMapping}
            />
          )}
          {step === 3 && (
            <ScheduleStep tx={tx} choice={scheduleChoice} onChoose={setScheduleChoice} when={when} onWhen={setWhen} />
          )}
          {step === 4 && (
            <ReviewStep
              tx={tx}
              audienceLabel={audienceLabel}
              preview={previewQ.data}
              previewLoading={previewQ.loading}
              template={selectedTemplate}
              scheduleLabel={scheduleLabel}
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
                <button className="btn" disabled={!name.trim() || busy} onClick={onSaveDraft}>
                  {tx("Save draft", "حفظ مسودة")}
                </button>
                <button className="btn primary" disabled={!canLaunch || busy} onClick={onLaunch}>
                  {busy
                    ? tx("Working…", "جارٍ التنفيذ…")
                    : scheduleChoice === "now"
                      ? tx("Send campaign", "إرسال الحملة")
                      : tx("Schedule campaign", "جدولة الحملة")}
                </button>
              </div>
            ) : (
              <button className="btn primary" onClick={() => setStep((s) => Math.min(4, s + 1))}>
                {tx("Continue", "متابعة")}
                <IconChev w={12} />
              </button>
            )}
          </div>
        </div>

        <PhonePreview body={previewBody} buttons={previewButtons} tx={tx} />
      </div>
    </div>
  );
}

function CampaignsImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const [view, setView] = useState<View>("list");
  const [tab, setTab] = useState<TabId>("all");
  const [query, setQuery] = useState("");

  const { toast } = useToast();
  // Sending campaigns update every minute while the page is open.
  const { data, loading, error, refetch } = useFetch<Campaign[]>("/campaigns", { pollMs: 60_000 });
  const campaigns: Campaign[] = data ?? [];
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

  const cancelCampaign = useMutation<{ id: string }, Campaign>(({ id }) =>
    api.post<Campaign>(`/campaigns/${id}/cancel`),
  );
  const refreshCampaign = useMutation<{ id: string }, Campaign>(({ id }) =>
    api.post<Campaign>(`/campaigns/${id}/refresh`),
  );
  const deleteCampaign = useMutation<{ id: string }, { ok: true }>(({ id }) =>
    api.delete<{ ok: true }>(`/campaigns/${id}`),
  );

  const run = (p: Promise<unknown>, ok: string) =>
    p
      .then(() => {
        toast(ok, "success");
        refetch();
      })
      .catch((e: Error) => toast(e.message, "error"));

  const handleCancel = (c: Campaign) =>
    run(cancelCampaign.mutate({ id: c.id }), tx("Campaign cancelled", "تم إلغاء الحملة"));
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

  if (view === "builder") {
    return (
      <CampaignBuilder
        tx={tx}
        onBack={() => {
          setView("list");
          refetch();
        }}
        onDone={(msg) => {
          toast(msg, "success");
          setView("list");
          refetch();
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
            <button className="btn primary" onClick={() => setView("builder")}>
              <IconPlus w={13} />
              {tx("New campaign", "حملة جديدة")}
            </button>
          </>
        }
      />

      <div style={{ padding: "0 24px 24px", display: "grid", gap: 14 }}>
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
            {error}
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
                  <tr key={c.id} style={{ cursor: "pointer" }}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{c.name}</div>
                      {c.lastError && (
                        <div style={{ fontSize: 11, color: "var(--bad)", marginTop: 2, maxWidth: 320 }}>{c.lastError}</div>
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
                      {c.status === "running" && (
                        <Badge kind="ok" dot>
                          running
                        </Badge>
                      )}
                      {c.status === "scheduled" && (
                        <Badge kind="info" dot>
                          scheduled
                        </Badge>
                      )}
                      {c.status === "draft" && <Badge dot>draft</Badge>}
                      {c.status === "completed" && <Badge dot>completed</Badge>}
                      {c.status === "failed" && (
                        <Badge kind="bad" dot>
                          failed
                        </Badge>
                      )}
                      {c.status === "cancelled" && <Badge dot>cancelled</Badge>}
                      {c.status === "paused" && (
                        <Badge kind="warn" dot>
                          paused
                        </Badge>
                      )}
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                        {c.zernioBroadcastId && (
                          <button
                            className="btn ghost sm"
                            disabled={refreshCampaign.loading}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRefresh(c);
                            }}
                          >
                            {tx("Refresh", "تحديث")}
                          </button>
                        )}
                        {(c.status === "running" || c.status === "scheduled") && c.zernioBroadcastId && (
                          <button
                            className="btn ghost sm danger"
                            disabled={cancelCampaign.loading}
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
                            c.status === "running" || c.status === "scheduled"
                              ? tx("Cancel it first", "ألغِها أولاً")
                              : undefined
                          }
                          disabled={deleteCampaign.loading || c.status === "running" || c.status === "scheduled"}
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
