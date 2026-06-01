import { useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { useAuth } from "@/auth/context";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import { Avatar } from "@/components/Avatar";
import { Badge } from "@/components/Badge";
import type { WorkspaceRole } from "@/lib/types";
import { ErrorRow, Field, SettingsCard, StatusToast, inputStyle } from "./form";

interface Member {
  id: string;
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
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

const ROLES: WorkspaceRole[] = ["owner", "admin", "agent", "viewer"];

export function MembersTab() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { activeWorkspace, user } = useAuth();

  const wsId = activeWorkspace?.id;
  const canEdit = activeWorkspace?.role === "owner" || activeWorkspace?.role === "admin";

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
    { userId: string; role: WorkspaceRole },
    Member
  >((input) =>
    api.patch<Member>(`/workspaces/${wsId}/members/${input.userId}`, {
      role: input.role,
    }),
  );

  const removeMut = useMutation<{ userId: string }, { ok: true }>((input) =>
    api.delete<{ ok: true }>(`/workspaces/${wsId}/members/${input.userId}`),
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

  const onChangeRole = async (member: Member, role: WorkspaceRole) => {
    if (role === member.role) return;
    await updateRoleMut.mutate({ userId: member.userId, role });
    listQ.refetch();
    showStatus(tx(`Updated ${member.user.name}'s role.`, `تم تحديث الدور.`));
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
      {canEdit && (
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
          <ErrorRow message={inviteMut.error} />
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
                        <Badge kind="ai">{tx("you", "أنت")}</Badge>
                      )}
                    </div>
                    <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                      {m.user.email}
                    </div>
                  </div>
                  {canEdit && !isMe ? (
                    <select
                      value={m.role}
                      onChange={(e) => onChangeRole(m, e.target.value as WorkspaceRole)}
                      disabled={updateRoleMut.loading}
                      style={{ ...inputStyle, width: 120, height: 30 }}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Badge kind="ai">{m.role}</Badge>
                  )}
                  {canEdit && !isMe && (
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => onRemove(m)}
                      disabled={removeMut.loading}
                      style={{ color: "var(--bad)" }}
                    >
                      {tx("Remove", "حذف")}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <ErrorRow message={listQ.error ?? updateRoleMut.error ?? removeMut.error} />
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
