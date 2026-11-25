import { useEffect, useMemo, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { api, ApiError } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import { usePermissions, NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";
import { Modal } from "@/components/Modal";
import { Badge } from "@/components/Badge";
import {
  ACTIONS,
  ACTION_LABELS,
  RESOURCES,
  RESOURCE_LABELS,
  isColumnAll,
  isRowAll,
  toggleCell,
  toggleColumn,
  toggleRow,
  type ConversationVisibility,
  type PermissionMatrix,
} from "@/lib/permissions";
import { arabicServerMessage, changedRoleFields } from "@/lib/roleErrors";
import { inputStyle } from "./form";
import { useViewport } from "@/lib/useViewport";
import { BP } from "@/styles/breakpoints";

export interface RoleRow {
  id: string;
  key: string | null;
  name: string;
  nameAr: string;
  isSystem: boolean;
  permissions: PermissionMatrix;
  conversationVisibility: ConversationVisibility;
  memberCount: number;
}

type TxFn = (en: string, ar: string) => string;

/** Server 400/403/409 messages are shown as-is; a 409 role-in-use gets a
 *  localized sentence built from the `members` count. */
export function roleErrorMessage(e: unknown, tx: TxFn): string {
  if (e instanceof ApiError) {
    if (e.status === 409 && e.body && typeof e.body === "object" && "members" in e.body) {
      const n = Number((e.body as { members: number }).members);
      return tx(
        `This role is assigned to ${n} member(s). Move them to another role first.`,
        `هذا الدور مسند إلى ${n} عضو. انقلهم إلى دور آخر أولاً.`,
      );
    }
    const ar = arabicServerMessage(e.message);
    return ar ? tx(e.message, ar) : e.message;
  }
  return tx("Request failed", "فشل الطلب");
}

/** SP-30: below md the two-column roles grid collapses (the shared breakpoint scale, was a computed 720 px query). */
function useNarrow(): boolean {
  return useViewport().width < BP.md;
}

export function RolesTab() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { can } = usePermissions();
  const canView = can("roles.view");
  const canCreate = can("roles.create");
  const canUpdate = can("roles.update");
  const canDelete = can("roles.delete");
  const noPerm = tx(NO_PERMISSION_EN, NO_PERMISSION_AR);
  const narrow = useNarrow();

  const rolesQ = useFetch<RoleRow[]>(canView ? "/roles" : null);
  const roles = rolesQ.data ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedId && roles.length > 0) setSelectedId(roles[0]!.id);
  }, [roles, selectedId]);

  const selected = roles.find((r) => r.id === selectedId) ?? null;

  if (!canView) {
    return (
      <div className="muted" style={{ padding: 20, fontSize: 13 }}>
        {noPerm}
      </div>
    );
  }

  return (
    <div
      style={{
        padding: 20,
        display: "grid",
        gridTemplateColumns: narrow ? "minmax(0, 1fr)" : "minmax(200px, 260px) minmax(0, 1fr)",
        gap: 16,
        alignItems: "start",
      }}
    >
      <div className="card" style={{ padding: 8 }}>
        {roles.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => {
              setSelectedId(r.id);
              setError(null);
            }}
            style={{
              display: "flex",
              width: "100%",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 8,
              padding: "10px 12px",
              borderRadius: 8,
              textAlign: "start",
              background: r.id === selectedId ? "var(--bg-2)" : "transparent",
              border: "none",
              color: "inherit",
              cursor: "pointer",
            }}
          >
            <span dir="auto" style={{ fontWeight: 500 }}>
              {t.lang === "ar" ? r.nameAr || r.name : r.name}
            </span>
            <span className="mono muted" style={{ fontSize: 11 }}>
              {r.memberCount} {tx("members", "أعضاء")}
            </span>
          </button>
        ))}
        <button
          type="button"
          className="btn ghost sm"
          style={{ marginTop: 8, width: "100%" }}
          disabled={!canCreate}
          title={canCreate ? undefined : noPerm}
          onClick={() => setCreating(true)}
        >
          + {tx("New role", "دور جديد")}
        </button>
      </div>

      {selected ? (
        <RoleEditor
          key={selected.id + ":" + selected.memberCount}
          role={selected}
          canUpdate={canUpdate}
          canDelete={canDelete}
          noPerm={noPerm}
          tx={tx}
          lang={t.lang}
          error={error}
          setError={setError}
          onChanged={async () => {
            await rolesQ.refetch();
          }}
          onDeleted={async () => {
            setSelectedId(null);
            await rolesQ.refetch();
          }}
        />
      ) : (
        <div className="muted" style={{ fontSize: 13 }}>
          {rolesQ.loading ? tx("Loading…", "جارٍ التحميل…") : (rolesQ.error ?? "")}
        </div>
      )}

      {creating && (
        <CreateRoleModal
          roles={roles}
          tx={tx}
          lang={t.lang}
          onClose={() => setCreating(false)}
          onCreated={async (r) => {
            setCreating(false);
            await rolesQ.refetch();
            setSelectedId(r.id);
          }}
        />
      )}
    </div>
  );
}

