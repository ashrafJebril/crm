import { memo, useState, type ReactNode } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx, type Tx } from "@/lib/tx";
import { Avatar } from "@/components/Avatar";
import { Badge } from "@/components/Badge";
import { Toggle } from "@/components/Toggle";
import {
  IconArrow,
  IconBolt,
  IconBook,
  IconMore,
  IconPlus,
  IconSend,
  IconSparkles,
} from "@/icons";
import { AGENTS } from "@/data/agents";
import { INTENTS } from "@/data/analytics";
import type { Agent, Lang } from "@/lib/types";

type TabId = "persona" | "knowledge" | "tools" | "escalation" | "analytics";

interface PlaygroundMessage {
  from: "them" | "ai";
  body: string;
  agent?: string;
}

const TAB_ORDER: TabId[] = ["persona", "knowledge", "tools", "escalation", "analytics"];

const TAB_LABELS_AR: Record<TabId, string> = {
  persona: "الشخصية",
  knowledge: "المعرفة",
  tools: "الأدوات",
  escalation: "التصعيد",
  analytics: "التحليلات",
};

const TAB_LABELS_EN: Record<TabId, string> = {
  persona: "Persona",
  knowledge: "Knowledge",
  tools: "Tools",
  escalation: "Escalation",
  analytics: "Analytics",
};

function Field({ label, children }: { label: string; children: ReactNode }) {
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

interface SliderRowProps {
  label: string;
  left: string;
  right: string;
  value: number;
}

function SliderRow({ label, left, right, value }: SliderRowProps) {
  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 12,
          marginBottom: 6,
        }}
      >
        <span style={{ color: "var(--ink-2)" }}>{label}</span>
        <span style={{ display: "flex", gap: 16, color: "var(--ink-3)", fontSize: 11 }}>
          <span>{left}</span>
          <span>{right}</span>
        </span>
      </div>
      <div
        style={{
          height: 4,
          background: "var(--bg-2)",
          borderRadius: 2,
          position: "relative",
        }}
      >
        <div
          style={{
            width: `${value * 100}%`,
            height: "100%",
            background: "var(--accent)",
            borderRadius: 2,
          }}
        />
        <div
          style={{
            position: "absolute",
            insetInlineStart: `calc(${value * 100}% - 7px)`,
            top: -5,
            width: 14,
            height: 14,
            borderRadius: "50%",
            background: "var(--accent)",
            border: "2px solid var(--bg)",
          }}
        />
      </div>
    </div>
  );
}

