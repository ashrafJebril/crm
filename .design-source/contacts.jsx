// src/screens/contacts.jsx — Contacts CRM with kanban pipeline option

function ScreenContacts({ t }) {
  const isAr = t.lang === "ar";
  const tx = (en, ar) => isAr ? ar : en;
  const [view, setView] = useState("table"); // table | pipeline
  const [selected, setSelected] = useState(new Set());

  return (
    <div style={{ overflowY: "auto", flex: 1 }}>
      <PageHeader
        title={tx("Contacts","جهات الاتصال")}
        subtitle={tx("12,408 contacts · 2,184 leads · 9,612 customers","١٢٬٤٠٨ جهة · ٢٬١٨٤ محتمل · ٩٬٦١٢ عميل")}
        actions={
          <>
            <div style={{ display: "flex", border: "1px solid var(--line)", borderRadius: 8, padding: 2 }}>
              <button onClick={() => setView("table")}
                      className={`btn ghost sm ${view==="table" ? "" : ""}`}
                      style={{ background: view === "table" ? "var(--bg-2)" : "transparent" }}>
                {tx("Table","جدول")}
              </button>
              <button onClick={() => setView("pipeline")}
                      style={{ background: view === "pipeline" ? "var(--bg-2)" : "transparent",
                              border: 0, padding: "0 10px", height: 26, borderRadius: 6, color: "inherit", fontSize: 12, cursor: "pointer" }}>
                {tx("Pipeline","المسار")}
              </button>
            </div>
            <button className="btn"><IconBook w={13} />{tx("Import","استيراد")}</button>
            <button className="btn primary"><IconPlus w={13} />{tx("New contact","جهة جديدة")}</button>
          </>
        }
      />

      <div style={{ padding: "0 24px 24px", display: "grid", gap: 14 }}>
        {/* segment chips + search */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {[
            { l: tx("All","الكل"), c: 12408, on: true },
            { l: "VIP", c: 184 },
            { l: tx("Hot leads","عملاء محتملون ساخنون"), c: 96 },
            { l: tx("Repeat","متكرر"), c: 1240 },
            { l: tx("Trial","تجربة"), c: 412 },
            { l: tx("Cold","بارد"), c: 2104 },
          ].map(s => (
            <span key={s.l} style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "5px 11px", borderRadius: 999, fontSize: 12,
              border: `1px solid ${s.on ? "var(--accent-ring)" : "var(--line-soft)"}`,
              background: s.on ? "var(--accent-soft)" : "transparent",
              color: s.on ? "var(--accent)" : "var(--ink-1)", cursor: "pointer"
            }}>
              {s.l}<span className="mono muted" style={{ fontSize: 10, color: s.on ? "var(--accent)" : "var(--ink-3)" }}>{s.c.toLocaleString()}</span>
            </span>
          ))}
          <span style={{ flex: 1 }} />
          <button className="btn ghost sm"><IconFilter w={12} />{tx("Filters","فلاتر")}</button>
          <input className="inp" placeholder={tx("Search contacts…","ابحث…")} style={{ width: 220 }} />
        </div>

        {view === "table" ? <ContactsTable tx={tx} selected={selected} setSelected={setSelected} /> : <Pipeline tx={tx} />}
      </div>
    </div>
  );
}