function RoleEditor({
  role,
  canUpdate,
  canDelete,
  noPerm,
  tx,
  lang,
  error,
  setError,
  onChanged,
  onDeleted,
}: {
  role: RoleRow;
  canUpdate: boolean;
  canDelete: boolean;
  noPerm: string;
  tx: TxFn;
  lang: string;
  error: string | null;
  setError: (m: string | null) => void;
  onChanged: () => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const isOwner = role.key === "owner";
  const readOnly = isOwner || !canUpdate;
  const [name, setName] = useState(role.name);
  const [nameAr, setNameAr] = useState(role.nameAr);
  const [matrix, setMatrix] = useState<PermissionMatrix>(role.permissions);
  const [visibility, setVisibility] = useState<ConversationVisibility>(
    role.conversationVisibility,
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const dirty = useMemo(
    () =>
      name !== role.name ||
      nameAr !== role.nameAr ||
      visibility !== role.conversationVisibility ||
      JSON.stringify(matrix) !== JSON.stringify(role.permissions),
    [name, nameAr, matrix, visibility, role],
  );

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const body = changedRoleFields(
        {
          name: role.name,
          nameAr: role.nameAr,
          permissions: role.permissions,
          conversationVisibility: role.conversationVisibility,
        },
        {
          name: name.trim(),
          nameAr: nameAr.trim(),
          permissions: matrix,
          conversationVisibility: visibility,
        },
      );
      await api.patch(`/roles/${role.id}`, body);
      setSaved(true);
      await onChanged();
    } catch (e) {
      setError(roleErrorMessage(e, tx));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (
      !window.confirm(
        tx(`Delete the role "${role.name}"?`, `حذف الدور "${role.nameAr || role.name}"؟`),
      )
    ) {
      return;
    }
    setError(null);
    try {
      await api.delete(`/roles/${role.id}`);
      await onDeleted();
    } catch (e) {
      setError(roleErrorMessage(e, tx));
    }
  };

  const th = { padding: "8px 10px", fontSize: 11, textAlign: "center" as const };

  return (
    <div className="card" style={{ padding: 16, minWidth: 0 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end" }}>
        <label style={{ display: "grid", gap: 4, flex: "1 1 180px" }}>
          <span className="mono muted" style={{ fontSize: 11 }}>
            {tx("Name", "الاسم")}
          </span>
          <input
            dir="auto"
            style={inputStyle}
            value={name}
            disabled={readOnly}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label style={{ display: "grid", gap: 4, flex: "1 1 180px" }}>
          <span className="mono muted" style={{ fontSize: 11 }}>
            {tx("Name (Arabic)", "الاسم (بالعربية)")}
          </span>
          <input
            dir="rtl"
            style={inputStyle}
            value={nameAr}
            disabled={readOnly}
            onChange={(e) => setNameAr(e.target.value)}
          />
        </label>
        {role.isSystem && <Badge kind="accent">{tx("System role", "دور النظام")}</Badge>}
      </div>

      {isOwner && (
        <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          {tx(
            "The owner role always has full access and cannot be edited.",
            "دور المالك لديه صلاحية كاملة دائماً ولا يمكن تعديله.",
          )}
        </div>
      )}

      <div style={{ overflowX: "auto", marginTop: 14 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "start" }}>{tx("Resource", "المورد")}</th>
              {ACTIONS.map((a) => (
                <th key={a} style={th}>
                  <label style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                    <input
                      type="checkbox"
                      disabled={readOnly}
                      checked={isColumnAll(matrix, a)}
                      aria-label={tx(`All ${ACTION_LABELS[a][0]}`, `كل ${ACTION_LABELS[a][1]}`)}
                      onChange={() => setMatrix((m) => toggleColumn(m, a))}
                    />
                    {lang === "ar" ? ACTION_LABELS[a][1] : ACTION_LABELS[a][0]}
                  </label>
                </th>
              ))}
              <th style={th}>{tx("All", "الكل")}</th>
            </tr>
          </thead>
          <tbody>
            {RESOURCES.map((r) => (
              <tr key={r} style={{ borderTop: "1px solid var(--line-soft)" }}>
                <td style={{ padding: "8px 10px" }}>
                  {lang === "ar" ? RESOURCE_LABELS[r][1] : RESOURCE_LABELS[r][0]}
                </td>
                {ACTIONS.map((a) => (
                  <td key={a} style={{ textAlign: "center" }}>
                    <input
                      type="checkbox"
                      disabled={readOnly}
                      checked={(matrix[r] ?? []).includes(a)}
                      aria-label={tx(
                        `${RESOURCE_LABELS[r][0]} ${ACTION_LABELS[a][0]}`,
                        `${RESOURCE_LABELS[r][1]} ${ACTION_LABELS[a][1]}`,
                      )}
                      onChange={() => setMatrix((m) => toggleCell(m, r, a))}
                    />
                  </td>
                ))}
                <td style={{ textAlign: "center" }}>
                  <input
                    type="checkbox"
                    disabled={readOnly}
                    checked={isRowAll(matrix, r)}
                    aria-label={tx(`All ${RESOURCE_LABELS[r][0]}`, `كل ${RESOURCE_LABELS[r][1]}`)}
                    onChange={() => setMatrix((m) => toggleRow(m, r))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <label style={{ display: "grid", gap: 4, marginTop: 14, maxWidth: 320 }}>
        <span className="mono muted" style={{ fontSize: 11 }}>
          {tx("Conversation visibility", "رؤية المحادثات")}
        </span>
        <select
          style={inputStyle}
          value={visibility}
          disabled={readOnly}
          onChange={(e) => setVisibility(e.target.value as ConversationVisibility)}
        >
          <option value="all">{tx("All conversations", "كل المحادثات")}</option>
          <option value="assigned">{tx("Assigned only", "المسندة إليه فقط")}</option>
        </select>
      </label>

      {error && (
        <div role="alert" style={{ color: "var(--bad)", fontSize: 12, marginTop: 12 }}>
          {error}
        </div>
      )}
      {saved && !error && (
        <div className="muted" style={{ fontSize: 12, marginTop: 12 }}>
          {tx("Saved.", "تم الحفظ.")}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
        {!role.isSystem && (
          <button
            type="button"
            className="btn ghost"
            style={{ color: "var(--bad)" }}
            disabled={!canDelete}
            title={canDelete ? undefined : noPerm}
            onClick={remove}
          >
            {tx("Delete role", "حذف الدور")}
          </button>
        )}
        {!isOwner && (
          <button
            type="button"
            className="btn primary"
            disabled={!canUpdate || !dirty || saving}
            title={canUpdate ? undefined : noPerm}
            onClick={save}
          >
            {saving ? tx("Saving…", "جارٍ الحفظ…") : tx("Save changes", "حفظ التغييرات")}
          </button>
        )}
      </div>
    </div>
  );
}

function CreateRoleModal({
  roles,
  tx,
  lang,
  onClose,
  onCreated,
}: {
  roles: RoleRow[];
  tx: TxFn;
  lang: string;
  onClose: () => void;
  onCreated: (r: RoleRow) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [nameAr, setNameAr] = useState("");
  const [fromId, setFromId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const src = roles.find((r) => r.id === fromId);
    try {
      const created = await api.post<RoleRow>("/roles", {
        name: name.trim(),
        nameAr: nameAr.trim() || name.trim(),
        permissions: src?.permissions ?? {},
        conversationVisibility: src?.conversationVisibility ?? "all",
      });
      await onCreated(created);
    } catch (e) {
      setError(roleErrorMessage(e, tx));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={tx("New role", "دور جديد")}>
      <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>
        {tx("New role", "دور جديد")}
      </h3>
      <div style={{ display: "grid", gap: 10 }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span className="mono muted" style={{ fontSize: 11 }}>{tx("Name", "الاسم")}</span>
          <input dir="auto" style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span className="mono muted" style={{ fontSize: 11 }}>
            {tx("Name (Arabic)", "الاسم (بالعربية)")}
          </span>
          <input dir="rtl" style={inputStyle} value={nameAr} onChange={(e) => setNameAr(e.target.value)} />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span className="mono muted" style={{ fontSize: 11 }}>{tx("Start from", "البدء من")}</span>
          <select style={inputStyle} value={fromId} onChange={(e) => setFromId(e.target.value)}>
            <option value="">{tx("Empty (no access)", "فارغ (بدون صلاحيات)")}</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {lang === "ar" ? r.nameAr || r.name : r.name}
              </option>
            ))}
          </select>
        </label>
        {error && (
          <div role="alert" style={{ color: "var(--bad)", fontSize: 12 }}>
            {error}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn ghost" onClick={onClose}>
            {tx("Cancel", "إلغاء")}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || name.trim().length < 2}
            onClick={submit}
          >
            {tx("Create role", "إنشاء الدور")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
