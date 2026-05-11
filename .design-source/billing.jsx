// src/screens/billing.jsx — Billing dashboard, plans, usage, invoices

const { useState: useStateBill } = React;

const PLANS = [
  { id: "starter",  name: "Starter",   price: 29,  unit: "/mo", convs: "1,000",  agents: 1,  seats: 3,  features: ["1 WhatsApp number","Basic AI agent","CSV import","Email support"] },
  { id: "pro",      name: "Pro",       price: 149, unit: "/mo", convs: "10,000", agents: 4,  seats: 10, features: ["3 WhatsApp numbers","Custom AI personalities","Drip campaigns","Automation builder","Priority support"], current: true },
  { id: "scale",    name: "Scale",     price: 499, unit: "/mo", convs: "50,000", agents: 20, seats: 30, features: ["Unlimited numbers","Multi-tenant routing","SLA 99.95%","SSO + SCIM","Dedicated CSM"] },
  { id: "ent",      name: "Enterprise",price: null,unit: "Custom", convs: "Unlimited", agents: "—", seats: "—", features: ["Custom volume","On-premise option","Custom AI tuning","24/7 phone support","Audit logs"] },
];

const INVOICES = [
  { id: "INV-2026-04", date: "May 01, 2026", amount: 149.00, status: "paid",     period: "April 2026" },
  { id: "INV-2026-03", date: "Apr 01, 2026", amount: 149.00, status: "paid",     period: "March 2026" },
  { id: "INV-2026-02", date: "Mar 01, 2026", amount: 149.00, status: "paid",     period: "February 2026" },
  { id: "INV-2026-01", date: "Feb 01, 2026", amount: 149.00, status: "paid",     period: "January 2026" },
  { id: "INV-2025-12", date: "Jan 01, 2026", amount: 149.00, status: "paid",     period: "December 2025" },
  { id: "INV-2025-11", date: "Dec 01, 2025", amount: 119.00, status: "paid",     period: "November 2025" },
];

const USAGE = [
  { label: "Conversations",     used: 6240,   limit: 10000, unit: "" },
  { label: "AI tokens",         used: 1842000,limit: 5000000, unit: "" },
  { label: "WhatsApp messages", used: 38120,  limit: 100000, unit: "" },
  { label: "Team seats",        used: 7,      limit: 10, unit: "" },
  { label: "Storage",           used: 4.2,    limit: 25, unit: " GB" },
];

const ADDONS = [
  { name: "Extra WhatsApp number",  price: 25, unit: "/mo", on: false },
  { name: "Voice agent (beta)",     price: 79, unit: "/mo", on: true  },
  { name: "Premium support · 4h SLA",price: 199,unit: "/mo", on: true  },
  { name: "Custom domain branding", price: 19, unit: "/mo", on: false },
];

