import { memo, useState, type CSSProperties } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import type { Tx } from "@/lib/tx";
import { PageHeader } from "@/components/PageHeader";
import { Avatar } from "@/components/Avatar";
import { Badge } from "@/components/Badge";
import {
  IconAlert,
  IconBolt,
  IconCheck,
  IconCheckCircle,
  IconMore,
  IconPlus,
  IconSend,
} from "@/icons";
import {
  ACTIVITY,
  PENDING_INVITES,
  PERM_MATRIX,
  PERMS,
  ROLES,
  type RoleName,
} from "@/data/team-extras";
import { useFetch } from "@/api/useFetch";

type Tab = "members" | "pending" | "roles" | "activity";

interface TeamApiUser {
  id: string;
  name: string;
  email: string;
  role: string;
  initials: string;
  color: string;
  status: "online" | "away" | "offline";
  twoFA: boolean;
}

const inputStyle: CSSProperties = {
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

interface InviteModalProps {
  onClose: () => void;
  tx: Tx;
}

function InviteModal({ onClose, tx }: InviteModalProps) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "oklch(0 0 0 / 0.5)",
        display: "grid",
        placeItems: "center",
        zIndex: 100,
        backdropFilter: "blur(2px)",
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ width: 460, padding: 20 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: 0, fontSize: 16 }}>
          {tx("Invite a teammate", "ادعُ عضو فريق")}
        </h3>
        <p
          style={{
            margin: "4px 0 16px",
            color: "var(--ink-2)",
            fontSize: 13,
          }}
        >
          {tx(
            "We'll send them an email invitation.",
            "سنرسل دعوة عبر البريد الإلكتروني",
          )}
        </p>
        <label
          className="mono"
          style={{
            fontSize: 11,
            textTransform: "uppercase",
            color: "var(--ink-3)",
          }}
        >
          {tx("Email", "البريد")}
        </label>
        <input className="input" style={inputStyle} placeholder="name@company.com" />
        <label
          className="mono"
          style={{
            fontSize: 11,
            textTransform: "uppercase",
            color: "var(--ink-3)",
            marginTop: 12,
            display: "block",
          }}
        >
          {tx("Role", "الدور")}
        </label>
        <select
          style={{ ...inputStyle, appearance: "none" }}
          defaultValue="Agent"
        >
          {ROLES.map((r) => (
            <option key={r.name}>{r.name}</option>
          ))}
        </select>
        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: 20,
          }}
        >
          <button className="btn ghost" onClick={onClose}>
            {tx("Cancel", "إلغاء")}
          </button>
          <button className="btn primary" onClick={onClose}>
            <IconSend w={14} />
            {tx("Send invite", "أرسل الدعوة")}
          </button>
        </div>
      </div>
    </div>
  );
}

function statusColor(s: "online" | "away" | "offline"): string {
  if (s === "online") return "var(--ok)";
  if (s === "away") return "var(--warn)";
  return "var(--ink-4)";
}

function TeamImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);

  const [tab, setTab] = useState<Tab>("members");
  const [selectedRole, setSelectedRole] = useState<RoleName>("Agent");
  const [showInvite, setShowInvite] = useState(false);

  const {
    data: teamData,
    loading,
    error,
    refetch,
  } = useFetch<TeamApiUser[]>("/team");

  const team: TeamApiUser[] = teamData ?? [];
  const onlineCount = team.filter((m) => m.status === "online").length;
  const twoFACount = team.filter((m) => m.twoFA).length;
  const selectedRoleDef = ROLES.find((r) => r.name === selectedRole);

  return (
    <div
      data-screen-label="Team"
      style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}
    >
      <PageHeader
        title={tx("Team", "الفريق")}
        subtitle={tx(
          "Members, roles, and permissions for your workspace",
          "أعضاء الفريق، الأدوار، والصلاحيات",
        )}
        actions={
          <>
            <button className="btn ghost">
              <IconBolt w={14} />
              {tx("Activity", "السجل")}
            </button>
            <button
              className="btn primary"
              onClick={() => setShowInvite(true)}
            >
              <IconPlus w={14} />
              {tx("Invite member", "دعوة عضو")}
            </button>
          </>
        }
      />

      <div className="tabs">
        <div
          className={`tab ${tab === "members" ? "active" : ""}`}
          onClick={() => setTab("members")}
        >
          {tx("Members", "الأعضاء")}{" "}
          <span className="count">{team.length}</span>
        </div>
        <div
          className={`tab ${tab === "pending" ? "active" : ""}`}
          onClick={() => setTab("pending")}
        >
          {tx("Pending", "دعوات معلقة")}{" "}
          <span className="count">{PENDING_INVITES.length}</span>
        </div>
        <div
          className={`tab ${tab === "roles" ? "active" : ""}`}
          onClick={() => setTab("roles")}
        >
          {tx("Roles & Permissions", "الأدوار")}
        </div>
        <div
          className={`tab ${tab === "activity" ? "active" : ""}`}
          onClick={() => setTab("activity")}
        >
          {tx("Activity log", "السجل")}
        </div>
      </div>

      {tab === "members" && (
        <div style={{ padding: 20, display: "grid", gap: 16 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: 12,
            }}
          >
            <div className="stat">
              <div className="label">{tx("Members", "الأعضاء")}</div>
              <div className="value">{team.length}</div>
            </div>
            <div className="stat">
              <div className="label">{tx("Online now", "متصلون الآن")}</div>
              <div className="value">
                {onlineCount}
                <span className="unit">/ {team.length}</span>
              </div>
            </div>
            <div className="stat">
              <div className="label">{tx("Avg response", "متوسط الرد")}</div>
              <div className="value">
                1<span className="unit">m 18s</span>
              </div>
            </div>
            <div className="stat">
              <div className="label">{tx("2FA enrolled", "مسجلو 2FA")}</div>
              <div className="value">
                {twoFACount}
                <span className="unit">/ {team.length}</span>
              </div>
            </div>
          </div>

          {loading && (
            <div
              className="muted"
              style={{
                padding: "10px 12px",
                fontSize: 12,
                opacity: 0.7,
                animation: "pulse 1.2s ease-in-out infinite",
              }}
            >
              {tx("loading…", "جارٍ التحميل…")}
            </div>
          )}

          {error && !loading && (
            <div
              style={{
                padding: "10px 12px",
                borderRadius: 8,
                background: "color-mix(in oklch, var(--bad) 12%, transparent)",
                color: "var(--bad)",
                fontSize: 12,
                display: "flex",
                alignItems: "center",
                gap: 12,
                border: "1px solid color-mix(in oklch, var(--bad) 32%, transparent)",
              }}
            >
              <span>{error}</span>
              <button className="btn sm" onClick={refetch}>
                {tx("Retry", "إعادة")}
              </button>
            </div>
          )}

          {!loading && !error && (
            <div className="card">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{tx("Member", "العضو")}</th>
                    <th>{tx("Role", "الدور")}</th>
                    <th>{tx("Status", "الحالة")}</th>
                    <th style={{ textAlign: "end" }}>
                      {tx("Conversations", "محادثات")}
                    </th>
                    <th style={{ textAlign: "end" }}>
                      {tx("Avg response", "متوسط الرد")}
                    </th>
                    <th>2FA</th>
                    <th>{tx("Joined", "انضم")}</th>
                    <th style={{ width: 30 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {team.map((m) => {
                    const roleDef = ROLES.find((r) => r.name === m.role);
                    return (
                      <tr key={m.id}>
                        <td>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 10,
                            }}
                          >
                            <span style={{ position: "relative" }}>
                              <Avatar name={m.name} color={m.color} />
                              <span
                                style={{
                                  position: "absolute",
                                  insetInlineEnd: -1,
                                  bottom: -1,
                                  width: 9,
                                  height: 9,
                                  borderRadius: "50%",
                                  background: statusColor(m.status),
                                  border: "2px solid var(--bg-1)",
                                }}
                              />
                            </span>
                            <div>
                              <div style={{ fontWeight: 500 }}>{m.name}</div>
                              <div
                                className="mono"
                                style={{ fontSize: 11, color: "var(--ink-3)" }}
                              >
                                {m.email}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td>
                          <Badge kind={roleDef?.color ?? ""}>{m.role}</Badge>
                        </td>
                        <td
                          className="mono"
                          style={{ fontSize: 12, color: "var(--ink-2)" }}
                        >
                          {m.status}
                        </td>
                        <td
                          className="mono"
                          style={{ textAlign: "end", fontSize: 12 }}
                        >
                          —
                        </td>
                        <td
                          className="mono"
                          style={{ textAlign: "end", fontSize: 12 }}
                        >
                          —
                        </td>
                        <td>
                          {m.twoFA ? (
                            <span style={{ color: "var(--ok)" }}>
                              <IconCheckCircle w={14} />
                            </span>
                          ) : (
                            <span style={{ color: "var(--warn)" }}>
                              <IconAlert w={14} />
                            </span>
                          )}
                        </td>
                        <td
                          className="mono"
                          style={{ fontSize: 11, color: "var(--ink-3)" }}
                        >
                          —
                        </td>
                        <td>
                          <IconMore w={14} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === "pending" && (
        <div style={{ padding: 20 }}>
          <div className="card">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{tx("Email", "البريد")}</th>
                  <th>{tx("Role", "الدور")}</th>
                  <th>{tx("Invited by", "دعا بواسطة")}</th>
                  <th>{tx("Sent", "تاريخ")}</th>
                  <th style={{ width: 220, textAlign: "end" }}></th>
                </tr>
              </thead>
              <tbody>
                {PENDING_INVITES.map((p) => (
                  <tr key={p.email}>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {p.email}
                    </td>
                    <td>
                      <Badge>{p.role}</Badge>
                    </td>
                    <td>{p.invitedBy}</td>
                    <td
                      className="mono"
                      style={{ fontSize: 11, color: "var(--ink-3)" }}
                    >
                      {p.sent}
                    </td>
                    <td style={{ textAlign: "end" }}>
                      <button className="btn sm ghost">
                        {tx("Resend", "إعادة")}
                      </button>
                      <button
                        className="btn sm danger"
                        style={{ marginInlineStart: 6 }}
                      >
                        {tx("Revoke", "إلغاء")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "roles" && (
        <div
          style={{
            padding: 20,
            display: "grid",
            gridTemplateColumns: "240px 1fr",
            gap: 16,
          }}
        >
          <div className="card" style={{ padding: 8 }}>
            {ROLES.map((r) => {
              const isSelected = selectedRole === r.name;
              return (
                <div
                  key={r.name}
                  onClick={() => setSelectedRole(r.name)}
                  style={{
                    padding: "10px 12px",
                    borderRadius: "var(--r-sm)",
                    cursor: "pointer",
                    background: isSelected ? "var(--bg-2)" : "transparent",
                    border: isSelected
                      ? "1px solid var(--line-soft)"
                      : "1px solid transparent",
                    marginBottom: 4,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      marginBottom: 4,
                    }}
                  >
                    <Badge kind={r.color}>{r.name}</Badge>
                    <span
                      className="mono"
                      style={{
                        fontSize: 10,
                        color: "var(--ink-3)",
                        marginInlineStart: "auto",
                      }}
                    >
                      {team.filter((m) => m.role === r.name).length}
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--ink-2)",
                      lineHeight: 1.4,
                    }}
                  >
                    {tx(r.descEn, r.descAr)}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="card">
            <div className="card-h">
              <div>
                <h3>
                  {selectedRole} {tx("permissions", "الصلاحيات")}
                </h3>
                <div className="sub">
                  {selectedRoleDef
                    ? tx(selectedRoleDef.descEn, selectedRoleDef.descAr)
                    : null}
                </div>
              </div>
              <button className="btn sm">
                {tx("Duplicate as template", "نسخ كقالب")}
              </button>
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{tx("Area", "المنطقة")}</th>
                  {PERMS[0]!.caps.map((c, i) => (
                    <th key={i} style={{ textAlign: "center" }}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PERMS.map((row, ri) => (
                  <tr key={row.area}>
                    <td style={{ fontWeight: 500 }}>{row.area}</td>
                    {row.caps.map((_c, ci) => {
                      const allowed = PERM_MATRIX[selectedRole][ri]![ci] === 1;
                      return (
                        <td key={ci} style={{ textAlign: "center" }}>
                          {allowed ? (
                            <span style={{ color: "var(--accent)" }}>
                              <IconCheck w={16} />
                            </span>
                          ) : (
                            <span style={{ color: "var(--ink-4)" }}>—</span>
                          )}
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
            <div className="card-h">
              <h3>{tx("Recent activity", "النشاط الأخير")}</h3>
              <div className="sub">{tx("last 7 days", "آخر ٧ أيام")}</div>
            </div>
            <div style={{ padding: "8px 0" }}>
              {ACTIVITY.map((a, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "10px 16px",
                    borderBottom:
                      i < ACTIVITY.length - 1
                        ? "1px solid var(--line-soft)"
                        : "0",
                  }}
                >
                  <Avatar name={a.who} size="sm" />
                  <div style={{ flex: 1 }}>
                    <span style={{ fontWeight: 500 }}>{a.who}</span>{" "}
                    <span style={{ color: "var(--ink-2)" }}>
                      {tx(a.whatEn, a.whatAr)}
                    </span>
                  </div>
                  <span
                    className="mono"
                    style={{ fontSize: 11, color: "var(--ink-3)" }}
                  >
                    {a.when}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {showInvite && (
        <InviteModal onClose={() => setShowInvite(false)} tx={tx} />
      )}
    </div>
  );
}

const Team = memo(TeamImpl);
export default Team;
