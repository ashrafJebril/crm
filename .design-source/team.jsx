// src/screens/team.jsx — Team members + roles & permissions

const { useState: useStateTeam } = React;

const TEAM_FULL = [
  { id: "u1", name: "Yara Khaled",    role: "Owner",   email: "yara@cedar.sa",     phone: "+966 50 234 8810", status: "online",  lastSeen: "now",   joined: "Jan 2024", twoFA: true,  initials: "YK", color: "150", convs: 0,   avgResp: "—" },
  { id: "u2", name: "Omar Daher",     role: "Admin",   email: "omar@cedar.sa",     phone: "+966 55 112 0033", status: "online",  lastSeen: "2m",    joined: "Mar 2024", twoFA: true,  initials: "OD", color: "240", convs: 184, avgResp: "1m 12s" },
  { id: "u3", name: "Lina Saad",      role: "Agent",   email: "lina@cedar.sa",     phone: "+961 3 990 145",   status: "online",  lastSeen: "now",   joined: "May 2024", twoFA: true,  initials: "LS", color: "320", convs: 312, avgResp: "0m 48s" },
  { id: "u4", name: "Karim Idrissi",  role: "Agent",   email: "karim@cedar.sa",    phone: "+212 6 612 099 33",status: "away",    lastSeen: "12m",   joined: "Aug 2024", twoFA: false, initials: "KI", color: "60",  convs: 87,  avgResp: "2m 04s" },
  { id: "u5", name: "Reza Pahlavi",   role: "Analyst", email: "reza@cedar.sa",     phone: "+98 21 8866 1102", status: "offline", lastSeen: "yest",  joined: "Oct 2024", twoFA: true,  initials: "RP", color: "30",  convs: 0,   avgResp: "—" },
  { id: "u6", name: "Sofia Almazán",  role: "Agent",   email: "sofia@cedar.sa",    phone: "+34 600 421 778",  status: "online",  lastSeen: "now",   joined: "Feb 2025", twoFA: true,  initials: "SA", color: "300", convs: 142, avgResp: "1m 02s" },
  { id: "u7", name: "Tomás Reyes",    role: "Viewer",  email: "tomas@partner.io",  phone: "+1 415 555 0188",  status: "offline", lastSeen: "3d",    joined: "Mar 2025", twoFA: false, initials: "TR", color: "210", convs: 0,   avgResp: "—" },
];

const PENDING = [
  { email: "fatima@cedar.sa",  role: "Agent", invitedBy: "Yara", sent: "2d ago" },
  { email: "newhire@cedar.sa", role: "Agent", invitedBy: "Omar", sent: "5h ago" },
];

const ROLES = [
  { name: "Owner",   color: "ai",   desc: "Full access, billing, delete workspace" },
  { name: "Admin",   color: "info", desc: "Manage everything except billing & destruction" },
  { name: "Agent",   color: "ok",   desc: "Reply, assign, manage own conversations" },
  { name: "Analyst", color: "warn", desc: "Read-only across analytics & reports" },
  { name: "Viewer",  color: "",     desc: "Read-only across the workspace" },
];

const PERMS = [
  { area: "Inbox",       caps: ["View", "Reply", "Assign", "Close"] },
  { area: "AI Agents",   caps: ["View", "Edit prompt", "Deploy", "Delete"] },
  { area: "Campaigns",   caps: ["View", "Create", "Send", "Delete"] },
  { area: "Contacts",    caps: ["View", "Edit", "Export", "Delete"] },
  { area: "Automations", caps: ["View", "Edit", "Activate", "Delete"] },
  { area: "Settings",    caps: ["View", "Edit", "Integrations", "Billing"] },
];

// permissions matrix: 1 = allowed, 0 = denied
const matrix = {
  Owner:   [[1,1,1,1],[1,1,1,1],[1,1,1,1],[1,1,1,1],[1,1,1,1],[1,1,1,1]],
  Admin:   [[1,1,1,1],[1,1,1,1],[1,1,1,1],[1,1,1,1],[1,1,1,1],[1,1,1,0]],
  Agent:   [[1,1,1,1],[1,0,0,0],[1,1,0,0],[1,1,0,0],[1,0,0,0],[1,0,0,0]],
  Analyst: [[1,0,0,0],[1,0,0,0],[1,0,0,0],[1,0,1,0],[1,0,0,0],[1,0,0,0]],
  Viewer:  [[1,0,0,0],[1,0,0,0],[1,0,0,0],[1,0,0,0],[1,0,0,0],[1,0,0,0]],
};

const ACTIVITY = [
  { who: "Lina", what: "closed 14 conversations", when: "12m" },
  { who: "Omar", what: "approved template tahdid_eid_promo", when: "1h" },
  { who: "Yara", what: "invited fatima@cedar.sa as Agent", when: "2d" },
  { who: "Karim",what: "created automation 'Cart abandon → drip'", when: "2d" },
  { who: "Sofia",what: "exported 1,824 contacts to CSV", when: "3d" },
  { who: "Reza", what: "viewed Q1 NPS report", when: "4d" },
];

