import { Fragment, memo, useState, type CSSProperties, type ReactNode } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx, type Tx } from "@/lib/tx";
import { PageHeader } from "@/components/PageHeader";
import { Avatar } from "@/components/Avatar";
import { Badge } from "@/components/Badge";
import {
  IconAlert,
  IconCheck,
  IconCheckCircle,
  IconChev,
  IconLang,
  IconMore,
  IconPhone,
  IconPlus,
  IconSparkles,
  IconTemplate,
  IconX,
} from "@/icons";
import { AGENTS } from "@/data/agents";
import type { Campaign } from "@/lib/types";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";

interface CreateCampaignBody {
  name: string;
  audience: string;
  channel: string;
  agent: string;
  status?: Campaign["status"];
  schedule?: string;
  recipients?: number;
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

interface FilterRowProps {
  field: string;
  op: string;
  value: string;
}

function FilterRow({ field, op, value }: FilterRowProps) {
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <span
        style={{
          padding: "6px 10px",
          background: "var(--bg-2)",
          border: "1px solid var(--line-soft)",
          borderRadius: 6,
          fontSize: 12,
          fontWeight: 500,
        }}
      >
        {field}
      </span>
      <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
        {op}
      </span>
      <span
        style={{
          padding: "6px 10px",
          background: "var(--accent-soft)",
          color: "var(--accent)",
          border: "1px solid var(--accent-ring)",
          borderRadius: 6,
          fontSize: 12,
          fontWeight: 500,
        }}
      >
        {value}
      </span>
      <button className="btn ghost icon sm" style={{ marginInlineStart: "auto" }}>
        <IconX w={12} />
      </button>
    </div>
  );
}

interface AudienceStepProps {
  tx: Tx;
}

function AudienceStep({ tx }: AudienceStepProps) {
  return (
    <div className="card">
      <div className="card-h">
        <h3>{tx("Audience", "الجمهور")}</h3>
        <span className="sub mono">624 {tx("contacts match", "جهة اتصال")}</span>
      </div>
      <div style={{ padding: 18, display: "grid", gap: 14 }}>
        <div style={{ display: "grid", gap: 8 }}>
          <div
            className="mono"
            style={{
              fontSize: 11,
              color: "var(--ink-3)",
              textTransform: "uppercase",
            }}
          >
            {tx("Filters", "الفلاتر")}
          </div>
          <FilterRow field={tx("Tags", "وسوم")} op="includes" value="Trial · Hot" />
          <FilterRow field={tx("Lifecycle", "المرحلة")} op="is" value="Lead" />
          <FilterRow field={tx("Last seen", "آخر ظهور")} op="<" value="14 days" />
          <FilterRow field={tx("Country", "البلد")} op="in" value="SA, AE, EG, MA" />
          <button className="btn ghost sm" style={{ alignSelf: "start" }}>
            <IconPlus w={11} />
            {tx("Add filter", "إضافة فلتر")}
          </button>
        </div>
        <hr className="divider" />
        <div
          style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
        >
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>
              {tx("Estimated audience", "الحجم المتوقع")}
            </div>
            <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
              {tx(
                "Excludes opted-out, blocked, and 24h-window expired",
                "يستثني المُلغين والمحظورين",
              )}
            </div>
          </div>
          <div className="display" style={{ fontSize: 32, color: "var(--accent)" }}>
            624
          </div>
        </div>
      </div>
    </div>
  );
}

interface MessageStepProps {
  tx: Tx;
  body: string;
  setBody: (s: string) => void;
}

