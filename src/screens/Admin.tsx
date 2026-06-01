import type { CSSProperties } from "react";
import { memo, useEffect, useMemo, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { useAuth } from "@/auth/context";
import { makeTx } from "@/lib/tx";
import { useFetch, useMutation } from "@/api/useFetch";
import { api, tokenStore } from "@/api/client";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/Badge";
import { Avatar } from "@/components/Avatar";
import { IconBolt, IconCheck, IconChev, IconX, IconHand } from "@/icons";
import type {
  AdminUserRow,
  AdminWorkspaceDetail,
  AdminWorkspaceRow,
} from "@/lib/types";

type Tab = "workspaces" | "users";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function planBadgeKind(plan: string): "ok" | "info" | "warn" | "ai" | "" {
  if (plan === "pro") return "ok";
  if (plan === "growth") return "info";
  if (plan === "starter") return "ai";
  return "";
}

function AdminImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { user, workspaces: myWorkspaces } = useAuth();

  const [tab, setTab] = useState<Tab>("workspaces");
  const [selectedWsId, setSelectedWsId] = useState<string | null>(null);
  const [refetchTick, setRefetchTick] = useState(0);
  const [provisionOpen, setProvisionOpen] = useState(false);

  // Refetch the admin lists whenever the user's workspace list grows/shrinks
  // (e.g., right after creating a new workspace via the topbar switcher) or
  // when the page becomes visible again. Avoids "refresh required" UX.
  const wssQ = useFetch<AdminWorkspaceRow[]>(
    tab === "workspaces" || selectedWsId ? "/admin/workspaces" : null,
    { key: `wss:${refetchTick}:${myWorkspaces.length}` },
  );
  const usersQ = useFetch<AdminUserRow[]>(
    tab === "users" ? "/admin/users" : null,
    { key: `users:${refetchTick}:${myWorkspaces.length}` },
  );

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") setRefetchTick((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  if (!user?.isSuperAdmin) {
    return (
      <div style={{ display: "grid", placeItems: "center", flex: 1, padding: 24 }}>
        <div style={{ color: "var(--bad)", fontSize: 14 }}>
          {tx("Super-admin access required.", "تحتاج صلاحية مشرف عام.")}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <PageHeader
        title={tx("Aram admin portal", "بوابة إدارة آرام")}
        subtitle={tx(
          "All customer workspaces and users across Aram.",
          "كل مساحات العمل والمستخدمين على آرام.",
        )}
      />

      <div
        className="tabs"
        style={{
          padding: "0 24px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", gap: 0 }}>
          {(["workspaces", "users"] as Tab[]).map((id) => (
            <button
              key={id}
              type="button"
              className={`tab ${tab === id ? "active" : ""}`.trim()}
              onClick={() => setTab(id)}
            >
              <span>
                {id === "workspaces"
                  ? tx("Workspaces", "مساحات العمل")
                  : tx("Users", "المستخدمون")}
              </span>
              <span className="count">
                {id === "workspaces"
                  ? wssQ.data?.length ?? "·"
                  : usersQ.data?.length ?? "·"}
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn primary sm"
          onClick={() => setProvisionOpen(true)}
        >
          <IconCheck w={12} />
          {tx("Create client", "إنشاء عميل")}
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
        {tab === "workspaces" ? (
          <WorkspacesTable
            tx={tx}
            rows={wssQ.data ?? []}
            loading={wssQ.loading}
            error={wssQ.error}
            onSelect={setSelectedWsId}
          />
        ) : (
          <UsersTable
            tx={tx}
            rows={usersQ.data ?? []}
            loading={usersQ.loading}
            error={usersQ.error}
          />
        )}
      </div>

      {selectedWsId && (
        <WorkspaceDetailPanel
          tx={tx}
          workspaceId={selectedWsId}
          onClose={() => setSelectedWsId(null)}
          onChanged={() => setRefetchTick((n) => n + 1)}
        />
      )}

      {provisionOpen && (
        <ProvisionClientModal
          tx={tx}
          onClose={() => setProvisionOpen(false)}
          onCreated={() => {
            setRefetchTick((n) => n + 1);
            setProvisionOpen(false);
          }}
        />
      )}
    </div>
  );
}

/* ─── Provision client modal ────────────────────────────────────────── */

interface ProvisionClientModalProps {
  tx: (en: string, ar: string) => string;
  onClose: () => void;
  onCreated: () => void;
}

function ProvisionClientModal({ tx, onClose, onCreated }: ProvisionClientModalProps) {
  const [workspaceName, setWorkspaceName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerPassword, setOwnerPassword] = useState(() => randomPassword());
  const [createdSummary, setCreatedSummary] = useState<{
    workspace: { id: string; name: string; slug: string };
    user: { id: string; email: string; name: string };
    password: string;
  } | null>(null);

  const provisionMut = useMutation<
    {
      workspaceName: string;
      ownerName: string;
      ownerEmail: string;
      ownerPassword: string;
    },
    {
      workspace: { id: string; name: string; slug: string };
      user: { id: string; email: string; name: string };
    }
  >((input) => api.post("/admin/provision", input));

  const canSubmit =
    workspaceName.trim().length >= 2 &&
    ownerName.trim().length >= 2 &&
    /\S+@\S+\.\S+/.test(ownerEmail) &&
    ownerPassword.length >= 6 &&
    !provisionMut.loading;

  const onSubmit = async () => {
    if (!canSubmit) return;
    try {
      const res = await provisionMut.mutate({
        workspaceName: workspaceName.trim(),
        ownerName: ownerName.trim(),
        ownerEmail: ownerEmail.trim().toLowerCase(),
        ownerPassword,
      });
      setCreatedSummary({ ...res, password: ownerPassword });
    } catch {
      // error is held in provisionMut.error
    }
  };

  const close = () => {
    if (createdSummary) onCreated();
    else onClose();
  };

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
      onClick={close}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--line)",
          borderRadius: 12,
          padding: 24,
          width: 480,
          maxWidth: "90vw",
        }}
      >
        {!createdSummary ? (
          <>
            <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>
              {tx("Create client workspace", "إنشاء عميل")}
            </h2>
            <p
              className="muted"
              style={{ fontSize: 12, marginBottom: 16 }}
            >
              {tx(
                "Sets up a new workspace + owner user + password in one step. Share the credentials with the client.",
                "ينشئ مساحة عمل جديدة + مالكاً + كلمة مرور في خطوة واحدة. شارك البيانات مع العميل.",
              )}
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
                  {tx("Workspace name", "اسم مساحة العمل")}
                </span>
                <input
                  type="text"
                  value={workspaceName}
                  onChange={(e) => setWorkspaceName(e.target.value)}
                  placeholder="Yazan Stores"
                  style={inputBox}
                  autoFocus
                />
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
                  {tx("Owner name", "اسم المالك")}
                </span>
                <input
                  type="text"
                  value={ownerName}
                  onChange={(e) => setOwnerName(e.target.value)}
                  placeholder="Yazan Barjawi"
                  style={inputBox}
                />
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
                  {tx("Owner email", "البريد الإلكتروني")}
                </span>
                <input
                  type="email"
                  value={ownerEmail}
                  onChange={(e) => setOwnerEmail(e.target.value)}
                  placeholder="yazan@example.com"
                  style={inputBox}
                />
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
                  {tx("Temporary password", "كلمة المرور المؤقتة")}
                </span>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    type="text"
                    value={ownerPassword}
                    onChange={(e) => setOwnerPassword(e.target.value)}
                    style={{ ...inputBox, fontFamily: "var(--font-mono)" }}
                  />
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => setOwnerPassword(randomPassword())}
                    title={tx("Generate new", "توليد جديد")}
                  >
                    🎲
                  </button>
                </div>
              </label>

              {provisionMut.error && (
                <div style={{ color: "var(--bad)", fontSize: 12 }}>
                  {provisionMut.error}
                </div>
              )}

              <div
                style={{
                  display: "flex",
                  gap: 8,
                  justifyContent: "flex-end",
                  marginTop: 8,
                }}
              >
                <button type="button" className="btn ghost" onClick={onClose}>
                  {tx("Cancel", "إلغاء")}
                </button>
                <button
                  type="button"
                  className="btn primary"
                  onClick={onSubmit}
                  disabled={!canSubmit}
                >
                  {provisionMut.loading
                    ? tx("Creating…", "جارٍ الإنشاء…")
                    : tx("Create client", "إنشاء")}
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>
              ✅ {tx("Client created", "تم إنشاء العميل")}
            </h2>
            <p className="muted" style={{ fontSize: 12, marginBottom: 16 }}>
              {tx(
                "Share these credentials with the client. They can change the password from Settings → Profile.",
                "شارك هذه البيانات مع العميل. يمكنه تغيير كلمة المرور من الإعدادات.",
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
              <CopyRow
                label={tx("Workspace", "مساحة العمل")}
                value={createdSummary.workspace.name}
              />
              <CopyRow
                label={tx("Login URL", "رابط الدخول")}
                value={window.location.origin}
              />
              <CopyRow label="Email" value={createdSummary.user.email} />
              <CopyRow
                label={tx("Password", "كلمة المرور")}
                value={createdSummary.password}
              />
            </div>

            <div
              style={{
                display: "flex",
                gap: 8,
                justifyContent: "flex-end",
                marginTop: 16,
              }}
            >
              <button type="button" className="btn primary" onClick={close}>
                {tx("Done", "تم")}
              </button>
            </div>
          </>
        )}
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
      <span style={{ width: 110, color: "var(--ink-3)", fontSize: 11 }}>
        {label}
      </span>
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

function randomPassword(): string {
  // Friendly random password: short word + 4 digits, easy to type once.
  const adjectives = ["sunny", "swift", "calm", "lively", "bright", "noble", "brave", "happy"];
  const nouns = ["fox", "wave", "moon", "rose", "tiger", "river", "star", "leaf"];
  const a = adjectives[Math.floor(Math.random() * adjectives.length)];
  const n = nouns[Math.floor(Math.random() * nouns.length)];
  const digits = Math.floor(1000 + Math.random() * 9000);
  return `${a}-${n}-${digits}`;
}

const inputBox: CSSProperties = {
  height: 36,
  padding: "0 10px",
  background: "var(--bg-2)",
  border: "1px solid var(--line)",
  borderRadius: 8,
  color: "var(--ink-1)",
  fontSize: 13,
  fontFamily: "inherit",
  outline: "none",
};

/* ─── Workspaces table ──────────────────────────────────────────────── */

interface WorkspacesTableProps {
  tx: (en: string, ar: string) => string;
  rows: AdminWorkspaceRow[];
  loading: boolean;
  error: string | null;
  onSelect: (id: string) => void;
}

function WorkspacesTable({ tx, rows, loading, error, onSelect }: WorkspacesTableProps) {
  if (error) {
    return (
      <div style={{ color: "var(--bad)", fontSize: 13 }}>
        {error}
      </div>
    );
  }
  if (loading && rows.length === 0) {
    return (
      <div className="mono muted pulse" style={{ fontSize: 12, padding: 16 }}>
        {tx("loading workspaces…", "جارٍ التحميل…")}
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="mono muted" style={{ fontSize: 12, padding: 16 }}>
        {tx("No workspaces yet.", "لا توجد مساحات بعد.")}
      </div>
    );
  }
  return (
    <table
      className="adm-table"
      style={{
        width: "100%",
        borderCollapse: "collapse",
        fontSize: 13,
      }}
    >
      <thead>
        <tr style={{ textAlign: "start", color: "var(--ink-3)" }}>
          <Th>{tx("Workspace", "مساحة العمل")}</Th>
          <Th>{tx("Plan", "الخطة")}</Th>
          <Th>{tx("Owner", "المالك")}</Th>
          <Th>{tx("Members", "الأعضاء")}</Th>
          <Th>{tx("Contacts", "جهات")}</Th>
          <Th>{tx("Convos", "محادثات")}</Th>
          <Th>{tx("Mentions", "إشارات")}</Th>
          <Th>{tx("Status", "الحالة")}</Th>
          <Th>{tx("Created", "أُنشئت")}</Th>
          <Th />
        </tr>
      </thead>
      <tbody>
        {rows.map((w) => (
          <tr
            key={w.id}
            style={{
              borderTop: "1px solid var(--line-soft)",
              cursor: "pointer",
            }}
            onClick={() => onSelect(w.id)}
            className="adm-row"
          >
            <Td>
              <div style={{ fontWeight: 500 }}>{w.name}</div>
              <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
                {w.slug}
              </div>
            </Td>
            <Td>
              <Badge kind={planBadgeKind(w.plan)}>{w.plan}</Badge>
            </Td>
            <Td>
              {w.owner ? (
                <>
                  <div>{w.owner.name}</div>
                  <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
                    {w.owner.email}
                  </div>
                </>
              ) : (
                <span className="muted">—</span>
              )}
            </Td>
            <Td>{w.counts.members}</Td>
            <Td>{w.counts.contacts}</Td>
            <Td>{w.counts.conversations}</Td>
            <Td>{w.counts.mentions}</Td>
            <Td>
              {w.suspendedAt ? (
                <Badge kind="bad">{tx("Suspended", "موقوفة")}</Badge>
              ) : (
                <Badge kind="ok" dot>
                  {tx("Active", "نشطة")}
                </Badge>
              )}
            </Td>
            <Td>
              <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                {fmtDate(w.createdAt)}
              </span>
            </Td>
            <Td>
              <IconChev w={11} />
            </Td>
          </tr>
        ))}
      </tbody>
      <style>{`.adm-row:hover { background: var(--bg-1); }`}</style>
    </table>
  );
}

/* ─── Users table ──────────────────────────────────────────────────── */

interface UsersTableProps {
  tx: (en: string, ar: string) => string;
  rows: AdminUserRow[];
  loading: boolean;
  error: string | null;
}

function UsersTable({ tx, rows, loading, error }: UsersTableProps) {
  if (error) {
    return <div style={{ color: "var(--bad)", fontSize: 13 }}>{error}</div>;
  }
  if (loading && rows.length === 0) {
    return (
      <div className="mono muted pulse" style={{ fontSize: 12, padding: 16 }}>
        {tx("loading users…", "جارٍ التحميل…")}
      </div>
    );
  }
  return (
    <table
      style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}
    >
      <thead>
        <tr style={{ textAlign: "start", color: "var(--ink-3)" }}>
          <Th>{tx("User", "المستخدم")}</Th>
          <Th>{tx("Email", "البريد")}</Th>
          <Th>{tx("System role", "الدور")}</Th>
          <Th>{tx("Workspaces", "المساحات")}</Th>
          <Th>{tx("Super-admin", "مشرف")}</Th>
          <Th>{tx("Joined", "تاريخ الانضمام")}</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((u) => (
          <tr key={u.id} style={{ borderTop: "1px solid var(--line-soft)" }}>
            <Td>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Avatar name={u.name} color={u.color} size="sm" />
                <span style={{ fontWeight: 500 }}>{u.name}</span>
              </div>
            </Td>
            <Td>
              <span className="mono" style={{ fontSize: 11 }}>{u.email}</span>
            </Td>
            <Td>{u.role}</Td>
            <Td>{u.workspaceCount}</Td>
            <Td>
              {u.isSuperAdmin ? (
                <span style={{ color: "var(--accent)", display: "inline-flex", gap: 4, alignItems: "center" }}>
                  <IconBolt w={11} /> {tx("Yes", "نعم")}
                </span>
              ) : (
                <span className="muted">—</span>
              )}
            </Td>
            <Td>
              <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                {fmtDate(u.createdAt)}
              </span>
            </Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ─── Workspace detail slide-over ─────────────────────────────────── */

interface WorkspaceDetailPanelProps {
  tx: (en: string, ar: string) => string;
  workspaceId: string;
  onClose: () => void;
  onChanged: () => void;
}

function WorkspaceDetailPanel({
  tx,
  workspaceId,
  onClose,
  onChanged,
}: WorkspaceDetailPanelProps) {
  const wsQ = useFetch<AdminWorkspaceDetail>(`/admin/workspaces/${workspaceId}`);

  const suspendMut = useMutation<
    { suspended: boolean },
    AdminWorkspaceDetail
  >((input) =>
    api.post<AdminWorkspaceDetail>(
      `/admin/workspaces/${workspaceId}/suspend`,
      input,
    ),
  );

  const planMut = useMutation<{ plan: string }, AdminWorkspaceDetail>((input) =>
    api.patch<AdminWorkspaceDetail>(`/admin/workspaces/${workspaceId}`, input),
  );

  const impersonateMut = useMutation<
    Record<string, never>,
    { token: string; expiresInSec: number; workspaceId: string }
  >(() =>
    api.post<{ token: string; expiresInSec: number; workspaceId: string }>(
      `/admin/workspaces/${workspaceId}/impersonate`,
      {},
    ),
  );

  const ws = wsQ.data;
  const isSuspended = !!ws?.suspendedAt;

  const onSuspendToggle = async () => {
    if (!ws) return;
    if (
      !window.confirm(
        isSuspended
          ? tx(
              "Reactivate this workspace?",
              "إعادة تفعيل مساحة العمل هذه؟",
            )
          : tx(
              "Suspend this workspace? Members will be blocked from API access (enforcement is a follow-up; for now this is a marker).",
              "إيقاف هذه المساحة؟ سيتم تعليم الإيقاف فقط حالياً.",
            ),
      )
    ) {
      return;
    }
    await suspendMut.mutate({ suspended: !isSuspended });
    wsQ.refetch();
    onChanged();
  };

  const onChangePlan = async (plan: string) => {
    if (!ws) return;
    await planMut.mutate({ plan });
    wsQ.refetch();
    onChanged();
  };

  const onImpersonate = async () => {
    if (!ws) return;
    if (
      !window.confirm(
        tx(
          `Enter ${ws.name} as an impersonation session? You'll be logged out of your admin account. Sign back in as yourself to exit.`,
          `الدخول إلى ${ws.name} كجلسة انتحال؟ ستخرج من حساب الإدارة. سجّل دخولك مرة أخرى كنفسك للخروج.`,
        ),
      )
    ) {
      return;
    }
    const res = await impersonateMut.mutate({});
    tokenStore.set(res.token);
    // Hard reload so the entire app re-bootstraps under the impersonation JWT.
    window.location.hash = "#/dashboard";
    window.location.reload();
  };

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "var(--scrim, rgba(0,0,0,0.45))",
          zIndex: 40,
        }}
      />
      <aside
        style={{
          position: "fixed",
          top: 56,
          bottom: 0,
          insetInlineEnd: 0,
          width: 480,
          maxWidth: "100vw",
          background: "var(--bg-1)",
          borderInlineStart: "1px solid var(--line-soft)",
          boxShadow: "var(--shadow-lg)",
          zIndex: 41,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "14px 16px",
            borderBottom: "1px solid var(--line-soft)",
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.06 }}>
              {tx("workspace", "مساحة عمل")}
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, marginTop: 2 }}>
              {ws?.name ?? "…"}
            </div>
          </div>
          <button className="btn ghost icon sm" onClick={onClose} aria-label="Close">
            <IconX w={14} />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 18 }}>
          {!ws && (
            <div className="mono muted pulse" style={{ fontSize: 12 }}>
              {tx("loading…", "جارٍ التحميل…")}
            </div>
          )}
          {ws && (
            <>
              {/* Meta */}
              <Section label={tx("Overview", "نظرة عامة")}>
                <KV k={tx("Slug", "الاسم المختصر")} v={ws.slug} mono />
                <KV k={tx("Plan", "الخطة")} v={ws.plan} />
                <KV k={tx("Language", "اللغة")} v={ws.lang} />
                <KV k={tx("Timezone", "المنطقة الزمنية")} v={ws.timezone} />
                <KV
                  k={tx("Status", "الحالة")}
                  v={
                    isSuspended
                      ? `${tx("Suspended since", "موقوفة منذ")} ${fmtDate(ws.suspendedAt)}`
                      : tx("Active", "نشطة")
                  }
                />
                <KV k={tx("Created", "أُنشئت")} v={fmtDate(ws.createdAt)} />
              </Section>

              {/* Stats */}
              <Section label={tx("Usage", "الاستخدام")}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 8,
                  }}
                >
                  <Stat label={tx("Contacts", "جهات")} value={ws._count.contacts} />
                  <Stat label={tx("Conversations", "محادثات")} value={ws._count.conversations} />
                  <Stat label={tx("Messages", "رسائل")} value={ws._count.messages} />
                  <Stat label={tx("Mentions", "إشارات")} value={ws._count.mentions} />
                  <Stat label={tx("Tickets", "تذاكر")} value={ws._count.tickets} />
                  <Stat label={tx("Campaigns", "حملات")} value={ws._count.campaigns} />
                </div>
              </Section>

              {/* Members */}
              <Section label={`${tx("Members", "الأعضاء")} (${ws.members.length})`}>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {ws.members.map((m) => (
                    <div
                      key={m.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "6px 8px",
                        background: "var(--bg-2)",
                        borderRadius: 8,
                      }}
                    >
                      <Avatar name={m.user.name} color={m.user.color} size="sm" />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500 }}>
                          {m.user.name}
                        </div>
                        <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
                          {m.user.email}
                        </div>
                      </div>
                      <Badge kind="ai">{m.role}</Badge>
                    </div>
                  ))}
                </div>
              </Section>

              {/* Integrations */}
              <Section label={`${tx("Integrations", "التكاملات")} (${ws.integrations.length})`}>
                {ws.integrations.length === 0 ? (
                  <div className="mono muted" style={{ fontSize: 11 }}>
                    {tx("No integrations connected.", "لا توجد تكاملات.")}
                  </div>
                ) : (
                  ws.integrations.map((i) => (
                    <div
                      key={i.id}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 8,
                        padding: "6px 8px",
                        background: "var(--bg-2)",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    >
                      <span style={{ fontWeight: 500 }}>{i.platform}</span>
                      <span className="mono muted" style={{ fontSize: 10 }}>
                        {i.pageName ?? i.pageId ?? "—"}
                      </span>
                    </div>
                  ))
                )}
              </Section>

              {/* Plan change */}
              <Section label={tx("Plan", "الخطة")}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {(["free", "starter", "growth", "pro"] as const).map((p) => {
                    const active = ws.plan === p;
                    return (
                      <button
                        key={p}
                        type="button"
                        className={`btn sm ${active ? "primary" : "ghost"}`.trim()}
                        disabled={planMut.loading || active}
                        onClick={() => onChangePlan(p)}
                      >
                        {active && <IconCheck w={10} />} {p}
                      </button>
                    );
                  })}
                </div>
                {planMut.error && (
                  <div style={{ color: "var(--bad)", fontSize: 11, marginTop: 6 }}>
                    {planMut.error}
                  </div>
                )}
              </Section>

              {/* Actions */}
              <Section label={tx("Actions", "إجراءات")}>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <button
                    type="button"
                    className="btn"
                    onClick={onImpersonate}
                    disabled={impersonateMut.loading}
                    style={{ justifyContent: "flex-start" }}
                  >
                    <IconHand w={13} />
                    {impersonateMut.loading
                      ? tx("Entering…", "جارٍ الدخول…")
                      : tx("Impersonate workspace", "الدخول كهذا العميل")}
                  </button>
                  <button
                    type="button"
                    className={`btn ${isSuspended ? "" : "ghost"}`.trim()}
                    onClick={onSuspendToggle}
                    disabled={suspendMut.loading}
                    style={{
                      justifyContent: "flex-start",
                      color: isSuspended ? undefined : "var(--bad)",
                    }}
                  >
                    {suspendMut.loading
                      ? tx("Updating…", "جارٍ…")
                      : isSuspended
                        ? tx("Reactivate workspace", "إعادة التفعيل")
                        : tx("Suspend workspace", "إيقاف مساحة العمل")}
                  </button>
                  {impersonateMut.error && (
                    <div style={{ color: "var(--bad)", fontSize: 11 }}>
                      {impersonateMut.error}
                    </div>
                  )}
                </div>
              </Section>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

