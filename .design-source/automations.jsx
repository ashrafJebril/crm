// src/screens/automations.jsx — visual node-graph workflow builder

function ScreenAutomations({ t }) {
  const isAr = t.lang === "ar";
  const tx = (en, ar) => isAr ? ar : en;
  const [view, setView] = useState("builder"); // list | builder

  if (view === "list") return <AutomationsList tx={tx} setView={setView} />;
  return <AutomationBuilder tx={tx} setView={setView} />;
}

function AutomationsList({ tx, setView }) {
  const flows = [
    { name: tx("Abandoned cart recovery","استرجاع السلة"), trigger: "Cart > 24h", runs: 412, success: "94%", status: "running" },
    { name: tx("Appointment reminder · 24h","تذكير موعد"), trigger: "Booking · T-24h", runs: 156, success: "99%", status: "running" },
    { name: tx("Lead routing · region","توجيه العملاء"), trigger: "New lead", runs: 84, success: "100%", status: "running" },
    { name: tx("Post-purchase NPS","استبيان رضا"), trigger: "Order delivered + 3d", runs: 287, success: "88%", status: "paused" },
    { name: tx("Welcome series · 5 messages","رسائل ترحيب"), trigger: "Subscribe", runs: 1820, success: "92%", status: "running" },
  ];
  return (
    <div style={{ overflowY: "auto", flex: 1 }}>
      <PageHeader
        title={tx("Automations","الأتمتة")}
        subtitle={tx("Trigger-based workflows that run while you sleep","سير عمل آلي يعمل بدلًا عنك")}
        actions={<>
          <button className="btn"><IconTemplate w={13} />{tx("Templates","قوالب")}</button>
          <button className="btn primary" onClick={() => setView("builder")}><IconPlus w={13} />{tx("New workflow","جديد")}</button>
        </>}
      />
      <div style={{ padding: "0 24px 24px" }}>
        <div className="card" style={{ padding: 0 }}>
          <table className="tbl">
            <thead><tr>
              <th>{tx("Workflow","سير العمل")}</th>
              <th>{tx("Trigger","المشغل")}</th>
              <th>{tx("Runs (7d)","تشغيلات")}</th>
              <th>{tx("Success","النجاح")}</th>
              <th>{tx("Status","الحالة")}</th>
              <th></th>
            </tr></thead>
            <tbody>
              {flows.map(f => (
                <tr key={f.name} onClick={() => setView("builder")} style={{ cursor: "pointer" }}>
                  <td><div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 28, height: 28, borderRadius: 6, background: "var(--accent-soft)", color: "var(--accent)", display: "grid", placeItems: "center" }}><IconFlow w={14} /></span>
                    <span style={{ fontWeight: 500 }}>{f.name}</span>
                  </div></td>
                  <td><span className="badge mono">{f.trigger}</span></td>
                  <td className="mono">{f.runs}</td>
                  <td className="mono" style={{ color: "var(--ok)" }}>{f.success}</td>
                  <td>{f.status === "running"
                    ? <Badge kind="ok" dot>running</Badge>
                    : <Badge kind="warn" dot>paused</Badge>}</td>
                  <td><button className="btn ghost icon sm"><IconMore w={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Visual flow builder ─────────────────────────────────────────────────
const NODE_W = 220;
const NODE_H = 88;

const NODES = [
  { id: "n1", x: 60,  y: 80,  type: "trigger",  title: "When cart abandoned",   sub: "Cart inactive > 1h",                                  icon: "bolt"  },
  { id: "n2", x: 340, y: 80,  type: "delay",    title: "Wait 1 hour",           sub: "Respect quiet hours · 22:00–08:00",                  icon: "clock" },
  { id: "n3", x: 620, y: 80,  type: "ai",       title: "Atlas messages contact",sub: "Personalized recovery · template: cart_recovery_v3", icon: "bot",  agent: "atlas" },
  { id: "n4", x: 900, y: 80,  type: "branch",   title: "Did they reply?",       sub: "Branch on reply within 24h",                          icon: "route" },
  { id: "n5", x: 1180, y: -20, type: "action",  title: "Apply 10% discount code",sub: "Generate single-use code → send",                    icon: "tag",  branch: "yes" },
  { id: "n6", x: 1180, y: 180, type: "delay",   title: "Wait 24 hours",          sub: "Then retry with different angle",                    icon: "clock", branch: "no" },
  { id: "n7", x: 1180, y: 320, type: "action",  title: "Mark as cold lead",      sub: "Tag · cold · stop sequence",                          icon: "tag",   branch: "no2" },
];

const EDGES = [
  { from: "n1", to: "n2" },
  { from: "n2", to: "n3" },
  { from: "n3", to: "n4" },
  { from: "n4", to: "n5", label: "yes" },
  { from: "n4", to: "n6", label: "no, after 24h" },
  { from: "n6", to: "n7" },
];

function AutomationBuilder({ tx, setView }) {
  const [selected, setSelected] = useState("n3");

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div style={{ padding: "16px 24px", display: "flex", alignItems: "center", gap: 12,
                    borderBottom: "1px solid var(--line-soft)" }}>
        <button className="btn ghost icon" onClick={() => setView("list")}>
          <IconChev w={14} style={{ transform: "rotate(180deg)" }} />
        </button>
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600, letterSpacing: "-0.01em" }}>
            {tx("Abandoned cart recovery","استرجاع السلة")}
          </h1>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)" }}>
            {tx("Last edited 6m ago by Yara","آخر تعديل قبل ٦د")}
          </div>
        </div>
        <Badge kind="ok" dot>running</Badge>
        <button className="btn"><IconPlay w={12} />{tx("Test run","تشغيل تجريبي")}</button>
        <button className="btn"><IconBook w={12} />{tx("Logs","سجلات")}</button>
        <button className="btn primary"><IconCheck w={13} />{tx("Save","حفظ")}</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "220px 1fr 320px", flex: 1, minHeight: 0 }}>
        {/* node palette */}
        <div style={{ borderInlineEnd: "1px solid var(--line-soft)", padding: 12, overflowY: "auto" }}>
          <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase", margin: "4px 0 8px" }}>{tx("Triggers","مشغلات")}</div>
          <PalNode kind="trigger" label={tx("New message","رسالة جديدة")} />
          <PalNode kind="trigger" label={tx("Contact created","جهة جديدة")} />
          <PalNode kind="trigger" label={tx("Tag added","أُضيف وسم")} />
          <PalNode kind="trigger" label={tx("Cart abandoned","سلة مهجورة")} />
          <PalNode kind="trigger" label={tx("Webhook","Webhook")} />
          <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase", margin: "16px 0 8px" }}>{tx("AI actions","ذكاء")}</div>
          <PalNode kind="ai" label={tx("AI agent reply","رد وكيل")} />
          <PalNode kind="ai" label={tx("Classify intent","تصنيف نية")} />
          <PalNode kind="ai" label={tx("Score lead","تقييم عميل")} />
          <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase", margin: "16px 0 8px" }}>{tx("Actions","إجراءات")}</div>
          <PalNode kind="action" label={tx("Send template","إرسال قالب")} />
          <PalNode kind="action" label={tx("Apply tag","إضافة وسم")} />
          <PalNode kind="action" label={tx("Assign to agent","تعيين موظف")} />
          <PalNode kind="action" label={tx("HTTP request","طلب HTTP")} />
          <PalNode kind="delay" label={tx("Wait","انتظار")} />
          <PalNode kind="branch" label={tx("If / else","شرط")} />
        </div>

        {/* canvas */}
        <FlowCanvas selected={selected} setSelected={setSelected} />

        {/* inspector */}
        <NodeInspector tx={tx} node={NODES.find(n => n.id === selected)} />
      </div>
    </div>
  );
}

