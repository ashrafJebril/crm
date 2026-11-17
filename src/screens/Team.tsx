import { memo, useMemo, useState, type CSSProperties } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import type { Tx } from "@/lib/tx";
import { PageHeader } from "@/components/PageHeader";
import { Avatar } from "@/components/Avatar";
import { Badge } from "@/components/Badge";
import { useToast } from "@/components/Toast";
import { IconAlert, IconBolt, IconCheckCircle, IconPlus, IconSend } from "@/icons";
import { useFetch } from "@/api/useFetch";
import { api } from "@/api/client";
import { useAuth } from "@/auth/context";
import { usePermissions } from "@/auth/usePermissions";
import { RolesTab, type RoleRow } from "@/screens/settings/RolesTab";
import { roleOptionsFromTeam, type RoleOption } from "@/lib/roleErrors";
import type { AuditPage, InvitationList, InvitationWrite } from "@/lib/types";
import {
  INVITE_FILTERS,
  canResend,
  canRevoke,
  filterCounts,
  filterInvites,
  filterLabel,
  inviteStatus,
  statusChip,
  type InviteFilter,
} from "@/screens/team/inviteModel";
import { AUDIT_ACTIONS, auditActionLabel, auditLine, auditTime } from "@/screens/team/auditModel";
import { memberErrorText } from "@/screens/team/memberErrors";
import { MemberHandoverDialog } from "@/screens/team/MemberHandoverDialog";

type Tab = "members" | "pending" | "roles" | "activity";

interface TeamApiUser {
  id: string;
  name: string;
  email: string;
  role: string;
  roleId?: string | null;
  roleName?: string;
  roleNameAr?: string;
  initials: string;
  color: string;
  status: "online" | "away" | "offline";
  twoFA: boolean;
  joinedAt?: string;
}

const inputStyle: CSSProperties = {
  width: "100%",
  background: "var(--bg-2)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r)",
  paddingBlock: 8,
  paddingInline: 12,
  color: "var(--ink)",
  fontSize: 13,
  marginTop: 6,
  outline: "none",
};

const labelStyle: CSSProperties = { fontSize: 11, textTransform: "uppercase", color: "var(--ink-3)", display: "block", marginTop: 12 };

/** Dates with Latin digits in both languages (SP-04). */
const day = (iso: string | undefined, lang: "en" | "ar") =>
  iso
    ? new Intl.DateTimeFormat(lang === "ar" ? "ar-SA-u-nu-latn-ca-gregory" : "en-GB", { dateStyle: "medium" }).format(new Date(iso))
    : "—";

function statusColor(s: "online" | "away" | "offline"): string {
  if (s === "online") return "var(--ok)";
  if (s === "away") return "var(--warn)";
  return "var(--ink-4)";
}

/* ─── Invite modal ───────────────────────────────────────────────────── */