/* ─── Tiny helpers ──────────────────────────────────────────────── */

function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th
      style={{
        textAlign: "start",
        fontSize: 10,
        textTransform: "uppercase",
        letterSpacing: 0.06,
        padding: "6px 10px",
        fontFamily: "var(--font-mono)",
        fontWeight: 500,
      }}
    >
      {children}
    </th>
  );
}
function Td({ children }: { children?: React.ReactNode }) {
  return <td style={{ padding: "10px 10px", verticalAlign: "top" }}>{children}</td>;
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        className="mono"
        style={{
          fontSize: 10,
          color: "var(--ink-3)",
          textTransform: "uppercase",
          letterSpacing: 0.06,
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "4px 0", fontSize: 13 }}>
      <span className="muted">{k}</span>
      <span className={mono ? "mono" : ""} style={{ textAlign: "end" }}>{v}</span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        padding: "8px 10px",
        background: "var(--bg-2)",
        borderRadius: 8,
      }}
    >
      <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.06 }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 600, marginTop: 2 }}>
        {value.toLocaleString()}
      </div>
    </div>
  );
}

// Mark unused imports as used — defensive against tree-shaking in build modes.
// (useMemo isn't strictly needed but kept for future filtering work.)
useMemo;

const Admin = memo(AdminImpl);
export default Admin;
