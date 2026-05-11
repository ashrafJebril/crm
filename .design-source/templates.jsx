// src/screens/templates.jsx — WhatsApp templates + quick replies

const { useState: useStateTpl } = React;

const TPL_LIBRARY = [
  { id: "t1", name: "order_confirmed_v2",   lang: "en", category: "TRANSACTIONAL", status: "approved", uses: 4812, updated: "Apr 22", body: "Hi {{1}} 👋 — your order #{{2}} for {{3}} is confirmed. ETA {{4}}. Track here: {{5}}", buttons: ["Track order", "Contact support"] },
  { id: "t2", name: "appointment_24h",      lang: "en", category: "UTILITY",       status: "approved", uses: 1304, updated: "Apr 18", body: "Reminder: your appointment with {{1}} is tomorrow at {{2}}. Reply 1 to confirm, 2 to reschedule.", buttons: ["Confirm", "Reschedule"] },
  { id: "t3", name: "abandoned_cart_24h",   lang: "en", category: "MARKETING",     status: "approved", uses: 412,  updated: "Apr 11", body: "Still thinking it over, {{1}}? Your cart with {{2}} items is waiting. 10% off if you check out today: {{3}}", buttons: ["Continue checkout"] },
  { id: "t4", name: "tahdid_eid_promo",     lang: "ar", category: "MARKETING",     status: "pending",  uses: 0,    updated: "Apr 30", body: "كل عام وأنتم بخير 🌙 — احتفل بعيد الفطر مع خصم {{1}}٪ على جميع المنتجات. صالح حتى {{2}}.", buttons: ["تسوق الآن"] },
  { id: "t5", name: "delivery_otp",         lang: "en", category: "AUTHENTICATION",status: "approved", uses: 9281, updated: "Mar 30", body: "Your verification code is {{1}}. Do not share. Expires in 5 minutes.", buttons: [] },
  { id: "t6", name: "feedback_request_v3",  lang: "en", category: "UTILITY",       status: "approved", uses: 1842, updated: "Apr 02", body: "Thanks for visiting {{1}}! How was your experience? Tap a number — 1 (poor) to 5 (excellent).", buttons: ["1","2","3","4","5"] },
  { id: "t7", name: "winback_60d",          lang: "en", category: "MARKETING",     status: "rejected", uses: 0,    updated: "Apr 14", body: "Miss you, {{1}}. Here's 20% off — come back: {{2}}", buttons: ["Shop now"] },
  { id: "t8", name: "clinic_followup_ar",   lang: "ar", category: "UTILITY",       status: "approved", uses: 312,  updated: "Apr 08", body: "مرحباً {{1}}، نأمل أن تكون بصحة جيدة بعد زيارتك. هل تحتاج إلى موعد متابعة؟", buttons: ["نعم", "ليس الآن"] },
];

const QUICK_REPLIES = [
  { id: "q1", short: "/hours",      body: "We're open Sat–Thu, 9am–11pm; closed Fridays." },
  { id: "q2", short: "/parking",    body: "Yes — complimentary valet at the main entrance." },
  { id: "q3", short: "/refund",     body: "Refunds are processed within 3–5 business days to your original payment method." },
  { id: "q4", short: "/menu_ar",    body: "تفضل قائمة الطعام: {{link}}" },
  { id: "q5", short: "/eid_promo",  body: "🌙 Eid promo: 15% off all orders > SAR 250 with code EID26." },
];

const categoryColors = {
  TRANSACTIONAL: "info",
  UTILITY: "",
  MARKETING: "ai",
  AUTHENTICATION: "warn",
};