function InviteModal({ wsId, roles, tx, lang, onClose, onSent }: {
  wsId: string;
  roles: RoleOption[];
  tx: Tx;
  lang: "en" | "ar";
  onClose: () => void;
  onSent: () => void;
}) {
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState("");
  const [inviteLang, setInviteLang] = useState<"ar" | "en">(lang);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<InvitationWrite>(`/workspaces/${wsId}/invitations`, { email: email.trim(), roleId, lang: inviteLang });
      onSent();
      if (res.link) {
        // Email is off: the link is shown once, here only.
        setLink(res.link);
      } else {
        toast(
          res.emailSent
            ? tx(`Invitation sent to ${res.invitation.email}.`, `أُرسلت الدعوة إلى ${res.invitation.email}.`)
            : tx("The invitation was saved but the email failed. Use Resend.", "حُفظت الدعوة لكن فشل إرسال البريد. استخدم إعادة الإرسال."),
          res.emailSent ? "success" : "error",
        );
        onClose();
      }
    } catch (e) {
      setError(memberErrorText(e, tx));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      dir={lang === "ar" ? "rtl" : "ltr"}
      style={{ position: "fixed", inset: 0, background: "oklch(0 0 0 / 0.5)", display: "grid", placeItems: "center", zIndex: 100, backdropFilter: "blur(2px)" }}
      onClick={onClose}
    >
      <div className="card" style={{ width: 460, maxWidth: "calc(100vw - 32px)", padding: 20 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: 0, fontSize: 16 }}>{tx("Invite a teammate", "ادعُ عضو فريق")}</h3>
        {link ? (
          <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
            <div style={{ fontSize: 13 }}>
              {tx(
                "Email is not set up, so share this link with them yourself. It is shown only now, works once and expires in 7 days.",
                "البريد غير مُعدّ، لذا شارك هذا الرابط معهم بنفسك. يظهر الآن فقط، ويعمل مرة واحدة، وتنتهي صلاحيته خلال 7 أيام.",
              )}
            </div>
            <input readOnly dir="ltr" value={link} onFocus={(e) => e.currentTarget.select()} style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: 12 }} />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => void navigator.clipboard?.writeText(link).then(() => setCopied(true))}>
                {copied ? tx("Copied", "تم النسخ") : tx("Copy link", "نسخ الرابط")}
              </button>
              <button className="btn primary" onClick={onClose}>
                {tx("Done", "تم")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <p style={{ margin: "4px 0 4px", color: "var(--ink-2)", fontSize: 13 }}>
              {tx("We'll email them a link to join. It expires in 7 days.", "سنرسل لهم رابطًا للانضمام عبر البريد. تنتهي صلاحيته خلال 7 أيام.")}
            </p>
            <label className="mono" style={labelStyle}>
              {tx("Email", "البريد")}
            </label>
            <input dir="ltr" type="email" className="input" style={inputStyle} placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <label className="mono" style={labelStyle}>
              {tx("Role", "الدور")}
            </label>
            <select style={inputStyle} value={roleId} onChange={(e) => setRoleId(e.target.value)}>
              <option value="">{tx("Choose a role…", "اختر دورًا…")}</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {tx(r.name, r.nameAr || r.name)}
                </option>
              ))}
            </select>
            <label className="mono" style={labelStyle}>
              {tx("Email language", "لغة البريد")}
            </label>
            <select style={inputStyle} value={inviteLang} onChange={(e) => setInviteLang(e.target.value === "en" ? "en" : "ar")}>
              <option value="ar">العربية</option>
              <option value="en">English</option>
            </select>
            {error && <div style={{ color: "var(--bad)", fontSize: 13, marginTop: 10 }}>{error}</div>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20 }}>
              <button className="btn ghost" onClick={onClose}>
                {tx("Cancel", "إلغاء")}
              </button>
              <button className="btn primary" disabled={busy || !email.trim() || !roleId} onClick={() => void send()}>
                <IconSend w={14} />
                {busy ? tx("Sending…", "جارٍ الإرسال…") : tx("Send invite", "أرسل الدعوة")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ─── Invitations tab ────────────────────────────────────────────────── */

function PendingTab({ wsId, tx, lang, canCreate, canDelete }: { wsId: string; tx: Tx; lang: "en" | "ar"; canCreate: boolean; canDelete: boolean }) {
  const q = useFetch<InvitationList>(`/workspaces/${wsId}/invitations?status=all`);
  const [filter, setFilter] = useState<InviteFilter>("pending");
  const [link, setLink] = useState<string | null>(null);
  const { toast } = useToast();
  const now = new Date();
  const list = q.data?.items ?? [];
  const counts = filterCounts(list, now);
  const shown = filterInvites(list, filter, now);

  const act = async (fn: () => Promise<void>) => {
    try {
      await fn();
      q.refetch();
    } catch (e) {
      toast(memberErrorText(e, tx), "error");
    }
  };

  const resend = (id: string, email: string) =>
    act(async () => {
      const res = await api.post<InvitationWrite>(`/workspaces/${wsId}/invitations/${id}/resend`);
      if (res.link) setLink(res.link);
      else toast(tx(`Invitation resent to ${email}.`, `أُعيد إرسال الدعوة إلى ${email}.`), "success");
    });

  const revoke = (id: string, email: string) => {
    if (!window.confirm(tx(`Revoke the invitation to ${email}? The link will stop working.`, `إلغاء الدعوة الموجهة إلى ${email}؟ سيتوقف الرابط عن العمل.`))) return;
    void act(async () => {
      await api.delete(`/workspaces/${wsId}/invitations/${id}`);
      toast(tx("Invitation revoked.", "تم إلغاء الدعوة."), "success");
    });
  };

  return (
    <div style={{ padding: 20, display: "grid", gap: 12 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {INVITE_FILTERS.map((f) => (
          <button key={f} className={`btn sm ${filter === f ? "primary" : "ghost"}`} onClick={() => setFilter(f)}>
            {filterLabel(f, tx)} <span className="mono">{counts[f]}</span>
          </button>
        ))}
      </div>
      {link && (
        <div className="card" style={{ padding: 12, display: "grid", gap: 8 }}>
          <div style={{ fontSize: 13 }}>{tx("Email is off: share this new link yourself. The old link no longer works.", "البريد غير مُفعّل: شارك هذا الرابط الجديد بنفسك. الرابط القديم لم يعد يعمل.")}</div>
          <input readOnly dir="ltr" value={link} onFocus={(e) => e.currentTarget.select()} style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: 12, marginTop: 0 }} />
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn sm" onClick={() => void navigator.clipboard?.writeText(link)}>
              {tx("Copy link", "نسخ الرابط")}
            </button>
            <button className="btn sm ghost" onClick={() => setLink(null)}>
              {tx("Done", "تم")}
            </button>
          </div>
        </div>
      )}
      {q.error && <div style={{ color: "var(--bad)", fontSize: 13 }}>{memberErrorText(new Error(q.error), tx)}</div>}
      <div className="card">
        <table className="tbl">
          <thead>
            <tr>
              <th>{tx("Email", "البريد")}</th>
              <th>{tx("Role", "الدور")}</th>
              <th>{tx("Status", "الحالة")}</th>
              <th>{tx("Invited by", "دعا بواسطة")}</th>
              <th>{tx("Sent", "أُرسلت")}</th>
              <th style={{ width: 220, textAlign: "end" }}></th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className="muted" style={{ fontSize: 13, padding: 16 }}>
                  {q.loading ? tx("loading…", "جارٍ التحميل…") : tx("No invitations here.", "لا توجد دعوات هنا.")}
                </td>
              </tr>
            )}
            {shown.map((inv) => {
              const chip = statusChip(inviteStatus(inv, now), tx);
              return (
                <tr key={inv.id}>
                  <td className="mono" style={{ fontSize: 12 }}>
                    <bdi dir="ltr">{inv.email}</bdi>
                  </td>
                  <td>
                    <Badge>{inv.role ? tx(inv.role.name, inv.role.nameAr || inv.role.name) : tx("Viewer", "المشاهد")}</Badge>
                  </td>
                  <td>
                    <Badge kind={chip.kind}>{chip.label}</Badge>
                  </td>
                  <td>{inv.invitedBy?.name ?? "—"}</td>
                  <td className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                    {day(inv.lastSentAt, lang)} · ×{inv.sendCount}
                  </td>
                  <td style={{ textAlign: "end" }}>
                    {canCreate && canResend(inv, now) && (
                      <button className="btn sm ghost" onClick={() => void resend(inv.id, inv.email)}>
                        {tx("Resend invite", "إعادة إرسال الدعوة")}
                      </button>
                    )}
                    {canDelete && canRevoke(inv, now) && (
                      <button className="btn sm danger" style={{ marginInlineStart: 6 }} onClick={() => revoke(inv.id, inv.email)}>
                        {tx("Revoke", "إلغاء الدعوة")}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ─── Activity (audit log) ───────────────────────────────────────────── */

function ActivityTab({ wsId, tx, lang, timeZone }: { wsId: string; tx: Tx; lang: "en" | "ar"; timeZone?: string }) {
  const [action, setAction] = useState("");
  const [more, setMore] = useState<AuditPage[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const first = useFetch<AuditPage>(`/workspaces/${wsId}/audit${action ? `?action=${encodeURIComponent(action)}` : ""}`);
  const { toast } = useToast();
  const all = [first.data, ...more].filter((p): p is AuditPage => !!p);
  const items = all.flatMap((p) => p.items);
  const nextCursor = all.length ? all[all.length - 1]!.nextCursor : null;

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const qs = new URLSearchParams({ cursor: nextCursor, ...(action ? { action } : {}) });
      const page = await api.get<AuditPage>(`/workspaces/${wsId}/audit?${qs.toString()}`);
      setMore((m) => [...m, page]);
    } catch (e) {
      toast(memberErrorText(e, tx), "error");
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div style={{ padding: 20, maxWidth: 820, display: "grid", gap: 12 }}>
      <select
        aria-label={tx("Filter by action", "تصفية حسب الإجراء")}
        value={action}
        onChange={(e) => {
          setAction(e.target.value);
          setMore([]);
        }}
        style={{ ...inputStyle, maxWidth: 320, marginTop: 0 }}
      >
        <option value="">{tx("All actions", "كل الإجراءات")}</option>
        {AUDIT_ACTIONS.map((a) => (
          <option key={a} value={a}>
            {auditActionLabel(a, tx)}
          </option>
        ))}
      </select>
      <div className="card">
        <div className="card-h">
          <h3>{tx("Activity log", "سجل النشاط")}</h3>
          <div className="sub">{tx(`${items.length} entries`, `${items.length} إدخال`)}</div>
        </div>
        <div style={{ paddingBlock: 8 }}>
          {first.loading && <div className="muted" style={{ padding: 16, fontSize: 13 }}>{tx("loading…", "جارٍ التحميل…")}</div>}
          {first.error && <div style={{ padding: 16, fontSize: 13, color: "var(--bad)" }}>{memberErrorText(new Error(first.error), tx)}</div>}
          {!first.loading && !first.error && items.length === 0 && (
            <div className="muted" style={{ padding: 16, fontSize: 13 }}>{tx("Nothing recorded yet.", "لا يوجد شيء مسجّل بعد.")}</div>
          )}
          {items.map((a, i) => (
            <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 12, paddingBlock: 10, paddingInline: 16, borderBottom: i < items.length - 1 ? "1px solid var(--line-soft)" : "0" }}>
              <Avatar name={a.actor?.name ?? "?"} size="sm" />
              <div style={{ flex: 1, fontSize: 13 }}>{auditLine(a, tx)}</div>
              <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                {auditTime(a.createdAt, lang, timeZone)}
              </span>
            </div>
          ))}
        </div>
      </div>
      {nextCursor && (
        <button className="btn ghost" disabled={loadingMore} onClick={() => void loadMore()}>
          {loadingMore ? tx("loading…", "جارٍ التحميل…") : tx("Load more", "تحميل المزيد")}
        </button>
      )}
    </div>
  );
}

/* ─── Team screen ────────────────────────────────────────────────────── */

function TeamImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { activeWorkspace, user } = useAuth();
  const wsId = activeWorkspace?.id ?? null;
  const { can } = usePermissions();
  const { toast } = useToast();
  // Hidden actions are not rendered (the server refuses them anyway).
  const canView = can("members.view");
  const canInvite = can("members.create");
  const canRemove = can("members.delete");
  const canHandover = can("members.update");
  const canManage = can("members.manage");

  const [tab, setTab] = useState<Tab>("members");
  const [showInvite, setShowInvite] = useState(false);
  const [dialog, setDialog] = useState<{ member: TeamApiUser; mode: "handover" | "remove" } | null>(null);

  const { data: teamData, loading, error, refetch } = useFetch<TeamApiUser[]>("/team");
  const rolesQ = useFetch<RoleRow[]>(canInvite && can("roles.view") ? "/roles" : null);
  const invites = useFetch<InvitationList>(wsId && canView ? `/workspaces/${wsId}/invitations?status=all` : null);

  const team: TeamApiUser[] = useMemo(() => teamData ?? [], [teamData]);
  const roleOptions: RoleOption[] = useMemo(
    () => (rolesQ.data ? rolesQ.data.map((r) => ({ id: r.id, name: r.name, nameAr: r.nameAr })) : roleOptionsFromTeam(team)),
    [rolesQ.data, team],
  );
  const onlineCount = team.filter((m) => m.status === "online").length;
  const twoFACount = team.filter((m) => m.twoFA).length;
  const pendingCount = invites.data ? filterCounts(invites.data.items, new Date()).pending : 0;

  const resetTwoFa = async (m: TeamApiUser) => {
    if (!wsId) return;
    if (!window.confirm(tx(`Turn off two-step verification for ${m.name}? They will be signed out everywhere and emailed.`, `إيقاف التحقق بخطوتين لـ ${m.name}؟ سيتم تسجيل خروجه من كل الأجهزة وإبلاغه بالبريد.`))) return;
    try {
      await api.post(`/workspaces/${wsId}/members/${m.id}/2fa/reset`);
      toast(tx("Two-step verification was turned off.", "تم إيقاف التحقق بخطوتين."), "success");
      refetch();
    } catch (e) {
      toast(memberErrorText(e, tx), "error");
    }
  };

  return (
    <div data-screen-label="Team" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <PageHeader
        title={tx("Team", "الفريق")}
        subtitle={tx("Members, roles, and permissions for your workspace", "أعضاء الفريق، الأدوار، والصلاحيات")}
        actions={
          <>
            {canManage && (
              <button className="btn ghost" onClick={() => setTab("activity")}>
                <IconBolt w={14} />
                {tx("Activity", "السجل")}
              </button>
            )}
            {canInvite && wsId && (
              <button className="btn primary" onClick={() => setShowInvite(true)}>
                <IconPlus w={14} />
                {tx("Invite member", "دعوة عضو")}
              </button>
            )}
          </>
        }
      />

      <div className="tabs">
        <div className={`tab ${tab === "members" ? "active" : ""}`} onClick={() => setTab("members")}>
          {tx("Members", "الأعضاء")} <span className="count">{team.length}</span>
        </div>
        {canView && (
          <div className={`tab ${tab === "pending" ? "active" : ""}`} onClick={() => setTab("pending")}>
            {tx("Invitations", "الدعوات")} <span className="count">{pendingCount}</span>
          </div>
        )}
        <div className={`tab ${tab === "roles" ? "active" : ""}`} onClick={() => setTab("roles")}>
          {tx("Roles & Permissions", "الأدوار")}
        </div>
        {canManage && (
          <div className={`tab ${tab === "activity" ? "active" : ""}`} onClick={() => setTab("activity")}>
            {tx("Activity log", "سجل النشاط")}
          </div>
        )}
      </div>

      {tab === "members" && (
        <div style={{ padding: 20, display: "grid", gap: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
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
              <div className="label">{tx("Two-step verification", "التحقق بخطوتين")}</div>
              <div className="value">
                {twoFACount}
                <span className="unit">/ {team.length}</span>
              </div>
            </div>
          </div>

          {loading && <div className="muted" style={{ paddingBlock: 10, paddingInline: 12, fontSize: 12 }}>{tx("loading…", "جارٍ التحميل…")}</div>}
          {error && !loading && (
            <div style={{ paddingBlock: 10, paddingInline: 12, borderRadius: 8, color: "var(--bad)", fontSize: 12, display: "flex", alignItems: "center", gap: 12 }}>
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
                    <th title={tx("Password sign-in only", "لتسجيل الدخول بكلمة المرور فقط")}>{tx("2-step", "خطوتان")}</th>
                    <th>{tx("Joined", "انضم")}</th>
                    <th style={{ textAlign: "end" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {team.map((m) => {
                    const self = m.id === user?.id;
                    return (
                      <tr key={m.id}>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <span style={{ position: "relative" }}>
                              <Avatar name={m.name} color={m.color} />
                              <span style={{ position: "absolute", insetInlineEnd: -1, bottom: -1, width: 9, height: 9, borderRadius: "50%", background: statusColor(m.status), border: "2px solid var(--bg-1)" }} />
                            </span>
                            <div>
                              <div style={{ fontWeight: 500 }}>{m.name}</div>
                              <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                                <bdi dir="ltr">{m.email}</bdi>
                              </div>
                            </div>
                          </div>
                        </td>
                        <td>
                          <Badge>{tx(m.roleName ?? m.role, m.roleNameAr || m.roleName || m.role)}</Badge>
                        </td>
                        <td className="mono" style={{ fontSize: 12, color: "var(--ink-2)" }}>
                          {m.status}
                        </td>
                        <td>
                          {m.twoFA ? (
                            <span style={{ color: "var(--ok)" }} title={tx("On", "مفعّل")}>
                              <IconCheckCircle w={14} />
                            </span>
                          ) : (
                            <span style={{ color: "var(--warn)" }} title={tx("Off", "غير مفعّل")}>
                              <IconAlert w={14} />
                            </span>
                          )}
                        </td>
                        <td className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                          {day(m.joinedAt, t.lang)}
                        </td>
                        <td style={{ textAlign: "end", whiteSpace: "nowrap" }}>
                          {!self && canHandover && (
                            <button className="btn sm ghost" onClick={() => setDialog({ member: m, mode: "handover" })}>
                              {tx("Hand over work", "تسليم العمل")}
                            </button>
                          )}
                          {!self && canManage && m.twoFA && (
                            <button className="btn sm ghost" onClick={() => void resetTwoFa(m)}>
                              {tx("Reset 2FA", "إعادة تعيين التحقق")}
                            </button>
                          )}
                          {!self && canRemove && (
                            <button className="btn sm danger" style={{ marginInlineStart: 6 }} onClick={() => setDialog({ member: m, mode: "remove" })}>
                              {tx("Remove member", "إزالة العضو")}
                            </button>
                          )}
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

      {tab === "pending" && wsId && canView && <PendingTab wsId={wsId} tx={tx} lang={t.lang} canCreate={canInvite} canDelete={canRemove} />}
      {tab === "roles" && <RolesTab />}
      {tab === "activity" && wsId && canManage && <ActivityTab wsId={wsId} tx={tx} lang={t.lang} timeZone={activeWorkspace?.timezone} />}

      {showInvite && wsId && (
        <InviteModal wsId={wsId} roles={roleOptions} tx={tx} lang={t.lang} onClose={() => setShowInvite(false)} onSent={() => invites.refetch()} />
      )}
      {dialog && wsId && (
        <MemberHandoverDialog
          workspaceId={wsId}
          member={{ id: dialog.member.id, name: dialog.member.name }}
          mode={dialog.mode}
          candidates={team.map((m) => ({ id: m.id, name: m.name }))}
          tx={tx}
          dir={t.lang === "ar" ? "rtl" : "ltr"}
          onClose={() => setDialog(null)}
          onDone={() => {
            const { member, mode } = dialog;
            setDialog(null);
            refetch();
            toast(mode === "remove" ? tx(`Removed ${member.name}.`, `تمت إزالة ${member.name}.`) : tx("Work handed over.", "تم تسليم العمل."), "success");
          }}
        />
      )}
    </div>
  );
}

const Team = memo(TeamImpl);
export default Team;