function PalNode({ kind, label }) {
  const colors = {
    trigger: { bg: "oklch(0.74 0.13 240 / 0.12)", border: "oklch(0.74 0.13 240 / 0.35)", icon: "var(--info)", glyph: <IconBolt w={14} /> },
    ai:      { bg: "var(--accent-soft)",          border: "var(--accent-ring)",          icon: "var(--accent)", glyph: <IconSparkles w={14} /> },
    action:  { bg: "var(--bg-2)",                 border: "var(--line)",                  icon: "var(--ink-1)", glyph: <IconBolt w={14} /> },
    delay:   { bg: "oklch(0.82 0.17 78 / 0.12)",  border: "oklch(0.82 0.17 78 / 0.35)",   icon: "var(--warn)",   glyph: <IconClock w={14} /> },
    branch:  { bg: "oklch(0.72 0.22 350 / 0.12)", border: "oklch(0.72 0.22 350 / 0.35)",  icon: "var(--bad)",    glyph: <IconRoute w={14} /> },
  }[kind];
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      padding: "8px 10px", marginBottom: 4,
      background: colors.bg, border: `1px solid ${colors.border}`,
      borderRadius: 8, cursor: "grab", color: colors.icon, fontSize: 12, fontWeight: 500,
    }}>
      {colors.glyph}<span style={{ color: "var(--ink)" }}>{label}</span>
    </div>
  );
}