function MessageStep({ tx, body, setBody }: MessageStepProps) {
  return (
    <>
      <div className="card">
        <div className="card-h">
          <div>
            <h3>{tx("Message", "الرسالة")}</h3>
            <div className="sub">
              {tx("WhatsApp template · MARKETING", "قالب واتساب · تسويقي")}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn sm">
              <IconLang w={12} />
              EN
            </button>
            <button className="btn sm ghost">AR</button>
          </div>
        </div>
        <div style={{ padding: 18 }}>
          <Field label={tx("Template", "القالب")}>
            <select style={INPUT_STYLE}>
              <option>spring_waitlist_v2 · approved</option>
              <option>spring_drop_image · pending</option>
            </select>
          </Field>
          <div style={{ marginTop: 14 }}>
            <div
              className="mono"
              style={{
                fontSize: 11,
                color: "var(--ink-3)",
                textTransform: "uppercase",
                marginBottom: 6,
              }}
            >
              {tx("Body", "المحتوى")}
            </div>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              style={{
                width: "100%",
                minHeight: 160,
                padding: 12,
                borderRadius: 10,
                background: "var(--bg-2)",
                border: "1px solid var(--line-soft)",
                color: "var(--ink)",
                fontFamily: "inherit",
                fontSize: 14,
                lineHeight: 1.5,
                outline: 0,
                resize: "vertical",
              }}
            />
          </div>
          <div
            style={{
              display: "flex",
              gap: 6,
              marginTop: 10,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            {["{{first_name}}", "{{order_id}}", "{{city}}", "{{discount_code}}"].map((v) => (
              <button key={v} className="btn ghost sm mono" style={{ fontSize: 11 }}>
                {v}
              </button>
            ))}
            <span style={{ flex: 1 }} />
            <button className="btn ghost sm">
              <IconSparkles w={11} />
              {tx("Improve with AI", "حسّن بالذكاء")}
            </button>
          </div>
        </div>
      </div>
      <div className="card">
        <div className="card-h">
          <h3>{tx("Quick reply buttons", "أزرار الرد السريع")}</h3>
          <span className="sub">{tx("Up to 3", "حتى ٣")}</span>
        </div>
        <div style={{ padding: 18, display: "flex", gap: 8, flexWrap: "wrap" }}>
          {[tx("Add me", "أضفني"), tx("Tell me more", "المزيد"), tx("Not now", "ليس الآن")].map(
            (b) => (
              <span
                key={b}
                style={{
                  padding: "6px 14px",
                  borderRadius: 999,
                  background: "var(--bg-2)",
                  border: "1px solid var(--line)",
                  fontSize: 12,
                }}
              >
                {b}
              </span>
            ),
          )}
          <button className="btn ghost sm">
            <IconPlus w={12} />
          </button>
        </div>
      </div>
    </>
  );
}

interface ScheduleStepProps {
  tx: Tx;
}

function ScheduleStep({ tx }: ScheduleStepProps) {
  const options = [
    {
      label: tx("Send now", "إرسال الآن"),
      sub: tx("Begins immediately", "يبدأ فورًا"),
      on: false,
    },
    {
      label: tx("Schedule for later", "جدولة لاحقاً"),
      sub: "May 12, 2026 · 10:00 AM (Asia/Riyadh)",
      on: true,
    },
    {
      label: tx("Drip over time", "تنقيط عبر الوقت"),
      sub: tx(
        "Stagger across 4 hours · respect quiet hours",
        "موزّع على ٤ ساعات",
      ),
      on: false,
    },
    {
      label: tx("Trigger-based", "مبني على مشغل"),
      sub: tx("Send when a contact joins audience", "عند الانضمام للجمهور"),
      on: false,
    },
  ];
  return (
    <div className="card">
      <div className="card-h">
        <h3>{tx("Schedule", "الموعد")}</h3>
      </div>
      <div style={{ padding: 18, display: "grid", gap: 14 }}>
        {options.map((opt) => (
          <label
            key={opt.label}
            style={{
              display: "flex",
              gap: 12,
              padding: 14,
              background: opt.on ? "var(--accent-soft)" : "var(--bg-1)",
              border: `1px solid ${opt.on ? "var(--accent-ring)" : "var(--line-soft)"}`,
              borderRadius: 10,
              cursor: "pointer",
              alignItems: "center",
            }}
          >
            <span
              style={{
                width: 16,
                height: 16,
                borderRadius: "50%",
                border: `2px solid ${opt.on ? "var(--accent)" : "var(--line)"}`,
                display: "grid",
                placeItems: "center",
              }}
            >
              {opt.on && (
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "var(--accent)",
                  }}
                />
              )}
            </span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 500 }}>{opt.label}</div>
              <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>{opt.sub}</div>
            </div>
          </label>
        ))}
        <hr className="divider" />
        <Field label={tx("Quiet hours", "ساعات الهدوء")}>
          <span style={{ fontSize: 13 }}>22:00 — 08:00 Asia/Riyadh</span>
        </Field>
        <Field label={tx("Rate limit", "حد الإرسال")}>
          <span style={{ fontSize: 13 }}>250 / minute · gradual ramp</span>
        </Field>
      </div>
    </div>
  );
}

interface ReviewStepProps {
  tx: Tx;
}