function ScreenTeam({ t, setTweak }) {
  const isAr = t.lang === "ar";
  const [tab, setTab] = useStateTeam("members");
  const [selectedRole, setSelectedRole] = useStateTeam("Agent");
  const [showInvite, setShowInvite] = useStateTeam(false);

  return (
    <div data-screen-label="Team" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <PageHeader
        title={isAr ? "الفريق" : "Team"}
        subtitle={isAr ? "أعضاء الفريق، الأدوار، والصلاحيات" : "Members, roles, and permissions for your workspace"}
        actions={
          <>
            <button className="btn ghost"><IconBolt w={14} />{isAr ? "السجل" : "Activity"}</button>
            <button className="btn primary" onClick={() => setShowInvite(true)}><IconPlus w={14} />{isAr ? "دعوة عضو" : "Invite member"}</button>
          </>
        }
      />

      <div className="tabs">
        <div className={`tab ${tab === "members" ? "active" : ""}`} onClick={() => setTab("members")}>
          {isAr ? "الأعضاء" : "Members"} <span className="count">{TEAM_FULL.length}</span>
        </div>
        <div className={`tab ${tab === "pending" ? "active" : ""}`} onClick={() => setTab("pending")}>
          {isAr ? "دعوات معلقة" : "Pending"} <span className="count">{PENDING.length}</span>
        </div>
        <div className={`tab ${tab === "roles" ? "active" : ""}`} onClick={() => setTab("roles")}>
          {isAr ? "الأدوار" : "Roles & Permissions"}
        </div>
        <div className={`tab ${tab === "activity" ? "active" : ""}`} onClick={() => setTab("activity")}>
          {isAr ? "السجل" : "Activity log"}
        </div>
      </div>

      {tab === "members" && (
        <div style={{ padding: 20, display: "grid", gap: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
            <div className="stat"><div className="label">Members</div><div className="value">{TEAM_FULL.length}</div></div>
            <div className="stat"><div className="label">Online now</div><div className="value">{TEAM_FULL.filter(m => m.status === "online").length}<span className="unit">/ {TEAM_FULL.length}</span></div></div>
            <div className="stat"><div className="label">Avg response</div><div className="value">1<span className="unit">m 18s</span></div></div>
            <div className="stat"><div className="label">2FA enrolled</div><div className="value">{TEAM_FULL.filter(m => m.twoFA).length}<span className="unit">/ {TEAM_FULL.length}</span></div></div>
          </div>

          <div className="card">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{isAr ? "العضو" : "Member"}</th>
                  <th>{isAr ? "الدور" : "Role"}</th>
                  <th>{isAr ? "الحالة" : "Status"}</th>
                  <th style={{ textAlign: "end" }}>{isAr ? "محادثات" : "Conversations"}</th>
                  <th style={{ textAlign: "end" }}>{isAr ? "متوسط الرد" : "Avg response"}</th>
                  <th>2FA</th>
                  <th>{isAr ? "انضم" : "Joined"}</th>
                  <th style={{ width: 30 }}></th>
                </tr>
              </thead>
              <tbody>
                {TEAM_FULL.map(m => (
                  <tr key={m.id}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ position: "relative" }}>
                          <Avatar name={m.name} color={m.color} />
                          <span style={{
                            position: "absolute", insetInlineEnd: -1, bottom: -1,
                            width: 9, height: 9, borderRadius: "50%",
                            background: m.status === "online" ? "var(--ok)" : m.status === "away" ? "var(--warn)" : "var(--ink-4)",
                            border: "2px solid var(--bg-1)",
                          }} />
                        </span>
                        <div>
                          <div style={{ fontWeight: 500 }}>{m.name}</div>
                          <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>{m.email}</div>
                        </div>
                      </div>
                    </td>
                    <td><Badge kind={ROLES.find(r => r.name === m.role)?.color || ""}>{m.role}</Badge></td>
                    <td className="mono" style={{ fontSize: 12, color: "var(--ink-2)" }}>{m.lastSeen}</td>
                    <td className="mono" style={{ textAlign: "end", fontSize: 12 }}>{m.convs || "—"}</td>
                    <td className="mono" style={{ textAlign: "end", fontSize: 12 }}>{m.avgResp}</td>
                    <td>{m.twoFA
                      ? <span style={{ color: "var(--ok)" }}><IconCheckCircle w={14} /></span>
                      : <span style={{ color: "var(--warn)" }}><IconAlert w={14} /></span>}</td>
                    <td className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>{m.joined}</td>
                    <td><IconMore w={14} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "pending" && (
        <div style={{ padding: 20 }}>
          <div className="card">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{isAr ? "البريد" : "Email"}</th>
                  <th>{isAr ? "الدور" : "Role"}</th>
                  <th>{isAr ? "دعا بواسطة" : "Invited by"}</th>
                  <th>{isAr ? "تاريخ" : "Sent"}</th>
                  <th style={{ width: 220, textAlign: "end" }}></th>
                </tr>
              </thead>
              <tbody>
                {PENDING.map(p => (
                  <tr key={p.email}>
                    <td className="mono" style={{ fontSize: 12 }}>{p.email}</td>
                    <td><Badge>{p.role}</Badge></td>
                    <td>{p.invitedBy}</td>
                    <td className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>{p.sent}</td>
                    <td style={{ textAlign: "end" }}>
                      <button className="btn sm ghost">{isAr ? "إعادة" : "Resend"}</button>
                      <button className="btn sm danger" style={{ marginInlineStart: 6 }}>{isAr ? "إلغاء" : "Revoke"}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "roles" && (
        <div style={{ padding: 20, display: "grid", gridTemplateColumns: "240px 1fr", gap: 16 }}>
          <div className="card" style={{ padding: 8 }}>
            {ROLES.map(r => (
              <div key={r.name}
                   onClick={() => setSelectedRole(r.name)}
                   style={{
                     padding: "10px 12px",
                     borderRadius: "var(--r-sm)",
                     cursor: "pointer",
                     background: selectedRole === r.name ? "var(--bg-2)" : "transparent",
                     border: selectedRole === r.name ? "1px solid var(--line-soft)" : "1px solid transparent",
                     marginBottom: 4,
                   }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <Badge kind={r.color}>{r.name}</Badge>
                  <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)", marginInlineStart: "auto" }}>
                    {TEAM_FULL.filter(m => m.role === r.name).length}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "var(--ink-2)", lineHeight: 1.4 }}>{r.desc}</div>
              </div>
            ))}
          </div>

          <div className="card">
            <div className="card-h">
              <div>
                <h3>{selectedRole} {isAr ? "الصلاحيات" : "permissions"}</h3>
                <div className="sub">{ROLES.find(r => r.name === selectedRole)?.desc}</div>
              </div>
              <button className="btn sm">{isAr ? "نسخ كقالب" : "Duplicate as template"}</button>
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{isAr ? "المنطقة" : "Area"}</th>
                  {PERMS[0].caps.map((c, i) => <th key={i} style={{ textAlign: "center" }}>{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {PERMS.map((row, ri) => (
                  <tr key={row.area}>
                    <td style={{ fontWeight: 500 }}>{row.area}</td>
                    {row.caps.map((c, ci) => {
                      const allowed = matrix[selectedRole][ri][ci];
                      return (
                        <td key={ci} style={{ textAlign: "center" }}>
                          {allowed
                            ? <span style={{ color: "var(--accent)" }}><IconCheck w={16} /></span>
                            : <span style={{ color: "var(--ink-4)" }}>—</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "activity" && (
        <div style={{ padding: 20, maxWidth: 720 }}>
          <div className="card">
            <div className="card-h"><h3>{isAr ? "النشاط الأخير" : "Recent activity"}</h3><div className="sub">last 7 days</div></div>
            <div style={{ padding: "8px 0" }}>
              {ACTIVITY.map((a, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderBottom: i < ACTIVITY.length - 1 ? "1px solid var(--line-soft)" : "0" }}>
                  <Avatar name={a.who} size="sm" />
                  <div style={{ flex: 1 }}>
                    <span style={{ fontWeight: 500 }}>{a.who}</span>{" "}
                    <span style={{ color: "var(--ink-2)" }}>{a.what}</span>
                  </div>
                  <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>{a.when}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {showInvite && <InviteModal onClose={() => setShowInvite(false)} isAr={isAr} />}
    </div>
  );
}

function InviteModal({ onClose, isAr }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "oklch(0 0 0 / 0.5)", display: "grid", placeItems: "center", zIndex: 100, backdropFilter: "blur(2px)" }} onClick={onClose}>
      <div className="card" style={{ width: 460, padding: 20 }} onClick={e => e.stopPropagation()}>
        <h3 style={{ margin: 0, fontSize: 16 }}>{isAr ? "ادعُ عضو فريق" : "Invite a teammate"}</h3>
        <p style={{ margin: "4px 0 16px", color: "var(--ink-2)", fontSize: 13 }}>{isAr ? "سنرسل دعوة عبر البريد الإلكتروني" : "We'll send them an email invitation."}</p>
        <label className="mono" style={{ fontSize: 11, textTransform: "uppercase", color: "var(--ink-3)" }}>Email</label>
        <input className="input" style={inputStyle} placeholder="name@company.com" />
        <label className="mono" style={{ fontSize: 11, textTransform: "uppercase", color: "var(--ink-3)", marginTop: 12, display: "block" }}>Role</label>
        <select style={{ ...inputStyle, appearance: "none" }} defaultValue="Agent">
          {ROLES.map(r => <option key={r.name}>{r.name}</option>)}
        </select>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20 }}>
          <button className="btn ghost" onClick={onClose}>{isAr ? "إلغاء" : "Cancel"}</button>
          <button className="btn primary" onClick={onClose}><IconSend w={14} />{isAr ? "أرسل الدعوة" : "Send invite"}</button>
        </div>
      </div>
    </div>
  );
}

const inputStyle = {
  width: "100%",
  background: "var(--bg-2)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r)",
  padding: "8px 12px",
  color: "var(--ink)",
  fontSize: 13,
  marginTop: 6,
  outline: "none",
};

window.ScreenTeam = ScreenTeam;