function FlowCanvas({ selected, setSelected }) {
  const W = 1440, H = 460;
  const nodeRect = (n) => ({ left: n.x, right: n.x + NODE_W, top: n.y, bottom: n.y + NODE_H, mid: n.y + NODE_H / 2 });

  return (
    <div style={{
      position: "relative",
      overflow: "auto",
      background: "var(--bg)",
      backgroundImage: `radial-gradient(circle, var(--grid) 1px, transparent 1px)`,
      backgroundSize: "24px 24px",
      backgroundPosition: "0 0",
    }}>
      <div style={{ position: "relative", width: W, height: H, padding: 60 }}>
        {/* edges */}
        <svg width={W} height={H} style={{ position: "absolute", inset: 60, pointerEvents: "none" }}>
          {EDGES.map((e, i) => {
            const a = NODES.find(n => n.id === e.from), b = NODES.find(n => n.id === e.to);
            const ar = nodeRect(a), br = nodeRect(b);
            const x1 = ar.right, y1 = ar.mid, x2 = br.left, y2 = br.mid;
            const cx = (x1 + x2) / 2;
            const path = `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;
            return (
              <g key={i}>
                <path d={path} fill="none" stroke="var(--ink-3)" strokeWidth="1.5" strokeDasharray="4 4" />
                <circle cx={x2 - 4} cy={y2} r="3" fill="var(--ink-2)" />
                {e.label && (
                  <g>
                    <rect x={cx - 22} y={y2 - 22 + (y1 - y2) / 2} width={44} height={18} rx="9"
                          fill="var(--bg-elev)" stroke="var(--line)" />
                    <text x={cx} y={y2 - 9 + (y1 - y2) / 2} fontSize="10" fontFamily="var(--font-mono)"
                          fill="var(--ink-2)" textAnchor="middle">{e.label}</text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>

        {NODES.map(n => <FlowNode key={n.id} node={n} selected={selected === n.id} onSelect={() => setSelected(n.id)} />)}
      </div>

      {/* canvas controls */}
      <div style={{ position: "sticky", bottom: 12, marginInlineStart: 12, display: "inline-flex", gap: 4,
                   background: "var(--bg-elev)", border: "1px solid var(--line)", borderRadius: 8, padding: 4 }}>
        <button className="btn ghost icon sm">−</button>
        <span className="mono" style={{ fontSize: 11, color: "var(--ink-2)", padding: "0 8px", display: "grid", placeItems: "center" }}>100%</span>
        <button className="btn ghost icon sm">+</button>
        <span style={{ width: 1, background: "var(--line-soft)" }} />
        <button className="btn ghost icon sm" title="Fit"><IconLayers w={12} /></button>
      </div>
    </div>
  );
}

function FlowNode({ node, selected, onSelect }) {
  const styles = {
    trigger: { color: "var(--info)", soft: "oklch(0.74 0.13 240 / 0.12)", ring: "oklch(0.74 0.13 240 / 0.35)", icon: <IconBolt w={14} /> },
    ai:      { color: "var(--accent)", soft: "var(--accent-soft)", ring: "var(--accent-ring)", icon: <IconSparkles w={14} /> },
    action:  { color: "var(--ink-1)", soft: "var(--bg-2)", ring: "var(--line)", icon: <IconTag w={14} /> },
    delay:   { color: "var(--warn)", soft: "oklch(0.82 0.17 78 / 0.12)", ring: "oklch(0.82 0.17 78 / 0.35)", icon: <IconClock w={14} /> },
    branch:  { color: "var(--bad)", soft: "oklch(0.72 0.22 350 / 0.12)", ring: "oklch(0.72 0.22 350 / 0.35)", icon: <IconRoute w={14} /> },
  }[node.type];

  return (
    <div onClick={onSelect}
         style={{
           position: "absolute",
           left: node.x, top: node.y,
           width: NODE_W, minHeight: NODE_H,
           background: "var(--bg-elev)",
           border: `1px solid ${selected ? "var(--accent)" : "var(--line)"}`,
           boxShadow: selected ? "0 0 0 3px var(--accent-soft)" : "var(--shadow-sm)",
           borderRadius: 12,
           padding: 12,
           cursor: "pointer",
         }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ width: 22, height: 22, borderRadius: 6, background: styles.soft, color: styles.color,
                       display: "grid", placeItems: "center", border: `1px solid ${styles.ring}` }}>{styles.icon}</span>
        <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", textTransform: "uppercase",
                       color: styles.color, letterSpacing: 0.06, fontWeight: 500 }}>{node.type}</span>
        {node.agent && <Avatar agent={AGENTS.find(a => a.id === node.agent)} ai size="sm" />}
      </div>
      <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 3 }}>{node.title}</div>
      <div style={{ fontSize: 11, color: "var(--ink-3)", lineHeight: 1.4 }}>{node.sub}</div>
      {/* connection ports */}
      <span style={{ position: "absolute", insetInlineStart: -5, top: NODE_H / 2 - 5, width: 10, height: 10,
                    borderRadius: "50%", background: "var(--bg-elev)", border: "1.5px solid var(--ink-3)" }} />
      <span style={{ position: "absolute", insetInlineEnd: -5, top: NODE_H / 2 - 5, width: 10, height: 10,
                    borderRadius: "50%", background: styles.color }} />
    </div>
  );
}

function NodeInspector({ tx, node }) {
  if (!node) return <aside style={{ borderInlineStart: "1px solid var(--line-soft)", background: "var(--bg-1)" }} />;
  const isAi = node.type === "ai";
  return (
    <aside style={{ borderInlineStart: "1px solid var(--line-soft)", background: "var(--bg-1)",
                    overflowY: "auto", padding: 18, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase" }}>{tx("Step","خطوة")} · {node.type}</div>
        <h3 style={{ margin: "4px 0 4px", fontSize: 16, fontWeight: 600 }}>{node.title}</h3>
        <div style={{ fontSize: 12, color: "var(--ink-2)" }}>{node.sub}</div>
      </div>

      {isAi && (
        <div style={{ padding: 10, borderRadius: 10, border: "1px solid var(--accent-ring)", background: "var(--accent-soft)",
                      display: "flex", gap: 10, alignItems: "center" }}>
          <Avatar agent={AGENTS.find(a => a.id === node.agent)} ai size="lg" />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 500 }}>Atlas</div>
            <div style={{ fontSize: 11, color: "var(--ink-2)" }}>{tx("Customer Support agent","وكيل دعم")}</div>
          </div>
          <button className="btn ghost sm"><IconChevDown w={12} /></button>
        </div>
      )}

      <div>
        <SectionLabel>{tx("Configuration","الإعدادات")}</SectionLabel>
        <div style={{ marginTop: 10, display: "grid", gap: 12 }}>
          {isAi && (
            <Field2 label={tx("Template","القالب")}>
              <select className="inp"><option>cart_recovery_v3</option></select>
            </Field2>
          )}
          {node.type === "delay" && (
            <Field2 label={tx("Duration","المدة")}>
              <div style={{ display: "flex", gap: 6 }}>
                <input className="inp" defaultValue="1" style={{ width: 60 }} />
                <select className="inp" style={{ flex: 1 }}><option>hours</option><option>days</option></select>
              </div>
            </Field2>
          )}
          <Field2 label={tx("Run as","الوكيل")}>
            <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
              <Avatar agent={AGENTS[1]} ai size="sm" />Atlas
            </span>
          </Field2>
          <Field2 label={tx("Skip if quiet hours","تجاوز ساعات الهدوء")}>
            <Toggle on={true} />
          </Field2>
        </div>
      </div>

      <div>
        <SectionLabel>{tx("Recent runs","تشغيلات حديثة")}</SectionLabel>
        <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
          {[
            ["10:42", "Reem Al-Qahtani", "ok"],
            ["10:38", "Sven Lindgren",   "ok"],
            ["10:31", "James Whitman",   "ok"],
            ["10:14", "Hugo Martín",     "warn"],
            ["09:58", "Priya V.",        "ok"],
          ].map(([t, name, k], i) => (
            <div key={i} style={{ display: "flex", gap: 10, alignItems: "center", padding: "6px 10px",
                                 background: "var(--bg-2)", borderRadius: 6, fontSize: 12 }}>
              <span className="mono muted" style={{ fontSize: 11 }}>{t}</span>
              <span style={{ flex: 1 }}>{name}</span>
              {k === "ok" ? <IconCheck w={12} style={{ color: "var(--ok)" }} /> : <IconAlert w={12} style={{ color: "var(--warn)" }} />}
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

function Field2({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

window.ScreenAutomations = ScreenAutomations;