function ScreenBilling({ t }) {
  const isAr = t.lang === "ar";
  const [tab, setTab] = useStateBill("overview");

  const usagePct = (used, limit) => Math.min(100, (used / limit) * 100);

  return (
    <div data-screen-label="Billing" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <PageHeader
        title={isAr ? "الفواتير والاشتراك" : "Billing & Subscription"}
        subtitle={isAr ? "خطتك، استخدامك، فواتيرك" : "Your plan, usage, and invoices"}
        actions={
          <>
            <button className="btn ghost"><IconBook w={14} />{isAr ? "إيصالات ضريبية" : "Tax docs"}</button>
            <button className="btn primary"><IconBolt w={14} />{isAr ? "ترقية" : "Upgrade"}</button>
          </>
        }
      />

      <div className="tabs">
        <div className={`tab ${tab === "overview" ? "active" : ""}`} onClick={() => setTab("overview")}>{isAr ? "نظرة عامة" : "Overview"}</div>
        <div className={`tab ${tab === "plans" ? "active" : ""}`} onClick={() => setTab("plans")}>{isAr ? "الخطط" : "Plans"}</div>
        <div className={`tab ${tab === "usage" ? "active" : ""}`} onClick={() => setTab("usage")}>{isAr ? "الاستخدام" : "Usage"}</div>
        <div className={`tab ${tab === "invoices" ? "active" : ""}`} onClick={() => setTab("invoices")}>{isAr ? "الفواتير" : "Invoices"} <span className="count">{INVOICES.length}</span></div>
        <div className={`tab ${tab === "payment" ? "active" : ""}`} onClick={() => setTab("payment")}>{isAr ? "طرق الدفع" : "Payment"}</div>
      </div>

      {tab === "overview" && (
        <div style={{ padding: 20, display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16 }}>
          {/* Current plan card */}
          <div className="card" style={{ padding: 20, position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", inset: 0, background: "radial-gradient(circle at 100% 0%, var(--accent-soft), transparent 50%)", pointerEvents: "none" }} />
            <div style={{ position: "relative" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <Badge kind="ai" dot>Current plan</Badge>
                <Badge kind="ok">Auto-renew</Badge>
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginTop: 12 }}>
                <h2 style={{ margin: 0, fontSize: 32, fontWeight: 600, letterSpacing: "-0.02em" }}>Pro</h2>
                <div className="mono" style={{ fontSize: 18, color: "var(--ink-2)" }}>$149<span style={{ fontSize: 13, color: "var(--ink-3)" }}>/mo</span></div>
              </div>
              <p style={{ color: "var(--ink-2)", fontSize: 13, marginTop: 4 }}>{isAr ? "يتجدد في 1 يونيو 2026" : "Next renewal · June 1, 2026"}</p>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginTop: 20 }}>
                <div>
                  <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.06 }}>Conversations</div>
                  <div style={{ fontSize: 18, fontWeight: 600, marginTop: 2 }}>6,240<span style={{ color: "var(--ink-3)", fontSize: 13, fontWeight: 400 }}> / 10,000</span></div>
                </div>
                <div>
                  <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.06 }}>AI agents</div>
                  <div style={{ fontSize: 18, fontWeight: 600, marginTop: 2 }}>4<span style={{ color: "var(--ink-3)", fontSize: 13, fontWeight: 400 }}> / 4</span></div>
                </div>
                <div>
                  <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.06 }}>Seats</div>
                  <div style={{ fontSize: 18, fontWeight: 600, marginTop: 2 }}>7<span style={{ color: "var(--ink-3)", fontSize: 13, fontWeight: 400 }}> / 10</span></div>
                </div>
              </div>

              <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
                <button className="btn primary"><IconArrowUp w={13} />{isAr ? "ترقية إلى Scale" : "Upgrade to Scale"}</button>
                <button className="btn ghost">{isAr ? "إيقاف التجديد" : "Cancel renewal"}</button>
              </div>
            </div>
          </div>

          {/* This month spend */}
          <div className="card" style={{ padding: 20 }}>
            <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.06 }}>This month</div>
            <div style={{ fontSize: 32, fontWeight: 600, letterSpacing: "-0.02em", marginTop: 4 }}>$248.00</div>
            <div style={{ fontSize: 12, color: "var(--ink-3)" }}>$149 base + $99 add-ons</div>
            <div style={{ marginTop: 16 }}>
              <Bars values={[149,149,149,119,149,149,149,149,149,149,149,248]} w={300} h={64}
                    labels={["J","F","M","A","M","J","J","A","S","O","N","D"]} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16, fontSize: 12, color: "var(--ink-2)" }}>
              <span>YTD: $1,856</span>
              <span style={{ color: "var(--ok)" }}>↑ 14% vs prev. year</span>
            </div>
          </div>

          {/* Add-ons */}
          <div className="card" style={{ gridColumn: "1 / -1" }}>
            <div className="card-h"><h3>{isAr ? "الإضافات" : "Add-ons"}</h3><div className="sub">extra capabilities for your workspace</div></div>
            <div style={{ padding: 6 }}>
              {ADDONS.map((a, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: i < ADDONS.length - 1 ? "1px solid var(--line-soft)" : "0" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 500 }}>{a.name}</div>
                    <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>${a.price}{a.unit}</div>
                  </div>
                  {a.on && <Badge kind="ok" dot>active</Badge>}
                  <Toggle on={a.on} />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === "plans" && (
        <div style={{ padding: 20, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          {PLANS.map(p => (
            <div key={p.id} className="card" style={{
              padding: 20,
              position: "relative",
              border: p.current ? "1px solid var(--accent-ring)" : undefined,
              boxShadow: p.current ? "0 0 0 4px var(--accent-soft)" : undefined,
            }}>
              {p.current && <Badge kind="ai" dot>current</Badge>}
              <h3 style={{ marginTop: p.current ? 8 : 0, marginBottom: 4, fontSize: 18, fontWeight: 600 }}>{p.name}</h3>
              <div style={{ display: "flex", alignItems: "baseline", gap: 4, margin: "4px 0 16px" }}>
                {p.price !== null
                  ? (<><span style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.02em" }}>${p.price}</span><span className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>{p.unit}</span></>)
                  : <span className="display" style={{ fontSize: 26 }}>let's talk</span>}
              </div>
              <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 12, padding: "8px 0", borderTop: "1px solid var(--line-soft)", borderBottom: "1px solid var(--line-soft)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}><span>Conversations</span><span style={{ color: "var(--ink-1)" }}>{p.convs}</span></div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}><span>AI agents</span><span style={{ color: "var(--ink-1)" }}>{p.agents}</span></div>
                <div style={{ display: "flex", justifyContent: "space-between" }}><span>Seats</span><span style={{ color: "var(--ink-1)" }}>{p.seats}</span></div>
              </div>
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {p.features.map((f, i) => (
                  <li key={i} style={{ display: "flex", gap: 8, padding: "4px 0", fontSize: 13 }}>
                    <span style={{ color: "var(--accent)" }}><IconCheck w={14} /></span>
                    <span style={{ color: "var(--ink-1)" }}>{f}</span>
                  </li>
                ))}
              </ul>
              <button className="btn" style={{ width: "100%", marginTop: 16, justifyContent: "center" }}
                      disabled={p.current}>
                {p.current ? (isAr ? "خطتك الحالية" : "Current plan") : (p.price ? (isAr ? "اختر" : "Choose plan") : (isAr ? "تواصل" : "Contact sales"))}
              </button>
            </div>
          ))}
        </div>
      )}

      {tab === "usage" && (
        <div style={{ padding: 20, display: "grid", gap: 16, maxWidth: 900 }}>
          <div className="card">
            <div className="card-h">
              <h3>{isAr ? "الاستخدام لهذه الدورة" : "Current cycle usage"}</h3>
              <div className="sub">May 1 – May 31, 2026</div>
            </div>
            <div style={{ padding: 20 }}>
              {USAGE.map((u, i) => {
                const pct = usagePct(u.used, u.limit);
                const color = pct > 90 ? "var(--bad)" : pct > 75 ? "var(--warn)" : "var(--accent)";
                return (
                  <div key={u.label} style={{ marginBottom: i < USAGE.length - 1 ? 18 : 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                      <span style={{ fontWeight: 500 }}>{u.label}</span>
                      <span className="mono" style={{ fontSize: 12, color: "var(--ink-2)" }}>
                        <span style={{ color: "var(--ink)" }}>{u.used.toLocaleString()}{u.unit}</span>
                        <span style={{ color: "var(--ink-3)" }}> / {u.limit.toLocaleString()}{u.unit}</span>
                      </span>
                    </div>
                    <div style={{ height: 6, borderRadius: 3, background: "var(--bg-3)", overflow: "hidden" }}>
                      <div style={{ width: `${pct}%`, height: "100%", background: color, transition: "width 0.3s" }} />
                    </div>
                    <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)", marginTop: 4 }}>
                      {pct.toFixed(1)}% used · resets Jun 1
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="card" style={{ padding: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ width: 36, height: 36, borderRadius: 8, background: "var(--accent-soft)", color: "var(--accent)", display: "grid", placeItems: "center" }}>
                <IconBolt w={18} />
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 500 }}>{isAr ? "حد الاستخدام التلقائي" : "Auto top-up"}</div>
                <div style={{ fontSize: 12, color: "var(--ink-2)" }}>{isAr ? "إضافة 1,000 محادثة تلقائيًا عند تجاوز 90% من الحد" : "Automatically add 1,000 conversations when usage hits 90%"}</div>
              </div>
              <Toggle on={true} />
            </div>
          </div>
        </div>
      )}

      {tab === "invoices" && (
        <div style={{ padding: 20 }}>
          <div className="card">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{isAr ? "الفاتورة" : "Invoice"}</th>
                  <th>{isAr ? "الفترة" : "Period"}</th>
                  <th>{isAr ? "التاريخ" : "Date"}</th>
                  <th style={{ textAlign: "end" }}>{isAr ? "المبلغ" : "Amount"}</th>
                  <th>{isAr ? "الحالة" : "Status"}</th>
                  <th style={{ width: 120, textAlign: "end" }}></th>
                </tr>
              </thead>
              <tbody>
                {INVOICES.map(inv => (
                  <tr key={inv.id}>
                    <td className="mono" style={{ fontWeight: 500, fontSize: 12 }}>{inv.id}</td>
                    <td style={{ color: "var(--ink-2)" }}>{inv.period}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{inv.date}</td>
                    <td className="mono" style={{ textAlign: "end", fontWeight: 500 }}>${inv.amount.toFixed(2)}</td>
                    <td><Badge kind="ok" dot>{inv.status}</Badge></td>
                    <td style={{ textAlign: "end" }}>
                      <button className="btn sm ghost">{isAr ? "عرض" : "View"}</button>
                      <button className="btn sm ghost" style={{ marginInlineStart: 4 }}>PDF</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "payment" && (
        <div style={{ padding: 20, display: "grid", gridTemplateColumns: "1fr 380px", gap: 16, maxWidth: 1100 }}>
          <div style={{ display: "grid", gap: 12 }}>
            {/* card */}
            <div className="card" style={{ padding: 24, background: "linear-gradient(135deg, oklch(0.18 0.02 250), oklch(0.14 0.02 230))", color: "white", overflow: "hidden", position: "relative" }}>
              <div style={{ position: "absolute", inset: 0, background: "radial-gradient(circle at 80% 100%, oklch(0.7 0.18 220 / 0.3), transparent 60%)" }} />
              <div style={{ position: "relative" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 32 }}>
                  <Badge kind="ok" dot>primary</Badge>
                  <span className="mono" style={{ fontSize: 11, opacity: 0.7 }}>VISA</span>
                </div>
                <div className="mono" style={{ fontSize: 18, letterSpacing: 4, marginBottom: 14 }}>•••• •••• •••• 4421</div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, fontFamily: "var(--font-mono)", opacity: 0.8 }}>
                  <div>
                    <div style={{ opacity: 0.6, fontSize: 9 }}>CARDHOLDER</div>
                    <div>YARA KHALED</div>
                  </div>
                  <div>
                    <div style={{ opacity: 0.6, fontSize: 9 }}>EXPIRES</div>
                    <div>09 / 28</div>
                  </div>
                </div>
              </div>
            </div>

            <div className="card" style={{ padding: 16, display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ width: 36, height: 36, borderRadius: 8, background: "var(--bg-2)", display: "grid", placeItems: "center", fontSize: 11, fontFamily: "var(--font-mono)", border: "1px solid var(--line-soft)" }}>MC</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 500 }}>Mastercard •••• 8821</div>
                <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>expires 03 / 27 · backup</div>
              </div>
              <button className="btn sm ghost"><IconMore w={14} /></button>
            </div>

            <button className="btn" style={{ alignSelf: "flex-start" }}><IconPlus w={14} />{isAr ? "إضافة طريقة دفع" : "Add payment method"}</button>
          </div>

          <div className="card" style={{ padding: 18 }}>
            <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>{isAr ? "تفاصيل الفوترة" : "Billing details"}</h3>
            <p style={{ margin: "0 0 14px", color: "var(--ink-3)", fontSize: 12 }}>{isAr ? "تظهر على الفواتير الضريبية" : "Appears on tax invoices"}</p>
            <div style={{ display: "grid", gap: 10, fontSize: 13 }}>
              <Row label="Company" value="Cedar Group LLC" />
              <Row label="Tax ID" value="3001-22-8841 (VAT)" />
              <Row label="Country" value="Saudi Arabia" />
              <Row label="Address" value="King Fahd Rd, Olaya, Riyadh 12211" />
              <Row label="Email" value="finance@cedar.sa" />
            </div>
            <button className="btn sm ghost" style={{ marginTop: 14 }}>{isAr ? "تعديل" : "Edit details"}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", paddingBottom: 6, borderBottom: "1px solid var(--line-soft)" }}>
      <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.05 }}>{label}</span>
      <span style={{ color: "var(--ink-1)" }}>{value}</span>
    </div>
  );
}

window.ScreenBilling = ScreenBilling;
