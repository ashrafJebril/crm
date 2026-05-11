// src/screens/settings.jsx — Workspace settings with sub-nav

const { useState: useStateSet } = React;

const SECTIONS = [
  { id: "general",     label: "General",     ar: "عام",        Icon: IconCog },
  { id: "workspace",   label: "Workspace",   ar: "مساحة العمل", Icon: IconLayers },
  { id: "whatsapp",    label: "WhatsApp",    ar: "واتساب",     Icon: IconPhone },
  { id: "api",         label: "API & Keys",  ar: "المفاتيح",   Icon: IconBolt },
  { id: "webhooks",    label: "Webhooks",    ar: "Webhooks",   Icon: IconRoute },
  { id: "notifications",label:"Notifications",ar: "الإشعارات", Icon: IconBell },
  { id: "branding",    label: "Branding",    ar: "العلامة",    Icon: IconStar },
  { id: "security",    label: "Security",    ar: "الأمان",     Icon: IconCheckCircle },
];

const API_KEYS = [
  { name: "Production",  key: "tk_live_82a4...c91d", created: "Jan 14, 2026", lastUsed: "2m ago",  perms: "Read+Write" },
  { name: "Staging",     key: "tk_test_4f12...a7e8", created: "Mar 03, 2026", lastUsed: "4h ago",  perms: "Read+Write" },
  { name: "BI ingest",   key: "tk_live_91bd...0f44", created: "Apr 21, 2026", lastUsed: "yesterday", perms: "Read only" },
];

const WEBHOOKS = [
  { url: "https://api.cedar.sa/hooks/whatsapp",        events: 12, status: "active",   lastDelivery: "1m ago",   success: 99.8 },
  { url: "https://crm.partner.io/v2/tkana",            events: 7,  status: "active",   lastDelivery: "8m ago",   success: 99.2 },
  { url: "https://staging.cedar.sa/webhook-test",      events: 3,  status: "paused",   lastDelivery: "2d ago",   success: 87.5 },
  { url: "https://logs.cedar.sa/ingest/conversations", events: 5,  status: "failing",  lastDelivery: "12m ago",  success: 64.0 },
];

const NOTIF_PREFS = [
  { area: "New conversation",       email: false, sms: false, push: true,  inApp: true  },
  { area: "Escalated to human",     email: true,  sms: true,  push: true,  inApp: true  },
  { area: "AI confidence < 0.6",    email: false, sms: false, push: true,  inApp: true  },
  { area: "Campaign completed",     email: true,  sms: false, push: false, inApp: true  },
  { area: "Billing & usage alerts", email: true,  sms: false, push: false, inApp: true  },
  { area: "Weekly digest",          email: true,  sms: false, push: false, inApp: false },
];

function ScreenSettings({ t, setTweak }) {
  const isAr = t.lang === "ar";
  const [section, setSection] = useStateSet("general");
  const [revealKey, setRevealKey] = useStateSet(null);

  return (
    <div data-screen-label="Settings" style={{ display: "flex", flex: 1, minHeight: 0 }}>
      {/* sub nav */}
      <aside style={{ width: 220, borderInlineEnd: "1px solid var(--line-soft)", padding: 14, background: "var(--bg-1)", flexShrink: 0 }}>
        <div className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.08, color: "var(--ink-3)", padding: "6px 8px" }}>
          {isAr ? "الإعدادات" : "Settings"}
        </div>
        {SECTIONS.map(s => (
          <div key={s.id}
               onClick={() => setSection(s.id)}
               className="nav-item"
               style={{
                 background: section === s.id ? "var(--bg-2)" : "transparent",
                 color: section === s.id ? "var(--ink)" : "var(--ink-1)",
                 marginBottom: 2,
               }}>
            <span className="nav-icon" style={{ color: section === s.id ? "var(--accent)" : "var(--ink-2)" }}><s.Icon w={16} /></span>
            <span className="nav-label">{isAr ? s.ar : s.label}</span>
          </div>
        ))}
      </aside>

      <div style={{ flex: 1, overflow: "auto" }}>
        {section === "general" && <SettingsGeneral isAr={isAr} t={t} setTweak={setTweak} />}
        {section === "workspace" && <SettingsWorkspace isAr={isAr} />}
        {section === "whatsapp" && <SettingsWhatsApp isAr={isAr} />}
        {section === "api" && <SettingsAPI isAr={isAr} reveal={revealKey} setReveal={setRevealKey} />}
        {section === "webhooks" && <SettingsWebhooks isAr={isAr} />}
        {section === "notifications" && <SettingsNotifications isAr={isAr} />}
        {section === "branding" && <SettingsBranding isAr={isAr} />}
        {section === "security" && <SettingsSecurity isAr={isAr} />}
      </div>
    </div>
  );
}

