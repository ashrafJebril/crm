import { useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { useAuth } from "@/auth/context";
import { usePermissions, NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";
import type { RoleRow } from "./RolesTab";
import { roleErrorMessage } from "./RolesTab";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import { Avatar } from "@/components/Avatar";
import { Badge } from "@/components/Badge";
import type { WorkspaceRole } from "@/lib/types";
import { arabicServerMessage, roleOptionsFromTeam, type RoleOption } from "@/lib/roleErrors";
import { ErrorRow, Field, SettingsCard, StatusToast, inputStyle } from "./form";

interface Member {
  id: string;
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
  roleId?: string | null;
  createdAt: string;
  user: {
    id: string;
    email: string;
    name: string;
    initials: string;
    color: string;
    status: string;
  };
}

interface TeamRow {
  id: string;
  roleId?: string | null;
  roleName?: string;
  roleNameAr?: string;
}

const ROLES: WorkspaceRole[] = ["owner", "admin", "agent", "viewer"];

export function MembersTab() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { activeWorkspace, user } = useAuth();

  const wsId = activeWorkspace?.id;
  const { can } = usePermissions();
  const canAdd = can("members.create");
  const canEdit = can("members.update");
  const canRemove = can("members.delete");
  const noPerm = tx(NO_PERMISSION_EN, NO_PERMISSION_AR);
  // /roles needs roles.view; a members.update holder may lack it. Try /roles
  // for either permission and, if the server refuses (403), fall back to the
  // distinct roles currently in use, read from /team (ungated, resolved
  // roleId + roleName/roleNameAr per member).
  const rolesQ = useFetch<RoleRow[]>(can("roles.view") || canEdit ? "/roles" : null);
  const teamQ = useFetch<TeamRow[]>(wsId ? "/team" : null);
  const teamRows = teamQ.data ?? [];
  const roleOptions: RoleOption[] = rolesQ.data ?? roleOptionsFromTeam(teamRows);
  const loc = (m: string | null | undefined): string | null => {
    if (!m) return null;
    const ar = arabicServerMessage(m);
    return ar ? tx(m, ar) : m;
  };
  const teamByUser = new Map(teamRows.map((r) => [r.id, r]));
  const [roleError, setRoleError] = useState<string | null>(null);

  const listQ = useFetch<Member[]>(wsId ? `/workspaces/${wsId}/members` : null);

  interface InviteResponse {
    member: Member;
    created: boolean;
    tempPassword?: string;
    user: { id: string; email: string; name: string };
  }
  const inviteMut = useMutation<
    { email: string; role: WorkspaceRole; name?: string; password?: string },
    InviteResponse
  >((input) => api.post<InviteResponse>(`/workspaces/${wsId}/invite`, input));

  const updateRoleMut = useMutation<
    { userId: string; roleId: string },
    Member
  >((input) =>
    api.patch<Member>(`/workspaces/${wsId}/members/${input.userId}`, {
      roleId: input.roleId,
    }),
  );

  const removeMut = useMutation<{ userId: string }, { ok: true }>((input) =>
    api.delete<{ ok: true }>(`/workspaces/${wsId}/members/${input.userId}`),
  );

  interface ResetPwdResponse {
    ok: true;
    user: { id: string; email: string; name: string };
    password: string;
  }
  const resetPwdMut = useMutation<
    { userId: string; password: string },
    ResetPwdResponse
  >((input) =>
    api.patch<ResetPwdResponse>(
      `/workspaces/${wsId}/members/${input.userId}/password`,
      { password: input.password },
    ),
  );

  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>("agent");
  const [inviteName, setInviteName] = useState("");
  const [invitePassword, setInvitePassword] = useState(() => friendlyPassword());
  const [status, setStatus] = useState<string | null>(null);
  const [provisioned, setProvisioned] = useState<{
    email: string;
    name: string;
    password: string;
  } | null>(null);

  const showStatus = (msg: string) => {
    setStatus(msg);
    window.setTimeout(() => setStatus(null), 2400);
  };

  const onInvite = async () => {
    const e = email.trim().toLowerCase();
    if (!e) return;
    try {
      const resp = await inviteMut.mutate({
        email: e,
        role: inviteRole,
        name: inviteName.trim() || undefined,
        password: invitePassword.trim() || undefined,
      });
      listQ.refetch();
      if (resp.created && resp.tempPassword) {
        setProvisioned({
          email: resp.user.email,
          name: resp.user.name,
          password: resp.tempPassword,
        });
      } else {
        showStatus(tx(`Added ${e} to this workspace.`, `تمت إضافة ${e}.`));
      }
      setEmail("");
      setInviteName("");
      setInvitePassword(friendlyPassword());
    } catch {
      /* error stays in inviteMut.error */
    }
  };

  const onChangeRole = async (member: Member, roleId: string) => {
    if (roleId === (teamByUser.get(member.userId)?.roleId ?? member.roleId)) return;
    setRoleError(null);
    try {
      await updateRoleMut.mutate({ userId: member.userId, roleId });
      showStatus(tx(`Updated ${member.user.name}'s role.`, `تم تحديث الدور.`));
    } catch (e) {
      // e.g. last owner, "Cannot grant permissions you don't have"
      setRoleError(roleErrorMessage(e, tx));
    }
    listQ.refetch();
    teamQ.refetch();
  };

  const onResetPwd = async (member: Member) => {
    const next = friendlyPassword();
    try {
      const resp = await resetPwdMut.mutate({
        userId: member.userId,
        password: next,
      });
      setProvisioned({
        email: resp.user.email,
        name: resp.user.name,
        password: resp.password,
      });
    } catch {
      /* error stays in resetPwdMut.error */
    }
  };

  const onRemove = async (member: Member) => {
    if (
      !window.confirm(
        tx(
          `Remove ${member.user.name} from this workspace?`,
          `إزالة ${member.user.name} من هذه المساحة؟`,
        ),
      )
    ) {
      return;
    }
    await removeMut.mutate({ userId: member.userId });
    listQ.refetch();
    showStatus(tx(`Removed ${member.user.name}.`, `تمت الإزالة.`));
  };

  if (!activeWorkspace) {
    return (
      <div className="muted" style={{ fontSize: 13 }}>
        {tx("No active workspace.", "لا توجد مساحة عمل نشطة.")}
      </div>
    );
  }

  const members = listQ.data ?? [];

  return (
    <>
      {canAdd && (
        <SettingsCard
          title={tx("Add team member", "إضافة عضو")}
          description={tx(
            "Creates a new account and adds them to this workspace. Share the email + password with your teammate so they can log in.",
            "ينشئ حساباً جديداً ويضيفه إلى هذه المساحة. شارك البريد وكلمة المرور مع العضو ليتمكن من الدخول.",
          )}
          footer={
            <button
              type="button"
              className="btn primary"
              onClick={onInvite}
              disabled={
                inviteMut.loading ||
                email.trim().length === 0 ||
                inviteName.trim().length < 2 ||
                invitePassword.trim().length < 6
              }
            >
              {inviteMut.loading
                ? tx("Creating…", "جارٍ الإنشاء…")
                : tx("Create & add", "إنشاء وإضافة")}
            </button>
          }
        >
          <Field label={tx("Full name", "الاسم الكامل")}>
            <input
              type="text"
              value={inviteName}
              onChange={(e) => setInviteName(e.target.value)}
              placeholder="Yazan Barjawi"
              style={inputStyle}
            />
          </Field>
          <Field label={tx("Email", "البريد الإلكتروني")}>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="yazan@example.com"
              style={inputStyle}
              onKeyDown={(e) => {
                if (e.key === "Enter") void onInvite();
              }}
            />
          </Field>
          <Field
            label={tx("Password", "كلمة المرور")}
            hint={tx(
              "Auto-generated. The teammate can change it from Settings → Profile after logging in.",
              "تم توليدها تلقائياً. يمكن للعضو تغييرها من الإعدادات بعد الدخول.",
            )}
          >
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="text"
                value={invitePassword}
                onChange={(e) => setInvitePassword(e.target.value)}
                style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
              />
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => setInvitePassword(friendlyPassword())}
                title={tx("Regenerate", "توليد جديد")}
              >
                🎲
              </button>
            </div>
          </Field>
          <Field label={tx("Role", "الدور")}>
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as WorkspaceRole)}
              style={inputStyle}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
          <ErrorRow message={loc(inviteMut.error)} />
        </SettingsCard>
      )}

      {provisioned && (
        <ProvisionedCredentialsModal
          tx={tx}
          credentials={provisioned}
          onClose={() => setProvisioned(null)}
        />
      )}

      <SettingsCard
        title={`${tx("Members", "الأعضاء")} (${members.length})`}
        description={tx(
          "Everyone who has access to this workspace.",
          "كل من له صلاحية الوصول إلى هذه المساحة.",
        )}
      >
        {listQ.loading && members.length === 0 ? (
          <div className="mono muted pulse" style={{ fontSize: 12 }}>
            {tx("loading members…", "جارٍ التحميل…")}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {members.map((m) => {
              const isMe = m.userId === user?.id;
              const teamRow = teamByUser.get(m.userId);
              const resolvedRoleId = teamRow?.roleId ?? "";
              return (
                <div
                  key={m.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "10px 12px",
                    background: "var(--bg-2)",
                    borderRadius: 10,
                  }}
                >
                  <Avatar name={m.user.name} color={m.user.color} size="lg" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>
                      {m.user.name}
                      {isMe && (
                        <Badge kind="accent">{tx("you", "أنت")}</Badge>
                      )}
                    </div>
                    <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                      {m.user.email}
                    </div>
                  </div>
                  {canEdit && !isMe ? (
                    <select
                      dir="auto"
                      value={resolvedRoleId}
                      onChange={(e) => onChangeRole(m, e.target.value)}
                      disabled={updateRoleMut.loading || roleOptions.length === 0 || !resolvedRoleId}
                      aria-label={tx("Role", "الدور")}
                      style={{ ...inputStyle, width: 160, height: 30 }}
                    >
                      {!roleOptions.some((r) => r.id === resolvedRoleId) && (
                        <option value="">
                          {t.lang === "ar" ? teamRow?.roleNameAr || m.role : teamRow?.roleName || m.role}
                        </option>
                      )}
                      {roleOptions.map((r) => (
                        <option key={r.id} value={r.id}>
                          {t.lang === "ar" ? r.nameAr || r.name : r.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Badge kind="accent">
                      <span dir="auto">
                        {t.lang === "ar"
                          ? teamRow?.roleNameAr || teamRow?.roleName || m.role
                          : teamRow?.roleName || m.role}
                      </span>
                    </Badge>
                  )}
                  {!isMe && (
                    <>
                      <button
                        type="button"
                        className="btn ghost sm"
                        onClick={() => onResetPwd(m)}
                        disabled={resetPwdMut.loading || !canEdit}
                        title={
                          canEdit
                            ? tx(
                                "Generate a new password for this member",
                                "إنشاء كلمة مرور جديدة لهذا العضو",
                              )
                            : noPerm
                        }
                      >
                        {tx("Reset password", "إعادة تعيين كلمة المرور")}
                      </button>
                      <button
                        type="button"
                        className="btn ghost sm"
                        onClick={() => onRemove(m)}
                        disabled={removeMut.loading || !canRemove}
                        title={canRemove ? undefined : noPerm}
                        style={{ color: "var(--bad)" }}
                      >
                        {tx("Remove", "حذف")}
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <ErrorRow
          message={
            loc(listQ.error) ?? roleError ?? loc(removeMut.error) ?? loc(resetPwdMut.error)
          }
        />
      </SettingsCard>

      <StatusToast message={status} />
    </>
  );
}

/* ─── Provisioned credentials modal ──────────────────────────────────── */

interface ProvisionedCredentialsModalProps {
  tx: (en: string, ar: string) => string;
  credentials: { email: string; name: string; password: string };
  onClose: () => void;
}

function ProvisionedCredentialsModal({
  tx,
  credentials,
  onClose,
}: ProvisionedCredentialsModalProps) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "grid",
        placeItems: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--line)",
          borderRadius: 12,
          padding: 24,
          width: 460,
          maxWidth: "90vw",
        }}
      >
        <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
          ✅ {tx("Account created — share these credentials", "تم إنشاء الحساب — شارك البيانات")}
        </h3>
        <p className="muted" style={{ fontSize: 12, marginBottom: 14 }}>
          {tx(
            "Won't be shown again. The teammate can change the password later from Settings → Profile.",
            "لن تظهر مرة أخرى. يمكن للعضو تغيير كلمة المرور لاحقاً من الإعدادات.",
          )}
        </p>
        <div
          style={{
            background: "var(--bg-2)",
            border: "1px solid var(--line)",
            borderRadius: 8,
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            fontFamily: "var(--font-mono)",
            fontSize: 13,
          }}
        >
          <CopyRow label={tx("Login URL", "رابط الدخول")} value={window.location.origin} />
          <CopyRow label={tx("Name", "الاسم")} value={credentials.name} />
          <CopyRow label="Email" value={credentials.email} />
          <CopyRow label={tx("Password", "كلمة المرور")} value={credentials.password} />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
          <button type="button" className="btn primary" onClick={onClose}>
            {tx("Done", "تم")}
          </button>
        </div>
      </div>
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ width: 110, color: "var(--ink-3)", fontSize: 11 }}>{label}</span>
      <span style={{ flex: 1, wordBreak: "break-all" }}>{value}</span>
      <button
        type="button"
        className="btn ghost sm"
        onClick={onCopy}
        style={{ fontSize: 11 }}
      >
        {copied ? "✓" : "Copy"}
      </button>
    </div>
  );
}

function friendlyPassword(): string {
  const adjectives = ["sunny", "swift", "calm", "lively", "bright", "noble", "brave", "happy"];
  const nouns = ["fox", "wave", "moon", "rose", "tiger", "river", "star", "leaf"];
  const a = adjectives[Math.floor(Math.random() * adjectives.length)];
  const n = nouns[Math.floor(Math.random() * nouns.length)];
  const digits = Math.floor(1000 + Math.random() * 9000);
  return `${a}-${n}-${digits}`;
}
