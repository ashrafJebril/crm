import { Fragment, memo, useState, type CSSProperties, type ReactNode } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx, type Tx } from "@/lib/tx";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/Badge";
import {
  IconCheck,
  IconChev,
  IconMore,
  IconPhone,
  IconPlus,
} from "@/icons";
import type { Campaign, Segment, Template } from "@/lib/types";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";

interface CreateCampaignBody {
  name: string;
  audience: string;
  channel: string;
  status?: Campaign["status"];
  schedule?: string;
  recipients?: number;
  segmentId?: string;
  templateId?: string;
}

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
}

function MessageStep({ tx, templates, templateId, onSelect }: MessageStepProps) {
  const selected = templates.find((t) => t.id === templateId) ?? null;
  const vars = selected?.body?.match(/\{\{[^}]+\}\}/g) ?? [];
  return (
    <div className="card">
      <div className="card-h">
        <div>
          <h3>{tx("Message", "الرسالة")}</h3>
          <div className="sub">{tx("WhatsApp template", "قالب واتساب")}</div>
        </div>
      </div>
      <div style={{ padding: 18, display: "grid", gap: 14 }}>
        <Field label={tx("Template", "القالب")}>
          <select
            style={INPUT_STYLE}
            value={templateId ?? ""}
            onChange={(e) => onSelect(e.target.value || null)}
          >
            <option value="">{tx("Select a template…", "اختر قالبًا…")}</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} · {t.status} · {t.lang.toUpperCase()}
              </option>
            ))}
          </select>
        </Field>
        {selected?.body && (
          <div
            style={{
              padding: 12, borderRadius: 10, background: "var(--bg-2)",
              border: "1px solid var(--line-soft)", fontSize: 13, lineHeight: 1.5,
              whiteSpace: "pre-wrap",
            }}
          >
            {selected.body}
          </div>
        )}
        {selected && selected.status !== "approved" && (
          <div style={{ fontSize: 12, color: "var(--warn, #b58a00)" }}>
            {tx(
              "This template isn't approved by Meta yet — the campaign can be drafted but not sent.",
              "هذا القالب غير معتمد من ميتا بعد — يمكن حفظ الحملة كمسودة فقط.",
            )}
          </div>
        )}
        {vars.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {vars.map((v) => (
              <span key={v} className="mono" style={{ fontSize: 11, padding: "3px 8px", background: "var(--bg-2)", border: "1px solid var(--line-soft)", borderRadius: 6 }}>
                {v}
              </span>
            ))}
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

interface ScheduleStepProps {
  tx: Tx;
  choice: "now" | "later" | "drip" | "trigger";
  onChoose: (c: "now" | "later" | "drip" | "trigger") => void;
}

function ScheduleStep({ tx, choice, onChoose }: ScheduleStepProps) {
  const options = [
    { id: "now" as const, label: tx("Send now", "إرسال الآن"), sub: tx("Begins as soon as sending ships", "يبدأ فور توفر الإرسال") },
    { id: "later" as const, label: tx("Schedule for later", "جدولة لاحقاً"), sub: tx("Pick a date when sending ships", "اختر التاريخ عند توفر الإرسال") },
    { id: "drip" as const, label: tx("Drip over time", "تنقيط عبر الوقت"), sub: tx("Staggered delivery", "تسليم موزّع") },
    { id: "trigger" as const, label: tx("Trigger-based", "مبني على مشغل"), sub: tx("Send when a contact joins the audience", "عند الانضمام للجمهور") },
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
      </div>
    </div>
  );
}

interface ReviewStepProps {
  tx: Tx;
  audienceLabel: string;
  audienceCount: number;
  template: Template | null;
  scheduleLabel: string;
}

function ReviewStep({ tx, audienceLabel, audienceCount, template, scheduleLabel }: ReviewStepProps) {
  const rows: [string, string][] = [
    [tx("Audience", "الجمهور"), `${audienceLabel} · ${audienceCount.toLocaleString()} ${tx("contacts", "جهة")}`],
    [tx("Template", "القالب"), template ? `${template.name} · ${template.status}` : tx("None selected", "لم يُختر")],
    [tx("Schedule", "الموعد"), scheduleLabel],
    [tx("Channel", "القناة"), "WhatsApp"],
  ];
  return (
    <div className="card">
      <div className="card-h"><h3>{tx("Review", "مراجعة")}</h3></div>
      <div style={{ padding: 18, display: "grid", gap: 10 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
            <span style={{ color: "var(--ink-3)" }}>{k}</span>
            <span style={{ fontWeight: 500 }}>{v}</span>
          </div>
        ))}
        <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 4 }}>
          {tx(
            "Saved as a draft — sending arrives with the campaign engine.",
            "تُحفظ كمسودة — الإرسال يتوفر مع محرك الحملات.",
          )}
        </div>
      </div>
    </div>
  );
}