function SectionHeader({ title, subtitle, actions }) {
  return (
    <div style={{ padding: "20px 24px 12px", borderBottom: "1px solid var(--line-soft)", display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: "-0.02em" }}>{title}</h2>
        {subtitle && <p style={{ margin: "4px 0 0", color: "var(--ink-2)", fontSize: 13 }}>{subtitle}</p>}
      </div>
      <div style={{ display: "flex", gap: 8 }}>{actions}</div>
    </div>
  );
}

function FieldRow({ label, hint, children }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 32, padding: "18px 24px", borderBottom: "1px solid var(--line-soft)" }}>
      <div>
        <div style={{ fontWeight: 500, fontSize: 13 }}>{label}</div>
        {hint && <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2, lineHeight: 1.4 }}>{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

const fieldStyle = {
  width: "100%", maxWidth: 420,
  background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: "var(--r)",
  padding: "8px 12px", color: "var(--ink)", fontSize: 13, outline: "none",
};

function SettingsGeneral({ isAr, t, setTweak }) {
  return (
    <div>
      <SectionHeader
        title={isAr ? "إعدادات عامة" : "General"}
        subtitle={isAr ? "اللغة، المنطقة الزمنية، التفضيلات" : "Language, timezone, and preferences"}
        actions={<button className="btn primary">{isAr ? "حفظ" : "Save changes"}</button>}
      />
      <FieldRow label={isAr ? "اسم مساحة العمل" : "Workspace name"} hint="Visible to your team and on customer-facing branding.">
        <input style={fieldStyle} defaultValue="Cedar Group" />
      </FieldRow>
      <FieldRow label={isAr ? "النطاق" : "Slug"} hint="Used in shareable links: tkana.app/yourSlug">
        <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
          <span className="mono" style={{ fontSize: 12, padding: "9px 12px", background: "var(--bg-2)", border: "1px solid var(--line)", borderInlineEnd: 0, borderTopLeftRadius: "var(--r)", borderBottomLeftRadius: "var(--r)", color: "var(--ink-3)" }}>tkana.app/</span>
          <input style={{ ...fieldStyle, borderTopLeftRadius: 0, borderBottomLeftRadius: 0, maxWidth: 280 }} defaultValue="cedar-group" />
        </div>
      </FieldRow>
      <FieldRow label={isAr ? "اللغة الافتراضية" : "Default language"} hint="The interface language for new users in your workspace.">
        <select style={{ ...fieldStyle, appearance: "none" }} value={t.lang} onChange={e => setTweak("lang", e.target.value)}>
          <option value="en">English</option>
          <option value="ar">العربية</option>
        </select>
      </FieldRow>
      <FieldRow label={isAr ? "المنطقة الزمنية" : "Timezone"}>
        <select style={{ ...fieldStyle, appearance: "none" }} defaultValue="Asia/Riyadh">
          <option>Asia/Riyadh (GMT+3)</option>
          <option>Africa/Cairo (GMT+2)</option>
          <option>Europe/London (GMT)</option>
          <option>America/New_York (GMT-5)</option>
        </select>
      </FieldRow>
      <FieldRow label={isAr ? "تنسيق التاريخ" : "Date format"}>
        <div style={{ display: "flex", gap: 6 }}>
          {["DD/MM/YYYY","MM/DD/YYYY","YYYY-MM-DD"].map((f, i) => (
            <button key={f} className={`btn sm ${i === 0 ? "primary" : ""}`}>{f}</button>
          ))}
        </div>
      </FieldRow>
      <FieldRow label={isAr ? "أسبوع العمل" : "Working week"} hint="Affects analytics calendar and 'business hours' rules.">
        <div style={{ display: "flex", gap: 4 }}>
          {["S","M","T","W","T","F","S"].map((d, i) => (
            <span key={i} style={{
              width: 32, height: 32, borderRadius: 6,
              display: "grid", placeItems: "center",
              fontSize: 12, fontFamily: "var(--font-mono)",
              background: ![5].includes(i) ? "var(--accent-soft)" : "var(--bg-2)",
              color: ![5].includes(i) ? "var(--accent)" : "var(--ink-3)",
              border: "1px solid var(--line-soft)", cursor: "pointer",
            }}>{d}</span>
          ))}
        </div>
      </FieldRow>
    </div>
  );
}

function SettingsWorkspace({ isAr }) {
  return (
    <div>
      <SectionHeader title={isAr ? "مساحة العمل" : "Workspace"} subtitle="Logo, contact info, danger zone" />
      <FieldRow label={isAr ? "شعار مساحة العمل" : "Workspace logo"} hint="Square PNG or SVG, at least 512×512">
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <PhotoSlot label="logo.svg" w={80} h={80} />
          <button className="btn">Upload new</button>
          <button className="btn ghost danger">Remove</button>
        </div>
      </FieldRow>
      <FieldRow label="Industry">
        <select style={{ ...fieldStyle, appearance: "none" }} defaultValue="real-estate">
          <option>Real estate</option><option>Restaurant</option><option>Ecommerce</option><option>Healthcare</option><option>SaaS</option>
        </select>
      </FieldRow>
      <FieldRow label="Company size">
        <div style={{ display: "flex", gap: 6 }}>
          {["1-10","11-50","51-200","201-1k","1k+"].map((s, i) => (
            <button key={s} className={`btn sm ${i === 1 ? "primary" : ""}`}>{s}</button>
          ))}
        </div>
      </FieldRow>
      <FieldRow label="Support email" hint="Auto-replies and notifications go from this address.">
        <input style={fieldStyle} defaultValue="hello@cedar.sa" />
      </FieldRow>
      <div style={{ padding: "30px 24px" }}>
        <div className="card" style={{ borderColor: "oklch(0.7 0.22 24 / 0.3)", padding: 18 }}>
          <h3 style={{ margin: 0, fontSize: 14, color: "var(--bad)" }}>Danger zone</h3>
          <p style={{ color: "var(--ink-2)", fontSize: 13, margin: "6px 0 14px" }}>These actions are permanent and cannot be undone.</p>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn danger">Transfer ownership</button>
            <button className="btn danger" style={{ background: "oklch(0.7 0.22 24 / 0.12)", borderColor: "oklch(0.7 0.22 24 / 0.3)" }}>Delete workspace</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingsWhatsApp({ isAr }) {
  return (
    <div>
      <SectionHeader
        title={isAr ? "تكامل واتساب" : "WhatsApp Integration"}
        subtitle="Numbers, business profile, opt-in"
        actions={<button className="btn primary"><IconPlus w={14} />{isAr ? "ربط رقم" : "Connect number"}</button>}
      />
      <div style={{ padding: 20 }}>
        {[
          { number: "+966 11 234 5678", label: "Cedar Riyadh", quality: "GREEN", verified: true,  msgsToday: 1842, agent: "Luna" },
          { number: "+961 1 887 990",   label: "Cedar Beirut", quality: "GREEN", verified: true,  msgsToday: 412,  agent: "Atlas" },
          { number: "+971 4 224 1100",  label: "Cedar Dubai",  quality: "YELLOW", verified: false, msgsToday: 124, agent: "Nova" },
        ].map((n, i) => (
          <div key={i} className="card" style={{ padding: 16, marginBottom: 10, display: "flex", alignItems: "center", gap: 16 }}>
            <span style={{ width: 44, height: 44, borderRadius: 10, background: "var(--accent-soft)", display: "grid", placeItems: "center", color: "var(--accent)" }}>
              <IconPhone w={20} />
            </span>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="mono" style={{ fontWeight: 500 }}>{n.number}</span>
                <Badge>{n.label}</Badge>
                {n.verified && <Badge kind="ok" dot>verified</Badge>}
              </div>
              <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 4 }} className="mono">
                Quality: <span style={{ color: n.quality === "GREEN" ? "var(--ok)" : "var(--warn)" }}>{n.quality}</span>
                {" · "}{n.msgsToday.toLocaleString()} msgs today · routed to {n.agent}
              </div>
            </div>
            <button className="btn sm ghost">Configure</button>
            <button className="btn sm ghost"><IconMore w={14} /></button>
          </div>
        ))}

        <div style={{ marginTop: 24 }}>
          <h3 style={{ margin: "0 0 12px", fontSize: 14 }}>{isAr ? "ملف الأعمال" : "Business profile"}</h3>
          <div className="card" style={{ padding: 18, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
            <div>
              <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase" }}>Display name</div>
              <div style={{ fontWeight: 500, marginTop: 2 }}>Cedar Group</div>
            </div>
            <div>
              <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase" }}>Category</div>
              <div style={{ fontWeight: 500, marginTop: 2 }}>Real Estate</div>
            </div>
            <div>
              <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase" }}>Website</div>
              <div style={{ fontWeight: 500, marginTop: 2 }}>cedar.sa</div>
            </div>
            <div>
              <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase" }}>About</div>
              <div style={{ fontWeight: 500, marginTop: 2, lineHeight: 1.4, fontSize: 13 }}>Premium real estate &amp; property management across the GCC.</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingsAPI({ isAr, reveal, setReveal }) {
  return (
    <div>
      <SectionHeader
        title="API & Keys"
        subtitle="Use these keys to call the tkana REST and WebSocket APIs"
        actions={<button className="btn primary"><IconPlus w={14} />Generate key</button>}
      />
      <div style={{ padding: 20 }}>
        <div className="card">
          <table className="tbl">
            <thead><tr><th>Name</th><th>Key</th><th>Permissions</th><th>Created</th><th>Last used</th><th style={{ width: 80 }}></th></tr></thead>
            <tbody>
              {API_KEYS.map((k, i) => (
                <tr key={k.name}>
                  <td style={{ fontWeight: 500 }}>{k.name}</td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    <span style={{ background: "var(--bg-2)", padding: "2px 8px", borderRadius: 4, border: "1px solid var(--line-soft)" }}>
                      {reveal === i ? "tk_live_82a4f3091d4a8c7b9e5d2c91d" : k.key}
                    </span>
                    <button className="btn sm ghost" style={{ marginInlineStart: 6 }} onClick={() => setReveal(reveal === i ? null : i)}>
                      {reveal === i ? "Hide" : "Reveal"}
                    </button>
                  </td>
                  <td><Badge kind={k.perms === "Read only" ? "" : "ai"}>{k.perms}</Badge></td>
                  <td className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>{k.created}</td>
                  <td className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>{k.lastUsed}</td>
                  <td><button className="btn sm ghost danger">Revoke</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: 20 }}>
          <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>Quick start</h3>
          <pre style={{
            background: "var(--bg-1)", border: "1px solid var(--line-soft)", borderRadius: "var(--r-md)",
            padding: 16, fontSize: 12, fontFamily: "var(--font-mono)", overflow: "auto", margin: 0,
            color: "var(--ink-1)",
          }}>
{`curl https://api.tkana.app/v2/conversations \\
  -H "Authorization: Bearer tk_live_••••••••" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "+966502348810",
    "agent": "luna",
    "message": "Welcome back, Reem!"
  }'`}
          </pre>
        </div>
      </div>
    </div>
  );
}

function SettingsWebhooks({ isAr }) {
  return (
    <div>
      <SectionHeader
        title="Webhooks"
        subtitle="Receive real-time events at your endpoints"
        actions={<button className="btn primary"><IconPlus w={14} />Add endpoint</button>}
      />
      <div style={{ padding: 20 }}>
        {WEBHOOKS.map((w, i) => (
          <div key={i} className="card" style={{ padding: 16, marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
              <Badge kind={w.status === "active" ? "ok" : w.status === "paused" ? "warn" : "bad"} dot>{w.status}</Badge>
              <span className="mono" style={{ fontSize: 13, fontWeight: 500, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{w.url}</span>
              <Toggle on={w.status === "active"} />
              <button className="btn sm ghost"><IconMore w={14} /></button>
            </div>
            <div style={{ display: "flex", gap: 24, fontSize: 12, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>
              <span>{w.events} events</span>
              <span>last delivery {w.lastDelivery}</span>
              <span style={{ color: w.success > 95 ? "var(--ok)" : w.success > 75 ? "var(--warn)" : "var(--bad)" }}>{w.success}% success</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SettingsNotifications({ isAr }) {
  return (
    <div>
      <SectionHeader title="Notifications" subtitle="Choose how you'd like to be alerted" />
      <div style={{ padding: 20 }}>
        <div className="card">
          <table className="tbl">
            <thead><tr><th>Event</th><th style={{ textAlign: "center" }}>Email</th><th style={{ textAlign: "center" }}>SMS</th><th style={{ textAlign: "center" }}>Push</th><th style={{ textAlign: "center" }}>In-app</th></tr></thead>
            <tbody>
              {NOTIF_PREFS.map(n => (
                <tr key={n.area}>
                  <td style={{ fontWeight: 500 }}>{n.area}</td>
                  <td style={{ textAlign: "center" }}><Toggle on={n.email} /></td>
                  <td style={{ textAlign: "center" }}><Toggle on={n.sms} /></td>
                  <td style={{ textAlign: "center" }}><Toggle on={n.push} /></td>
                  <td style={{ textAlign: "center" }}><Toggle on={n.inApp} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function SettingsBranding({ isAr }) {
  return (
    <div>
      <SectionHeader title="Branding" subtitle="How tkana looks to your team and customers" />
      <FieldRow label="Brand color" hint="Used in templates, invoices, and customer emails.">
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {["oklch(0.78 0.18 152)","oklch(0.62 0.18 250)","oklch(0.75 0.16 80)","oklch(0.65 0.20 330)","oklch(0.55 0.22 30)"].map((c, i) => (
            <span key={i} style={{ width: 32, height: 32, borderRadius: "50%", background: c, border: i === 0 ? "2px solid var(--ink)" : "2px solid transparent", cursor: "pointer" }} />
          ))}
          <input className="mono" style={{ ...fieldStyle, maxWidth: 140, marginInlineStart: 8 }} defaultValue="#21D196" />
        </div>
      </FieldRow>
      <FieldRow label="Logo (light)"><PhotoSlot label="logo-light.svg" w={180} h={64} /></FieldRow>
      <FieldRow label="Logo (dark)"><PhotoSlot label="logo-dark.svg" w={180} h={64} /></FieldRow>
      <FieldRow label="Custom domain" hint="CNAME tkana.cedar.sa to app.tkana.app.">
        <input className="mono" style={fieldStyle} defaultValue="tkana.cedar.sa" />
      </FieldRow>
      <FieldRow label="Email footer">
        <textarea style={{ ...fieldStyle, minHeight: 80, fontFamily: "var(--font-mono)" }} defaultValue="Cedar Group · King Fahd Rd, Riyadh · cedar.sa" />
      </FieldRow>
    </div>
  );
}

function SettingsSecurity({ isAr }) {
  return (
    <div>
      <SectionHeader title="Security" subtitle="Authentication, sessions, audit trail" />
      <FieldRow label="Two-factor (2FA)" hint="Required for all members of this workspace.">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Toggle on={true} />
          <span style={{ color: "var(--ok)", fontSize: 12 }}><IconCheckCircle w={14} /> Enforced for all members</span>
        </div>
      </FieldRow>
      <FieldRow label="Single sign-on (SSO)" hint="SAML 2.0 — available on Scale and Enterprise plans.">
        <div style={{ display: "flex", gap: 6 }}>
          <Badge>SAML 2.0</Badge>
          <Badge>Okta</Badge>
          <Badge>Google</Badge>
          <button className="btn sm" style={{ marginInlineStart: 8 }}>Configure</button>
        </div>
      </FieldRow>
      <FieldRow label="Session timeout" hint="Members will be signed out after this period of inactivity.">
        <div style={{ display: "flex", gap: 6 }}>
          {["1h","8h","24h","7d","Never"].map((s, i) => (
            <button key={s} className={`btn sm ${i === 2 ? "primary" : ""}`}>{s}</button>
          ))}
        </div>
      </FieldRow>
      <FieldRow label="Allowed IP ranges" hint="Restrict workspace access to specific networks.">
        <textarea style={{ ...fieldStyle, fontFamily: "var(--font-mono)", minHeight: 60 }} defaultValue={"10.0.0.0/8\n203.0.113.0/24"} />
      </FieldRow>
      <FieldRow label="Active sessions">
        <div style={{ display: "grid", gap: 8 }}>
          {[
            { device: "MacBook Pro · Chrome 124", loc: "Riyadh, SA", current: true,  last: "now" },
            { device: "iPhone 15 · iOS Safari",   loc: "Riyadh, SA", current: false, last: "2h" },
            { device: "iPad · WhatsApp",          loc: "Dubai, AE",  current: false, last: "yesterday" },
          ].map((s, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "var(--bg-2)", borderRadius: "var(--r)", border: "1px solid var(--line-soft)" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{s.device}{s.current && <span style={{ color: "var(--accent)", marginInlineStart: 8, fontSize: 11, fontFamily: "var(--font-mono)" }}>● current</span>}</div>
                <div style={{ fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>{s.loc} · {s.last}</div>
              </div>
              {!s.current && <button className="btn sm ghost danger">Revoke</button>}
            </div>
          ))}
        </div>
      </FieldRow>
      <FieldRow label="Audit log" hint="Keep a record of every change for compliance (180 days retention on Pro).">
        <button className="btn"><IconBook w={14} />View audit log</button>
      </FieldRow>
    </div>
  );
}

window.ScreenSettings = ScreenSettings;