interface MiniStatProps {
  label: string;
  value: ReactNode;
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

function PersonaTab({ tx, active }: { tx: Tx; active: Agent }) {
  const avatarChoices: string[] = ["L", "O", "S", "X", "☆", "◎"];
  const langOptions: Array<[Lang | "fr" | "es", string]> = [
    ["en", "English"],
    ["ar", "العربية"],
    ["fr", "Français"],
    ["es", "Español"],
  ];
  return (
    <>
      <div className="card">
        <div className="card-h">
          <h3>{tx("Identity", "الهوية")}</h3>
        </div>
        <div style={{ padding: 18, display: "grid", gap: 14 }}>
          <Field label={tx("Name", "الاسم")}>
            <input defaultValue={active.name} className="inp" />
          </Field>
          <Field label={tx("Role / job", "الدور")}>
            <input defaultValue={active.role} className="inp" />
          </Field>
          <Field label={tx("Avatar", "الصورة")}>
            <div style={{ display: "flex", gap: 8 }}>
              {avatarChoices.map((em) => {
                const selected = em === active.emoji;
                return (
                  <div
                    key={em}
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 8,
                      display: "grid",
                      placeItems: "center",
                      background: selected ? "var(--accent-soft)" : "var(--bg-2)",
                      border: `1px solid ${
                        selected ? "var(--accent-ring)" : "var(--line-soft)"
                      }`,
                      fontFamily: "var(--font-display)",
                      fontStyle: "italic",
                      fontSize: 16,
                      cursor: "pointer",
                      color: selected ? "var(--accent)" : "var(--ink-2)",
                    }}
                  >
                    {em}
                  </div>
                );
              })}
            </div>
          </Field>
          <Field label={tx("Languages", "اللغات")}>
            <div style={{ display: "flex", gap: 6 }}>
              {langOptions.map(([k, n]) => {
                const on =
                  k === "en" || k === "ar" ? active.lang.includes(k as Lang) : false;
                return (
                  <span key={k} className={`badge ${on ? "ai" : ""}`.trim()}>
                    {n}
                  </span>
                );
              })}
            </div>
          </Field>
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h3>{tx("Personality & tone", "الشخصية والأسلوب")}</h3>
        </div>
        <div style={{ padding: 18, display: "grid", gap: 16 }}>
          <SliderRow
            label={tx("Formality", "الرسمية")}
            left={tx("Casual", "مرح")}
            right={tx("Formal", "رسمي")}
            value={0.4}
          />
          <SliderRow
            label={tx("Verbosity", "الإسهاب")}
            left={tx("Brief", "مختصر")}
            right={tx("Detailed", "مفصّل")}
            value={0.55}
          />
          <SliderRow
            label={tx("Warmth", "الدفء")}
            left={tx("Neutral", "محايد")}
            right={tx("Warm", "ودود")}
            value={0.75}
          />
          <SliderRow
            label={tx("Proactivity", "المبادرة")}
            left={tx("Reactive", "تفاعلي")}
            right={tx("Suggesting", "يقترح")}
            value={0.65}
          />
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h3>{tx("System prompt", "التعليمات")}</h3>
          <span className="sub mono">1,420 / 4,000 tokens</span>
        </div>
        <div style={{ padding: 0 }}>
          <pre
            className="prompt-edit"
            style={{
              margin: 0,
              padding: 18,
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              lineHeight: 1.6,
              color: "var(--ink-1)",
              whiteSpace: "pre-wrap",
            }}
          >
            {`You are ${active.name}, a ${active.role.toLowerCase()} for Samemha.
You operate exclusively over WhatsApp Business.

# Voice
- Warm, professional, never pushy.
- Reply in the language the customer writes in (Arabic or English).
- Keep first replies under 280 characters when possible.

# Capabilities
- Look up listings, availability, pricing.
- Schedule and reschedule property viewings.
- Share floor plans, photo decks, location pins.
- Generate qualified leads (name, intent, budget, timeline).

# Escalation
- Hand off to a human agent if: contract terms, pricing
  negotiation, complaints, or anything outside listings.

# Boundaries
- Never quote prices not listed in the catalog.
- Never make commitments on behalf of the broker.
`}
          </pre>
        </div>
      </div>
    </>
  );
}

interface KnowledgeSource {
  type: "PDF" | "URL" | "CSV" | "DOC" | "API";
  name: string;
  size: string;
  chunks: number;
  status: "indexed" | "indexing" | "live";
}