interface PhonePreviewProps {
  body: string;
  buttons: string[];
  tx: Tx;
}

function PhonePreview({ body, buttons, tx }: PhonePreviewProps) {
  return (
    <div style={{ position: "sticky", top: 12, alignSelf: "start" }}>
      <div
        className="mono"
        style={{
          fontSize: 11,
          color: "var(--ink-3)",
          textTransform: "uppercase",
          marginBottom: 8,
          letterSpacing: 0.06,
        }}
      >
        {tx("Live preview", "معاينة")}
      </div>
      <div
        style={{
          width: 320,
          background: "var(--bg-1)",
          border: "1px solid var(--line)",
          borderRadius: 28,
          padding: 14,
          boxShadow: "var(--shadow-lg)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "4px 4px 12px",
            borderBottom: "1px solid var(--line-soft)",
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600 }}>Samemha</div>
            <div style={{ fontSize: 10, color: "var(--ok)" }}>● online</div>
          </div>
          <IconPhone w={14} className="muted" />
          <IconMore w={14} className="muted" />
        </div>
        <div
          style={{
            minHeight: 280,
            padding: "12px 0",
            display: "flex",
            flexDirection: "column",
            gap: 6,
            backgroundImage:
              "radial-gradient(circle, var(--line-soft) 1px, transparent 1px)",
            backgroundSize: "16px 16px",
          }}
        >
          <div
            style={{
              alignSelf: "flex-start",
              maxWidth: "85%",
              padding: "8px 12px",
              background: "var(--bubble-out)",
              border: "1px solid var(--bubble-out-line)",
              borderRadius: "12px 12px 12px 4px",
              fontSize: 12.5,
              whiteSpace: "pre-wrap",
            }}
          >
            {body}
            {buttons.length > 0 && (
              <div style={{ display: "flex", gap: 4, marginTop: 8, flexWrap: "wrap" }}>
                {buttons.map((b) => (
                  <span
                    key={b}
                    style={{
                      padding: "3px 10px",
                      borderRadius: 999,
                      background: "var(--bg)",
                      border: "1px solid var(--line)",
                      fontSize: 11,
                    }}
                  >
                    {b}
                  </span>
                ))}
              </div>
            )}
            <div
              className="mono"
              style={{
                fontSize: 9,
                color: "var(--ink-3)",
                textAlign: "end",
                marginTop: 4,
              }}
            >
              10:00 ✓
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface CampaignBuilderProps {
  tx: Tx;
  onBack: () => void;
  onLaunch: (body: CreateCampaignBody) => Promise<void>;
  launching: boolean;
}

function CampaignBuilder({ tx, onBack, onLaunch, launching }: CampaignBuilderProps) {
  const steps = [
    { id: 1, label: tx("Audience", "الجمهور") },
    { id: 2, label: tx("Message", "الرسالة") },
    { id: 3, label: tx("Schedule", "الموعد") },
    { id: 4, label: tx("Review", "مراجعة") },
  ];
  const [step, setStep] = useState(1);

  const segmentsQ = useFetch<Segment[]>("/segments");
  const templatesQ = useFetch<Template[]>("/templates");
  const summaryQ = useFetch<{ counts: { contacts: number } }>("/dashboard/summary");

  const [name, setName] = useState("");
  const [segmentId, setSegmentId] = useState<string | null>(null); // null = all contacts
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [scheduleChoice, setScheduleChoice] = useState<"now" | "later" | "drip" | "trigger">("later");

  const segments = segmentsQ.data ?? [];
  const templates = (templatesQ.data ?? []).filter((t) => !!t.body);
  const selectedSegment = segments.find((s) => s.id === segmentId) ?? null;
  const audienceCount = selectedSegment ? selectedSegment.count : summaryQ.data?.counts.contacts ?? 0;
  const audienceLabel = selectedSegment ? selectedSegment.name : tx("All contacts", "كل جهات الاتصال");
  const selectedTemplate = templates.find((t) => t.id === templateId) ?? null;

  const previewBody = selectedTemplate?.body ?? tx("Select a template to preview it.", "اختر قالبًا للمعاينة.");
  let previewButtons: string[] = [];
  try {
    const parsed = selectedTemplate?.buttons ? JSON.parse(selectedTemplate.buttons) as { text?: string }[] : [];
    previewButtons = parsed.map((b) => b.text ?? "").filter(Boolean);
  } catch { previewButtons = []; }

  const scheduleLabel = {
    now: tx("Send now", "إرسال الآن"),
    later: tx("Scheduled", "مجدولة"),
    drip: tx("Drip", "تنقيط"),
    trigger: tx("Trigger-based", "مشغل"),
  }[scheduleChoice];

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
        <button className="btn ghost icon" onClick={onBack}>
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
        <div style={{ display: "grid", gap: 16 }}>
          {step === 1 && (
            <AudienceStep tx={tx} segments={segments} segmentId={segmentId} onSelect={setSegmentId} count={audienceCount} />
          )}
          {step === 2 && (
            <MessageStep tx={tx} templates={templates} templateId={templateId} onSelect={setTemplateId} />
          )}
          {step === 3 && <ScheduleStep tx={tx} choice={scheduleChoice} onChoose={setScheduleChoice} />}
          {step === 4 && (
            <ReviewStep tx={tx} audienceLabel={audienceLabel} audienceCount={audienceCount} template={selectedTemplate} scheduleLabel={scheduleLabel} />
          )}

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
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
              <button
                className="btn primary"
                disabled={!name.trim() || !templateId || launching}
                onClick={() => {
                  void onLaunch({
                    name: name.trim(),
                    audience: audienceLabel,
                    channel: "Broadcast",
                    status: "draft",
                    recipients: audienceCount,
                    schedule: scheduleLabel,
                    segmentId: segmentId ?? undefined,
                    templateId: templateId ?? undefined,
                  });
                }}
              >
                {tx("Save draft", "حفظ مسودة")}
              </button>
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

  const { data, loading, error, refetch } = useFetch<Campaign[]>("/campaigns");
  const campaigns: Campaign[] = data ?? [];
  const totals = campaigns.reduce(
    (a, c) => ({
      sent: a.sent + c.sent,
      delivered: a.delivered + c.delivered,
      read: a.read + c.read,
      replied: a.replied + c.replied,
    }),
    { sent: 0, delivered: 0, read: 0, replied: 0 },
  );
  const rate = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 1000) / 10}%` : "—");

  const createCampaign = useMutation<CreateCampaignBody, Campaign>((body) =>
    api.post<Campaign>("/campaigns", body),
  );
  const updateStatus = useMutation<
    { id: string; status: Campaign["status"] },
    Campaign
  >(({ id, status }) => api.patch<Campaign>(`/campaigns/${id}`, { status }));
  const deleteCampaign = useMutation<{ id: string }, { ok: true }>(({ id }) =>
    api.delete<{ ok: true }>(`/campaigns/${id}`),
  );

  const handleLaunch = async (body: CreateCampaignBody): Promise<void> => {
    try {
      await createCampaign.mutate(body);
      refetch();
      setView("list");
    } catch {
      /* error surfaces via createCampaign.error */
    }
  };

  const handleToggleStatus = (c: Campaign): void => {
    const next: Campaign["status"] = c.status === "running" ? "paused" : "running";
    updateStatus
      .mutate({ id: c.id, status: next })
      .then(() => refetch())
      .catch(() => {
        /* swallow; error visible via state */
      });
  };

  const handleDelete = (c: Campaign): void => {
    deleteCampaign
      .mutate({ id: c.id })
      .then(() => refetch())
      .catch(() => {
        /* swallow */
      });
  };

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
        onBack={() => setView("list")}
        onLaunch={handleLaunch}
        launching={createCampaign.loading}
      />
    );
  }

  return (
    <div style={{ overflowY: "auto", flex: 1 }}>
      <PageHeader
        title={tx("Campaigns", "الحملات")}
        subtitle={tx(
          "Broadcast, drip, and trigger-based WhatsApp campaigns",
          "حملات إذاعية وتنقيطية ومشغلات",
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
            label={tx("Reply rate", "معدل الرد")}
            value={rate(totals.replied, totals.read)}
            sub={`${totals.replied.toLocaleString()} ${tx("replies", "رد")}`}
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
                <th>{tx("Channel", "القناة")}</th>
                <th>{tx("Recipients", "المستقبلون")}</th>
                <th>{tx("Read", "قراءة")}</th>
                <th>{tx("Replied", "ردود")}</th>
                <th>{tx("Conv.", "تحويل")}</th>
                <th>{tx("Schedule", "الموعد")}</th>
                <th>{tx("Status", "الحالة")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={10} style={{ padding: 24, color: "var(--ink-3)", fontSize: 13 }}>
                    {tx("Loading campaigns…", "جاري التحميل…")}
                  </td>
                </tr>
              )}
              {!loading && !error && filtered.length === 0 && (
                <tr>
                  <td colSpan={10} style={{ padding: 24, color: "var(--ink-3)", fontSize: 13 }}>
                    {tx("No campaigns yet.", "لا توجد حملات بعد.")}
                  </td>
                </tr>
              )}
              {filtered.map((c) => {
                const readPct = c.recipients
                  ? Math.round((c.read / c.recipients) * 100)
                  : 0;
                const replPct = c.recipients
                  ? Math.round((c.replied / c.recipients) * 100)
                  : 0;
                return (
                  <tr key={c.id} style={{ cursor: "pointer" }}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{c.name}</div>
                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--ink-3)",
                          display: "flex",
                          gap: 6,
                          alignItems: "center",
                          marginTop: 2,
                        }}
                      >
                      </div>
                    </td>
                    <td className="muted">{c.audience}</td>
                    <td>
                      <span className="badge mono">{c.channel}</span>
                    </td>
                    <td className="mono">{c.recipients.toLocaleString()}</td>
                    <td>
                      <InlineBar pct={readPct} label={`${readPct}%`} />
                    </td>
                    <td>
                      <InlineBar pct={replPct} label={`${replPct}%`} color="var(--info)" />
                    </td>
                    <td className="mono">{c.conversions}</td>
                    <td className="muted mono">{c.schedule}</td>
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
                      {c.status === "paused" && (
                        <Badge kind="warn" dot>
                          paused
                        </Badge>
                      )}
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                        {(c.status === "running" || c.status === "paused") && (
                          <button
                            className="btn ghost sm"
                            disabled={updateStatus.loading}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleToggleStatus(c);
                            }}
                          >
                            {c.status === "running"
                              ? tx("Pause", "إيقاف")
                              : tx("Resume", "متابعة")}
                          </button>
                        )}
                        <button
                          className="btn ghost sm"
                          disabled={deleteCampaign.loading}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(c);
                          }}
                        >
                          {tx("Delete", "حذف")}
                        </button>
                        <button className="btn ghost icon sm">
                          <IconMore w={14} />
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