function ScreenTemplates({ t, setTweak }) {
  const isAr = t.lang === "ar";
  const [tab, setTab] = useStateTpl("library");
  const [filter, setFilter] = useStateTpl("ALL");
  const [selectedId, setSelectedId] = useStateTpl("t1");
  const [search, setSearch] = useStateTpl("");

  const list = TPL_LIBRARY.filter(x => filter === "ALL" || x.category === filter)
    .filter(x => !search || x.name.includes(search.toLowerCase()));
  const selected = TPL_LIBRARY.find(x => x.id === selectedId) || TPL_LIBRARY[0];

  return (
    <div data-screen-label="Templates" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <PageHeader
        title={isAr ? "القوالب" : "Templates"}
        subtitle={isAr ? "قوالب رسائل واتساب المعتمدة وردود سريعة" : "Pre-approved WhatsApp templates and quick replies for your team"}
        actions={
          <>
            <button className="btn ghost"><IconFilter w={14} />{isAr ? "تصفية" : "Filter"}</button>
            <button className="btn"><IconSparkles w={14} />{isAr ? "اقترح بالذكاء" : "Draft with AI"}</button>
            <button className="btn primary"><IconPlus w={14} />{isAr ? "قالب جديد" : "New template"}</button>
          </>
        }
      />

      <div className="tabs">
        <div className={`tab ${tab === "library" ? "active" : ""}`} onClick={() => setTab("library")}>
          {isAr ? "المكتبة" : "Library"} <span className="count">{TPL_LIBRARY.length}</span>
        </div>
        <div className={`tab ${tab === "quick" ? "active" : ""}`} onClick={() => setTab("quick")}>
          {isAr ? "ردود سريعة" : "Quick replies"} <span className="count">{QUICK_REPLIES.length}</span>
        </div>
        <div className={`tab ${tab === "media" ? "active" : ""}`} onClick={() => setTab("media")}>
          {isAr ? "الوسائط" : "Media"} <span className="count">12</span>
        </div>
      </div>

      {tab === "library" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 380px", gap: 16, padding: 20, flex: 1, minHeight: 0, overflow: "hidden" }}>
          <div className="card" style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {/* filter chips */}
            <div style={{ display: "flex", gap: 8, padding: 14, borderBottom: "1px solid var(--line-soft)", alignItems: "center", flexWrap: "wrap" }}>
              {["ALL","TRANSACTIONAL","UTILITY","MARKETING","AUTHENTICATION"].map(c => (
                <button key={c}
                        onClick={() => setFilter(c)}
                        className="chip"
                        style={{
                          background: filter === c ? "var(--accent-soft)" : "var(--bg-2)",
                          color: filter === c ? "var(--accent)" : "var(--ink-1)",
                          border: `1px solid ${filter === c ? "var(--accent-ring)" : "var(--line-soft)"}`,
                          fontFamily: "var(--font-mono)",
                          fontSize: 11,
                          padding: "4px 10px",
                          borderRadius: 999,
                          cursor: "pointer",
                          letterSpacing: 0.04,
                        }}>{c}</button>
              ))}
              <div style={{ flex: 1 }} />
              <div className="search" style={{ width: 220, padding: "4px 10px" }}>
                <IconSearch w={12} />
                <input placeholder={isAr ? "ابحث…" : "Search by name…"} value={search} onChange={e => setSearch(e.target.value)} />
              </div>
            </div>

            <div style={{ overflow: "auto", flex: 1 }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{isAr ? "الاسم" : "Name"}</th>
                    <th>{isAr ? "الفئة" : "Category"}</th>
                    <th>{isAr ? "اللغة" : "Lang"}</th>
                    <th>{isAr ? "الحالة" : "Status"}</th>
                    <th style={{ textAlign: "end" }}>{isAr ? "الاستخدام" : "Uses"}</th>
                    <th>{isAr ? "آخر تحديث" : "Updated"}</th>
                    <th style={{ width: 30 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {list.map(tpl => (
                    <tr key={tpl.id}
                        className={selectedId === tpl.id ? "selected" : ""}
                        onClick={() => setSelectedId(tpl.id)}
                        style={{ cursor: "pointer" }}>
                      <td className="mono" style={{ fontWeight: 500, fontSize: 12 }}>{tpl.name}</td>
                      <td><Badge kind={categoryColors[tpl.category]}>{tpl.category}</Badge></td>
                      <td className="mono" style={{ fontSize: 11, color: "var(--ink-2)" }}>{tpl.lang}</td>
                      <td>
                        <Badge kind={tpl.status === "approved" ? "ok" : tpl.status === "pending" ? "warn" : tpl.status === "rejected" ? "bad" : ""} dot>
                          {tpl.status}
                        </Badge>
                      </td>
                      <td className="mono" style={{ textAlign: "end", fontSize: 12 }}>{tpl.uses.toLocaleString()}</td>
                      <td className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>{tpl.updated}</td>
                      <td><IconMore w={14} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ padding: "10px 14px", borderTop: "1px solid var(--line-soft)", color: "var(--ink-3)", fontSize: 11, fontFamily: "var(--font-mono)", display: "flex", alignItems: "center", gap: 12 }}>
              <span>{list.length} of {TPL_LIBRARY.length}</span>
              <span>·</span>
              <span style={{ color: "var(--ok)" }}>● 6 approved</span>
              <span style={{ color: "var(--warn)" }}>● 1 pending</span>
              <span style={{ color: "var(--bad)" }}>● 1 rejected</span>
            </div>
          </div>

          {/* preview pane */}
          <div className="card" style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div className="card-h">
              <div>
                <h3 className="mono" style={{ fontSize: 13 }}>{selected.name}</h3>
                <div className="sub">{selected.category} · {selected.lang.toUpperCase()}</div>
              </div>
              <Badge kind={selected.status === "approved" ? "ok" : selected.status === "pending" ? "warn" : "bad"} dot>{selected.status}</Badge>
            </div>

            {/* phone preview */}
            <div style={{ padding: 18, background: "var(--bg-2)", flex: 1, overflowY: "auto" }}>
              <div style={{
                background: "linear-gradient(180deg, oklch(0.36 0.04 152) 0%, oklch(0.18 0.02 152) 100%)",
                borderRadius: 18,
                padding: 14,
                position: "relative",
                minHeight: 320,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, paddingBottom: 10, borderBottom: "1px solid oklch(1 0 0 / 0.12)" }}>
                  <Avatar name="Cedar" size="sm" />
                  <div style={{ flex: 1 }}>
                    <div style={{ color: "white", fontSize: 12, fontWeight: 500 }}>Cedar Group</div>
                    <div style={{ color: "oklch(1 0 0 / 0.6)", fontSize: 10, fontFamily: "var(--font-mono)" }}>Business · verified</div>
                  </div>
                  <span style={{ color: "var(--accent)", fontSize: 10 }}>●</span>
                </div>
                <div style={{ marginTop: 14 }} dir={selected.lang === "ar" ? "rtl" : "ltr"}>
                  <div style={{
                    background: "white",
                    color: "#1a1a1a",
                    padding: "10px 12px",
                    borderRadius: "12px 12px 12px 4px",
                    fontSize: 13,
                    lineHeight: 1.5,
                    maxWidth: 280,
                    boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                  }}>
                    {selected.body.split(/(\{\{\d+\}\})/g).map((part, i) =>
                      /\{\{\d+\}\}/.test(part)
                        ? <span key={i} style={{ background: "oklch(0.92 0.08 150)", padding: "0 4px", borderRadius: 3, fontFamily: "var(--font-mono)", fontSize: 11 }}>{part}</span>
                        : <span key={i}>{part}</span>
                    )}
                  </div>
                  {selected.buttons.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6, maxWidth: 280 }}>
                      {selected.buttons.map((b, i) => (
                        <div key={i} style={{
                          background: "oklch(0.32 0.03 152)",
                          color: "oklch(0.9 0.06 152)",
                          padding: "8px 12px",
                          borderRadius: 8,
                          textAlign: "center",
                          fontSize: 12,
                          fontWeight: 500,
                          border: "1px solid oklch(1 0 0 / 0.08)",
                        }}>{b}</div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div style={{ padding: 14, borderTop: "1px solid var(--line-soft)", display: "flex", gap: 6 }}>
              <button className="btn sm" style={{ flex: 1 }}><IconBolt w={12} />{isAr ? "اختبار" : "Test send"}</button>
              <button className="btn sm" style={{ flex: 1 }}>{isAr ? "نسخ" : "Duplicate"}</button>
              <button className="btn sm primary" style={{ flex: 1 }}>{isAr ? "تعديل" : "Edit"}</button>
            </div>
          </div>
        </div>
      )}

      {tab === "quick" && (
        <div style={{ padding: 20 }}>
          <div className="card">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{isAr ? "الاختصار" : "Shortcut"}</th>
                  <th>{isAr ? "الرسالة" : "Message"}</th>
                  <th style={{ textAlign: "end" }}>{isAr ? "الاستخدام" : "Used"}</th>
                  <th style={{ width: 60 }}></th>
                </tr>
              </thead>
              <tbody>
                {QUICK_REPLIES.map(q => (
                  <tr key={q.id}>
                    <td className="mono" style={{ fontWeight: 500, color: "var(--accent)" }}>{q.short}</td>
                    <td style={{ color: "var(--ink-1)" }}>{q.body}</td>
                    <td className="mono" style={{ textAlign: "end", color: "var(--ink-3)", fontSize: 12 }}>{Math.floor(Math.random()*200)+20}</td>
                    <td><IconMore w={14} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "media" && (
        <div style={{ padding: 20, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          {["product-shot-eid", "menu-cover-ar", "clinic-room-1", "gym-trainer-portrait", "tower-floorplan", "trial-coupon", "shipping-label", "thank-you-card"].map((label, i) => (
            <div key={i} className="card" style={{ padding: 12 }}>
              <PhotoSlot label={label} h={120} />
              <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div className="mono" style={{ fontSize: 11 }}>{label}.jpg</div>
                <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>{Math.floor(Math.random()*900)+100}KB</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

window.ScreenTemplates = ScreenTemplates;