function KnowledgeTab({ tx }: { tx: Tx }) {
  const sources: KnowledgeSource[] = [
    { type: "PDF", name: "Samemha catalog · Q2 2026.pdf", size: "4.2 MB", chunks: 412, status: "indexed" },
    { type: "URL", name: "samemha.com/products", size: "—", chunks: 184, status: "indexed" },
    { type: "CSV", name: "pricing-catalog.csv", size: "112 KB", chunks: 96, status: "indexed" },
    { type: "DOC", name: "FAQ — viewing process.docx", size: "84 KB", chunks: 28, status: "indexing" },
    { type: "API", name: "Booking API (live)", size: "—", chunks: 0, status: "live" },
  ];
  return (
    <div className="card">
      <div className="card-h">
        <div>
          <h3>{tx("Knowledge sources", "مصادر المعرفة")}</h3>
          <div className="sub">
            {tx(
              "720 chunks · 1.4M tokens · refreshed 12m ago",
              "٧٢٠ مقطعًا · ١٫٤ مليون رمز",
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button className="btn">
            <IconBook w={13} />
            {tx("Upload", "رفع")}
          </button>
          <button className="btn primary">
            <IconPlus w={13} />
            {tx("Add source", "إضافة")}
          </button>
        </div>
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th style={{ width: 60 }}>{tx("Type", "النوع")}</th>
            <th>{tx("Source", "المصدر")}</th>
            <th>{tx("Size", "الحجم")}</th>
            <th>{tx("Chunks", "المقاطع")}</th>
            <th>{tx("Status", "الحالة")}</th>
            <th style={{ width: 40 }} aria-label="actions" />
          </tr>
        </thead>
        <tbody>
          {sources.map((s) => (
            <tr key={s.name}>
              <td>
                <span className="badge mono">{s.type}</span>
              </td>
              <td style={{ fontWeight: 500 }}>{s.name}</td>
              <td className="mono muted">{s.size}</td>
              <td className="mono">{s.chunks || "—"}</td>
              <td>
                {s.status === "indexed" && (
                  <Badge kind="ok" dot>
                    indexed
                  </Badge>
                )}
                {s.status === "indexing" && (
                  <Badge kind="warn" dot>
                    indexing
                  </Badge>
                )}
                {s.status === "live" && (
                  <Badge kind="ai" dot>
                    live API
                  </Badge>
                )}
              </td>
              <td>
                <button className="btn ghost icon sm">
                  <IconMore w={14} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface ToolDef {
  name: string;
  desc: string;
  on: boolean;
}

function ToolsTab({ tx }: { tx: Tx }) {
  const initialTools: ToolDef[] = [
    { name: "search_listings",      desc: tx("Look up properties by area, price, bedrooms", "ابحث عن عقارات"), on: true },
    { name: "schedule_viewing",     desc: tx("Book a property viewing in the calendar", "حجز معاينة"),         on: true },
    { name: "send_floor_plan",      desc: tx("Email or WhatsApp a floor plan PDF", "إرسال مخطط"),              on: true },
    { name: "qualify_lead",         desc: tx("Save lead with budget, timeline, intent", "تأهيل عميل"),         on: true },
    { name: "make_payment_link",    desc: tx("Generate Stripe / HyperPay link", "إنشاء رابط دفع"),             on: false },
    { name: "create_calendar_invite", desc: tx("Send .ics calendar invite", "دعوة تقويم"),                     on: true },
  ];
  const [tools, setTools] = useState<ToolDef[]>(initialTools);

  const toggle = (name: string, on: boolean) => {
    setTools((prev) => prev.map((t) => (t.name === name ? { ...t, on } : t)));
  };

  return (
    <div className="card">
      <div className="card-h">
        <h3>{tx("Tools & integrations", "الأدوات والتكاملات")}</h3>
        <button className="btn primary">
          <IconPlus w={13} />
          {tx("Add tool", "إضافة")}
        </button>
      </div>
      <div style={{ padding: 6 }}>
        {tools.map((tool) => (
          <div
            key={tool.name}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              padding: 14,
              borderBottom: "1px solid var(--line-soft)",
            }}
          >
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: tool.on ? "var(--accent-soft)" : "var(--bg-2)",
                display: "grid",
                placeItems: "center",
                color: tool.on ? "var(--accent)" : "var(--ink-3)",
              }}
            >
              <IconBolt w={16} />
            </div>
            <div style={{ flex: 1 }}>
              <div className="mono" style={{ fontSize: 13, fontWeight: 500 }}>
                {tool.name}()
              </div>
              <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{tool.desc}</div>
            </div>
            <Toggle on={tool.on} onChange={(v) => toggle(tool.name, v)} />
          </div>
        ))}
      </div>
    </div>
  );
}

interface EscalationRule {
  when: string;
  then: string;
  on: boolean;
}

function EscalationTab({ tx }: { tx: Tx }) {
  const initialRules: EscalationRule[] = [
    { when: tx("Customer asks for refund", "يطلب العميل استرداداً"),         then: tx("→ assign Lina", "→ تعيين Lina"),  on: true },
    { when: tx("Confidence below 70%", "الثقة أقل من ٧٠٪"),                  then: tx("→ ask for human", "→ طلب موظف"), on: true },
    { when: tx("Message in language not supported", "رسالة بلغة غير مدعومة"), then: tx("→ assign Karim", "→ تعيين Karim"), on: true },
    { when: tx('Customer says "speak to a manager"', 'يقول العميل "أريد المدير"'), then: tx("→ assign Owner", "→ تعيين المالك"), on: true },
    { when: tx("Sentiment becomes negative", "تحول النبرة لسلبية"),          then: tx("→ ping #escalations", "→ تنبيه القناة"), on: false },
  ];
  const [rules, setRules] = useState<EscalationRule[]>(initialRules);

  const toggle = (idx: number, on: boolean) => {
    setRules((prev) => prev.map((r, i) => (i === idx ? { ...r, on } : r)));
  };

  return (
    <div className="card">
      <div className="card-h">
        <div>
          <h3>{tx("Escalation rules", "قواعد التصعيد")}</h3>
          <div className="sub">{tx("When to hand off to a human", "متى تحوّل إلى موظف")}</div>
        </div>
      </div>
      <div style={{ padding: 18, display: "grid", gap: 12 }}>
        {rules.map((rule, i) => (
          <div
            key={`${rule.when}-${i}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: 12,
              background: "var(--bg-1)",
              borderRadius: 10,
              border: "1px solid var(--line-soft)",
            }}
          >
            <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
              {String(i + 1).padStart(2, "0")}
            </span>
            <div
              style={{
                flex: 1,
                display: "grid",
                gridTemplateColumns: "1fr auto 1fr",
                alignItems: "center",
                gap: 12,
              }}
            >
              <div
                style={{
                  padding: 8,
                  background: "var(--bg-2)",
                  borderRadius: 6,
                  fontSize: 12,
                }}
              >
                <span className="mono muted" style={{ fontSize: 10 }}>
                  WHEN
                </span>
                <div>{rule.when}</div>
              </div>
              <IconArrow w={14} />
              <div
                style={{
                  padding: 8,
                  background: "var(--accent-soft)",
                  borderRadius: 6,
                  fontSize: 12,
                  color: "var(--accent)",
                }}
              >
                <span className="mono" style={{ fontSize: 10, opacity: 0.7 }}>
                  THEN
                </span>
                <div>{rule.then}</div>
              </div>
            </div>
            <Toggle on={rule.on} onChange={(v) => toggle(i, v)} />
          </div>
        ))}
        <button className="btn ghost" style={{ alignSelf: "start" }}>
          <IconPlus w={13} />
          {tx("Add rule", "قاعدة جديدة")}
        </button>
      </div>
    </div>
  );
}

function AgentAnalytics({ tx, active }: { tx: Tx; active: Agent }) {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        <MiniStat
          label={tx("Conversations", "محادثات")}
          value={active.convs}
          sub="last 7d"
        />
        <MiniStat
          label={tx("CSAT", "تقييم")}
          value={`${active.csat}%`}
          sub={`${Math.round(active.convs * 0.6)} ratings`}
        />
        <MiniStat label={tx("Avg time", "الوقت")} value="42s" sub="first reply" />
        <MiniStat
          label={tx("Auto-resolved", "حل ذاتي")}
          value="84%"
          sub="no escalation"
        />
      </div>
      <div className="card">
        <div className="card-h">
          <h3>{tx("Top intents handled", "أهم النوايا")}</h3>
        </div>
        <div style={{ padding: 18 }}>
          {INTENTS.slice(0, 5).map((it, i) => (
            <div
              key={it.name}
              style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0" }}
            >
              <span style={{ fontSize: 13, width: 140 }}>{it.name}</span>
              <div
                style={{
                  flex: 1,
                  height: 6,
                  background: "var(--bg-2)",
                  borderRadius: 3,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${it.pct * 3}%`,
                    height: "100%",
                    background: "var(--accent)",
                    opacity: 0.4 + i * 0.1,
                  }}
                />
              </div>
              <span
                className="mono"
                style={{ fontSize: 12, color: "var(--ink-2)", width: 60, textAlign: "end" }}
              >
                {it.count}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Playground({ tx, active }: { tx: Tx; active: Agent }) {
  const [msgs, setMsgs] = useState<PlaygroundMessage[]>([
    {
      from: "them",
      body: tx(
        "Hi! I'm interested in the 3-bed in Olaya tower. What's the rent?",
        "مرحبًا! أهتم بشقة الثلاث غرف في برج العليا. كم الإيجار؟",
      ),
    },
    {
      from: "ai",
      body: tx(
        "Hi! That's unit 18-B at SAR 142,000/year, including 2 reserved parking spots. Want me to send the floor plan and book a viewing?",
        "أهلًا! وحدة 18-B بسعر 142,000 ريال/سنة مع موقفين. أرسل لك المخطط؟",
      ),
      agent: active.id,
    },
  ]);
  const [draft, setDraft] = useState("");

  const send = () => {
    if (!draft.trim()) return;
    const next: PlaygroundMessage = { from: "them", body: draft };
    setMsgs((prev) => [...prev, next]);
    setDraft("");
    setTimeout(() => {
      setMsgs((prev) => [
        ...prev,
        {
          from: "ai",
          body: tx(
            "Great — I have Saturday at 5:30 PM open. Shall I book it?",
            "ممتاز، السبت ٥:٣٠ مساءً متاح. أحجز؟",
          ),
          agent: active.id,
        },
      ]);
    }, 600);
  };

  const quickReplies: string[] = [
    tx("What are your hours?", "ما ساعات العمل؟"),
    tx("Cancel my booking", "ألغ حجزي"),
    tx("Speak to a person", "أريد موظفاً"),
  ];

  return (
    <aside
      style={{
        borderInlineStart: "1px solid var(--line-soft)",
        background: "var(--bg-1)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <div
        style={{
          padding: "16px 18px",
          borderBottom: "1px solid var(--line-soft)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <IconSparkles w={14} />
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
            {tx("Playground", "تجربة")}
          </h3>
          <Badge kind="ai" dot>
            {active.name}
          </Badge>
        </div>
        <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 4 }}>
          {tx(
            "Test messages without affecting real customers",
            "رسائل تجريبية لا تؤثر على عملائك",
          )}
        </div>
      </div>
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 14,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {msgs.map((m, i) => (
          <div
            key={`${m.from}-${i}`}
            style={{
              display: "flex",
              justifyContent: m.from === "ai" ? "flex-end" : "flex-start",
            }}
          >
            <div
              style={{
                maxWidth: "84%",
                padding: "8px 12px",
                fontSize: 13.5,
                lineHeight: 1.5,
                borderRadius: m.from === "ai" ? "12px 12px 4px 12px" : "12px 12px 12px 4px",
                background: m.from === "ai" ? "var(--bubble-out)" : "var(--bg-2)",
                border: `1px solid ${
                  m.from === "ai" ? "var(--bubble-out-line)" : "var(--line-soft)"
                }`,
              }}
            >
              {m.body}
            </div>
          </div>
        ))}
      </div>
      <div style={{ padding: 12, borderTop: "1px solid var(--line-soft)" }}>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            className="inp"
            style={{ flex: 1 }}
            placeholder={tx("Type as a customer…", "اكتب كعميل…")}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") send();
            }}
          />
          <button className="btn primary" onClick={send}>
            <IconSend w={13} />
          </button>
        </div>
        <div style={{ display: "flex", gap: 4, marginTop: 8, flexWrap: "wrap" }}>
          {quickReplies.map((s) => (
            <button
              key={s}
              className="btn ghost sm"
              style={{ fontSize: 11 }}
              onClick={() => setDraft(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
      <style>{`.inp{height:32px;padding:0 10px;border-radius:8px;background:var(--bg-2);border:1px solid var(--line-soft);color:var(--ink);font-size:13px;outline:0;width:100%}
        .inp:focus{border-color:var(--accent-ring);box-shadow:0 0 0 3px var(--accent-soft)}`}</style>
    </aside>
  );
}

function AgentsImpl() {
  const { t, setTweak } = useTweaks();
  const tx = makeTx(t.lang);
  const [activeId, setActiveId] = useState<string>("luna");
  const [tab, setTab] = useState<TabId>("persona");
  // Reading setTweak ensures the hook returns its full shape — kept available
  // for future inline panel toggles without changing the import surface.
  void setTweak;

  const active: Agent = AGENTS.find((a) => a.id === activeId) ?? AGENTS[0]!;

  const labelFor = (k: TabId): string =>
    t.lang === "ar" ? TAB_LABELS_AR[k] : TAB_LABELS_EN[k];

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "260px 1fr 380px",
        flex: 1,
        minHeight: 0,
      }}
    >
      <div
        style={{
          borderInlineEnd: "1px solid var(--line-soft)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <div
          style={{
            padding: "16px 14px",
            borderBottom: "1px solid var(--line-soft)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
              {tx("AI agents", "الوكلاء")}
            </h2>
            <button className="btn primary sm">
              <IconPlus w={12} />
              {tx("New", "جديد")}
            </button>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 6 }}>
          {AGENTS.map((a) => (
            <div
              key={a.id}
              onClick={() => setActiveId(a.id)}
              style={{
                display: "flex",
                gap: 10,
                alignItems: "center",
                padding: 10,
                borderRadius: 8,
                cursor: "pointer",
                background: activeId === a.id ? "var(--bg-2)" : "transparent",
                borderInlineStart:
                  activeId === a.id
                    ? "2px solid var(--accent)"
                    : "2px solid transparent",
              }}
            >
              <Avatar agent={a} ai size="lg" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontWeight: 500 }}>{a.name}</span>
                  {a.status === "live" ? (
                    <Badge kind="ok" dot>
                      live
                    </Badge>
                  ) : (
                    <Badge>draft</Badge>
                  )}
                </div>
                <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{a.role}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div
          style={{
            padding: "16px 24px",
            borderBottom: "1px solid var(--line-soft)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <Avatar agent={active} ai size="xl" />
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>
                  {active.name}
                </h1>
                <Badge kind="ok" dot>
                  live
                </Badge>
                <span className="badge mono">{active.model}</span>
              </div>
              <div
                style={{ color: "var(--ink-2)", fontSize: 13, marginTop: 2 }}
              >
                {active.role} · {tx("speaks", "يتحدث")}{" "}
                {active.lang.join(", ").toUpperCase()}
              </div>
            </div>
            <Toggle
              on={active.status === "live"}
              onChange={() => {
                /* visual toggle — agent status edits live elsewhere */
              }}
              label={tx("Active", "نشط")}
            />
            <button className="btn ghost">
              <IconMore w={16} />
            </button>
          </div>
          <div style={{ display: "flex", gap: 18, marginTop: 14 }}>
            {TAB_ORDER.map((k) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                style={{
                  background: "transparent",
                  border: 0,
                  padding: "6px 0",
                  cursor: "pointer",
                  color: tab === k ? "var(--ink)" : "var(--ink-3)",
                  borderBottom: `2px solid ${
                    tab === k ? "var(--accent)" : "transparent"
                  }`,
                  fontSize: 13,
                  fontWeight: 500,
                  marginBottom: -2,
                }}
              >
                {labelFor(k)}
              </button>
            ))}
          </div>
        </div>

        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: 24,
            display: "grid",
            gap: 16,
          }}
        >
          {tab === "persona" && <PersonaTab tx={tx} active={active} />}
          {tab === "knowledge" && <KnowledgeTab tx={tx} />}
          {tab === "tools" && <ToolsTab tx={tx} />}
          {tab === "escalation" && <EscalationTab tx={tx} />}
          {tab === "analytics" && <AgentAnalytics tx={tx} active={active} />}
        </div>
      </div>

      <Playground tx={tx} active={active} />
    </div>
  );
}

const Agents = memo(AgentsImpl);
export default Agents;