function ReviewStep({ tx }: ReviewStepProps) {
  const checks: [string, "ok" | "warn"][] = [
    [tx("Template approved by Meta", "قالب معتمد"), "ok"],
    [tx("Audience size 624 — within plan limits", "الحجم ضمن الحد"), "ok"],
    [
      tx("Variable {{first_name}} populated for 622 / 624", "المتغير ممتلئ"),
      "warn",
    ],
    [tx("No opted-out contacts in audience", "لا توجد إلغاءات"), "ok"],
    [tx("Quiet hours respected", "يحترم ساعات الهدوء"), "ok"],
  ];
  return (
    <div className="card">
      <div className="card-h">
        <h3>{tx("Pre-flight checks", "الفحوصات النهائية")}</h3>
      </div>
      <div style={{ padding: 18, display: "grid", gap: 8 }}>
        {checks.map(([line, k]) => (
          <div
            key={line}
            style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}
          >
            {k === "ok" ? (
              <IconCheckCircle w={14} stroke={1.7} style={{ color: "var(--ok)" }} />
            ) : (
              <IconAlert w={14} stroke={1.7} style={{ color: "var(--warn)" }} />
            )}
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

interface PhonePreviewProps {
  body: string;
  tx: Tx;
}

function PhonePreview({ body, tx }: PhonePreviewProps) {
  const agent = AGENTS[0];
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
          {agent && <Avatar agent={agent} ai size="sm" />}
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
            <div style={{ display: "flex", gap: 4, marginTop: 8, flexWrap: "wrap" }}>
              {[
                tx("Add me", "أضفني"),
                tx("Tell me more", "المزيد"),
                tx("Not now", "ليس الآن"),
              ].map((b) => (
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
      <div
        style={{
          marginTop: 12,
          padding: 12,
          background: "var(--bg-1)",
          border: "1px solid var(--line-soft)",
          borderRadius: 10,
          fontSize: 12,
        }}
      >
        <div
          className="mono"
          style={{
            fontSize: 10,
            color: "var(--ink-3)",
            textTransform: "uppercase",
            marginBottom: 6,
          }}
        >
          {tx("Estimated cost", "التكلفة المتوقعة")}
        </div>
        <div
          style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}
        >
          <span className="muted">624 × $0.0386</span>
          <span className="mono">$24.09</span>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            color: "var(--accent)",
            fontWeight: 500,
          }}
        >
          <span>{tx("Total", "المجموع")}</span>
          <span className="mono">$24.09</span>
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
  const [step, setStep] = useState(2);
  const [body, setBody] = useState(
    tx(
      `Hi {{first_name}} 👋

We've just opened the waitlist for our spring drop — early access starts Friday at 10:00 AM Riyadh time.

Want me to add you?`,
      `أهلاً {{first_name}} 👋

افتتحنا قائمة انتظار تشكيلة الربيع — الوصول المبكر يبدأ الجمعة الساعة ١٠ صباحًا بتوقيت الرياض.

هل أضيفك؟`,
    ),
  );

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
          <h1
            style={{
              margin: 0,
              fontSize: 20,
              fontWeight: 600,
              letterSpacing: "-0.02em",
            }}
          >
            {tx("Spring drop · waitlist", "تشكيلة الربيع · قائمة الانتظار")}
          </h1>
          <div
            style={{
              color: "var(--ink-3)",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
            }}
          >
            {tx("Draft · auto-saved 12s ago", "مسودة · حفظ آخر منذ ١٢ث")}
          </div>
        </div>
        <button className="btn">{tx("Save draft", "حفظ مسودة")}</button>
        <button className="btn primary">
          <IconCheck w={13} />
          {tx("Schedule", "جدولة")}
        </button>
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
          {step === 1 && <AudienceStep tx={tx} />}
          {step === 2 && <MessageStep tx={tx} body={body} setBody={setBody} />}
          {step === 3 && <ScheduleStep tx={tx} />}
          {step === 4 && <ReviewStep tx={tx} />}

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
            <button
              className="btn primary"
              disabled={launching}
              onClick={() => {
                if (step === 4) {
                  void onLaunch({
                    name: tx("Spring drop · waitlist", "تشكيلة الربيع · قائمة الانتظار"),
                    audience: "All customers",
                    channel: "Broadcast",
                    agent: "atlas",
                    status: "draft",
                  });
                } else {
                  setStep((s) => Math.min(4, s + 1));
                }
              }}
            >
              {step === 4 ? tx("Schedule send", "جدولة الإرسال") : tx("Continue", "متابعة")}
              <IconChev w={12} />
            </button>
          </div>
        </div>

        <PhonePreview body={body} tx={tx} />
      </div>
    </div>
  );
}

function CampaignsImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const [view, setView] = useState<View>("list");
  const [tab, setTab] = useState<TabId>("all");

  const { data, loading, error, refetch } = useFetch<Campaign[]>("/campaigns");
  const campaigns: Campaign[] = data ?? [];

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
  const filtered = tab === "all" ? campaigns : campaigns.filter((c) => c.status === tab);

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
            <button className="btn">
              <IconTemplate w={13} />
              {tx("Templates", "قوالب")}
            </button>
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
            label={tx("Sent (30d)", "المرسلة (٣٠ي)")}
            value="48,212"
            sub="+8.4% vs last"
          />
          <MiniStat
            label={tx("Read rate", "معدل القراءة")}
            value="73.2%"
            sub="industry: 68%"
          />
          <MiniStat
            label={tx("Reply rate", "معدل الرد")}
            value="22.6%"
            sub="2,184 replies"
          />
          <MiniStat
            label={tx("Conversions", "التحويلات")}
            value="1,142"
            sub="SAR 92,400 attributed"
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
                const agent = AGENTS.find((a) => a.id === c.agent);
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
                        {agent && (
                          <>
                            <Avatar agent={agent} ai size="sm" />
                            <span>{agent.name}</span>
                          </>
                        )}
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
