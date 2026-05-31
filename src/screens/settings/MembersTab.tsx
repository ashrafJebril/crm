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

  const inviteMut = useMutation<
    { email: string; role: WorkspaceRole },
    Member
  >((input) => api.post<Member>(`/workspaces/${wsId}/invite`, input));

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
  const [status, setStatus] = useState<string | null>(null);

  const showStatus = (msg: string) => {
    setStatus(msg);
    window.setTimeout(() => setStatus(null), 2400);
  };

  const onInvite = async () => {
    const e = email.trim().toLowerCase();
    if (!e) return;
    try {
      await inviteMut.mutate({ email: e, role: inviteRole });
      setEmail("");
      listQ.refetch();
      showStatus(tx(`Added ${e} to this workspace.`, `تمت إضافة ${e}.`));
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
          title={tx("Invite a member", "دعوة عضو")}
          description={tx(
            "Add someone by their Aram email. They must already have an account — invite-by-signup email comes later.",
            "أضف عضواً عبر بريده الإلكتروني. يجب أن يكون لديه حساب على آرام مسبقاً.",
          )}
          footer={
            <button
              type="button"
              className="btn primary"
              onClick={onInvite}
              disabled={inviteMut.loading || email.trim().length === 0}
            >
              {inviteMut.loading ? tx("Adding…", "جارٍ الإضافة…") : tx("Add member", "إضافة")}
            </button>
          }
        >
          <Field label={tx("Email", "البريد الإلكتروني")}>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@company.com"
              style={inputStyle}
              onKeyDown={(e) => {
                if (e.key === "Enter") void onInvite();
              }}
            />
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