function ContactsTable({ tx, selected, setSelected }) {
  const toggle = (id) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };
  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      {selected.size > 0 && (
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--line-soft)",
                     background: "var(--accent-soft)", display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 13, color: "var(--accent)", fontWeight: 500 }}>{selected.size} {tx("selected","محدد")}</span>
          <span style={{ flex: 1 }} />
          <button className="btn sm"><IconTag w={12} />{tx("Tag","وسم")}</button>
          <button className="btn sm"><IconCampaign w={12} />{tx("Add to campaign","حملة")}</button>
          <button className="btn sm"><IconArchive w={12} />{tx("Archive","أرشفة")}</button>
        </div>
      )}
      <table className="tbl">
        <thead><tr>
          <th style={{ width: 30 }}><input type="checkbox" /></th>
          <th>{tx("Name","الاسم")}</th>
          <th>{tx("Phone","الهاتف")}</th>
          <th>{tx("Tags","الوسوم")}</th>
          <th>{tx("Lifecycle","المرحلة")}</th>
          <th>{tx("Source","المصدر")}</th>
          <th>{tx("Convs","محادثات")}</th>
          <th>{tx("Value","القيمة")}</th>
          <th>{tx("Last seen","آخر ظهور")}</th>
          <th></th>
        </tr></thead>
        <tbody>
          {CONTACTS.map(c => (
            <tr key={c.id} className={selected.has(c.id) ? "selected" : ""}>
              <td><input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} /></td>
              <td>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Avatar name={c.name} color={String(150 + c.id.charCodeAt(1) * 6)} />
                  <div>
                    <div style={{ fontWeight: 500 }}>{c.name}</div>
                    <div className="muted" style={{ fontSize: 11 }}>{c.industry}</div>
                  </div>
                </div>
              </td>
              <td className="mono muted" style={{ fontSize: 12 }}>{c.phone}</td>
              <td>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {c.tags.map(tg => <Badge key={tg} kind={tg === "VIP" ? "warn" : tg === "Hot" ? "bad" : ""}>{tg}</Badge>)}
                </div>
              </td>
              <td><span className="mono" style={{ fontSize: 12 }}>{c.lifecycle}</span></td>
              <td className="muted">{c.source}</td>
              <td className="mono">{c.convs}</td>
              <td className="mono">{c.value}</td>
              <td className="mono muted">{c.lastSeen}</td>
              <td><button className="btn ghost icon sm"><IconMore w={14} /></button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Pipeline({ tx }) {
  const stages = [
    { id: "new",       label: tx("New","جديد"),         color: "var(--ink-3)",   count: 184 },
    { id: "qualified", label: tx("Qualified","مؤهل"),   color: "var(--info)",    count: 92 },
    { id: "proposal",  label: tx("Proposal","عرض"),     color: "var(--accent)",  count: 41 },
    { id: "won",       label: tx("Won","فاز"),          color: "var(--ok)",      count: 28 },
    { id: "lost",      label: tx("Lost","خسر"),         color: "var(--bad)",     count: 17 },
  ];
  const samples = {
    new: [
      { name: "James Whitman", desc: tx("SaaS · trial signup","SaaS · تسجيل تجريبي"), value: "$0", days: "1h" },
      { name: "Marco Bellini", desc: tx("Gym · walk-in","نادي · دخول"), value: "—", days: "3h" },
      { name: "Tariq Ben Salah", desc: tx("SaaS · ad click","SaaS · إعلان"), value: "—", days: "8h" },
    ],
    qualified: [
      { name: "Sven Lindgren", desc: tx("Ecommerce · 6 convos","تجارة إلكترونية"), value: "—", days: "2d" },
      { name: "Priya Venkatesan", desc: tx("Ecommerce · cart","تجارة إلكترونية"), value: "—", days: "1d" },
    ],
    proposal: [
      { name: "Reem Al-Qahtani", desc: tx("Real estate · Olaya","عقارات · العليا"), value: "SAR 142,000", days: "today" },
      { name: "Hugo Martín", desc: tx("Real estate · Marbella","عقارات · ماربيلا"), value: "EUR 24,000", days: "2d" },
    ],
    won: [
      { name: "Aisha Rahman", desc: tx("Clinic · package","عيادة · باقة"), value: "AED 6,400", days: "5d" },
      { name: "Fatima Boutros", desc: tx("Restaurant · catering","مطعم · حفل"), value: "USD 1,840", days: "1w" },
    ],
    lost: [
      { name: "Nadia Ezz", desc: tx("Restaurant · price","مطعم · سعر"), value: "EGP 3,200", days: "3d" },
    ],
  };

  return (
    <div style={{ overflowX: "auto", paddingBottom: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${stages.length}, 280px)`, gap: 12 }}>
        {stages.map(s => (
          <div key={s.id} style={{ background: "var(--bg-1)", border: "1px solid var(--line-soft)", borderRadius: 12, display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line-soft)", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color }} />
              <span style={{ fontWeight: 500, fontSize: 13 }}>{s.label}</span>
              <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)", marginInlineStart: "auto" }}>{s.count}</span>
              <button className="btn ghost icon sm"><IconPlus w={12} /></button>
            </div>
            <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 8, minHeight: 200 }}>
              {(samples[s.id] || []).map((card, i) => (
                <div key={i} style={{ background: "var(--bg-elev)", border: "1px solid var(--line-soft)",
                                     borderRadius: 8, padding: 10, cursor: "grab", boxShadow: "var(--shadow-sm)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Avatar name={card.name} color={String(120 + i * 30)} size="sm" />
                    <span style={{ fontWeight: 500, fontSize: 13, flex: 1 }}>{card.name}</span>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>{card.desc}</div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontFamily: "var(--font-mono)", fontSize: 11 }}>
                    <span style={{ color: "var(--accent)", fontWeight: 500 }}>{card.value}</span>
                    <span style={{ color: "var(--ink-3)" }}>{card.days}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

window.ScreenContacts = ScreenContacts;
