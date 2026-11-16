/**
 * SP-10 Staff tab: cards | table (`layout` in the hash), search (`q`),
 * archived filter, create/edit with the weekly schedule editor, member link,
 * services, delete-with-preview and restore. Visible with bookings.view;
 * writes and the import need bookings.manage.
 */
import { useMemo, useState } from "react";
import { useFetch } from "@/api/useFetch";
import { PageHeader } from "@/components/PageHeader";
import { IconPlus, IconSearch, IconTrash } from "@/icons";
import type { Tx } from "@/lib/tx";
import type { Lang, Service, StaffResource, TeamMember } from "@/lib/types";
import { bookingErrorText } from "./bookingErrors";
import { deleteStaff, restoreStaff, servicesPath, staffPath, staffPreview } from "./catalogApi";
import type { CatalogParams } from "./catalogParams";
import { ColorDot, DeleteDialog, ErrorBox, FIELD, TD, TH } from "./catalogUi";
import { StaffDialog } from "./StaffDialog";
import { CatalogImportWizard } from "./CatalogImportWizard";
import { matchesSearch } from "./catalogSearch";
import { scheduleSummary } from "./schedule";

interface Props {
  tx: Tx;
  lang: Lang;
  tz: string;
  canManage: boolean;
  params: CatalogParams;
  setParams: (p: Partial<CatalogParams>) => void;
}

export function StaffTab({ tx, lang, tz, canManage, params, setParams }: Props) {
  const staffQ = useFetch<{ items: StaffResource[] }>(staffPath(params.archived));
  const allStaffQ = useFetch<{ items: StaffResource[] }>(staffPath(true));
  const servicesQ = useFetch<{ items: Service[] }>(servicesPath(true));
  const teamQ = useFetch<TeamMember[]>(canManage ? "/team" : null);
  const [editing, setEditing] = useState<StaffResource | "new" | null>(null);
  const [deleting, setDeleting] = useState<StaffResource | null>(null);
  const [importing, setImporting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const staff = useMemo(() => staffQ.data?.items ?? [], [staffQ.data]);
  const services = useMemo(() => servicesQ.data?.items ?? [], [servicesQ.data]);
  const serviceById = useMemo(() => new Map(services.map((s) => [s.id, s])), [services]);
  const visible = useMemo(() => staff.filter((r) => matchesSearch(params.q, r.name, r.nameAr, r.role)), [staff, params.q]);
  const refresh = () => {
    void staffQ.refetch();
    void allStaffQ.refetch();
    void servicesQ.refetch();
  };
  const takenUserIds = (self: StaffResource | null) =>
    new Set((allStaffQ.data?.items ?? []).filter((r) => r.userId && r.id !== self?.id).map((r) => r.userId as string));

  const restore = async (r: StaffResource) => {
    setActionError(null);
    try {
      await restoreStaff(r.id);
      refresh();
    } catch (e) {
      setActionError(bookingErrorText(e, tx));
    }
  };

  const nameOf = (r: StaffResource) => (lang === "ar" ? r.nameAr || r.name : r.name);
  const serviceNames = (r: StaffResource) =>
    r.serviceIds
      .map((id) => serviceById.get(id))
      .filter(Boolean)
      .map((s) => (lang === "ar" ? s!.nameAr : s!.name));
  const status = (r: StaffResource) =>
    r.archivedAt ? (
      <span className="chip">{tx("Archived", "مؤرشف")}</span>
    ) : r.active ? null : (
      <span className="chip">{tx("Paused", "موقوف")}</span>
    );
  const actions = (r: StaffResource) =>
    canManage && (
      <span style={{ display: "inline-flex", gap: 4 }}>
        {(r.archivedAt || !r.active) && (
          <button className="btn sm" onClick={() => void restore(r)}>
            {tx("Restore", "استعادة")}
          </button>
        )}
        {!r.archivedAt && (
          <button className="btn ghost icon sm" aria-label={tx("Delete or archive", "حذف أو أرشفة")} onClick={() => setDeleting(r)}>
            <IconTrash w={14} />
          </button>
        )}
      </span>
    );

  return (
    <div>
      <PageHeader
        title={tx("Staff", "الموظفون")}
        subtitle={tx("Who bookings are placed on, their working hours and services.", "من تُسند إليهم الحجوزات وساعات عملهم وخدماتهم.")}
        actions={
          canManage ? (
            <>
              <button className="btn" onClick={() => setImporting(true)}>
                {tx("Import", "استيراد")}
              </button>
              <button className="btn primary" onClick={() => setEditing("new")}>
                <IconPlus w={14} />
                {tx("New staff", "موظف جديد")}
              </button>
            </>
          ) : undefined
        }
      />
      <div style={{ padding: "0 24px 24px", display: "grid", gap: 12 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ position: "relative", flex: "1 1 240px", maxWidth: 360 }}>
            <span style={{ position: "absolute", insetInlineStart: 10, top: 9, color: "var(--ink-3)" }}>
              <IconSearch w={14} />
            </span>
            <input
              type="search"
              aria-label={tx("Search staff", "البحث في الموظفين")}
              placeholder={tx("Search by name or role", "ابحث بالاسم أو المسمى")}
              style={{ ...FIELD, width: "100%", paddingInlineStart: 30 }}
              value={params.q}
              onChange={(e) => setParams({ q: e.target.value })}
            />
          </div>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: "var(--ink-2)" }}>
            <input type="checkbox" checked={params.archived} onChange={(e) => setParams({ archived: e.target.checked })} />
            {tx("Show paused and archived", "إظهار الموقوفين والمؤرشفين")}
          </label>
          <div style={{ flex: 1 }} />
          <div className="tabs" role="tablist" style={{ padding: 0, border: 0 }}>
            <button role="tab" aria-selected={params.layout === "cards"} className={`tab ${params.layout === "cards" ? "active" : ""}`.trim()} onClick={() => setParams({ layout: "cards" })}>
              {tx("Cards", "بطاقات")}
            </button>
            <button role="tab" aria-selected={params.layout === "table"} className={`tab ${params.layout === "table" ? "active" : ""}`.trim()} onClick={() => setParams({ layout: "table" })}>
              {tx("Table", "جدول")}
            </button>
          </div>
        </div>
        {staffQ.error && <ErrorBox>{staffQ.error}</ErrorBox>}
        {actionError && <ErrorBox>{actionError}</ErrorBox>}
        {!staffQ.loading && !visible.length && (
          <div className="card muted" style={{ padding: 16 }}>
            {params.q ? tx("No staff match this search.", "لا يوجد موظف يطابق البحث.") : tx("No staff yet.", "لا يوجد موظفون بعد.")}
          </div>
        )}

        {params.layout === "cards" ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
            {visible.map((r) => (
              <div key={r.id} className="card" style={{ padding: 14, display: "grid", gap: 8, opacity: r.active ? 1 : 0.6 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <ColorDot color={r.color} size={12} />
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={!canManage}
                    onClick={() => setEditing(r)}
                    style={{ padding: 0, height: "auto", fontWeight: 600, flex: 1, justifyContent: "flex-start", textAlign: "start" }}
                  >
                    <bdi>{nameOf(r)}</bdi>
                  </button>
                  {status(r)}
                  {actions(r)}
                </div>
                {(r.role || r.user) && (
                  <div className="muted" style={{ fontSize: 12 }}>
                    {[r.role, r.user ? `${tx("Member", "عضو")}: ${r.user.name}` : null].filter(Boolean).join(" · ")}
                  </div>
                )}
                <div style={{ fontSize: 12, color: r.scheduleConfigured ? "var(--ink-2)" : "var(--warn)" }}>
                  <bdi>{scheduleSummary(r.schedule, lang)}</bdi>
                </div>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {serviceNames(r).map((n) => (
                    <span key={n} className="chip" style={{ fontSize: 11 }}>
                      <bdi>{n}</bdi>
                    </span>
                  ))}
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {tx("Upcoming bookings", "الحجوزات القادمة")}: <bdi>{r.upcomingCount}</bdi>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="card" style={{ padding: 0, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, minWidth: 820 }}>
              <thead>
                <tr>
                  <th style={TH}>{tx("Name", "الاسم")}</th>
                  <th style={TH}>{tx("Role", "المسمى")}</th>
                  <th style={TH}>{tx("Member", "العضو")}</th>
                  <th style={TH}>{tx("Working hours", "ساعات العمل")}</th>
                  <th style={TH}>{tx("Services", "الخدمات")}</th>
                  <th style={TH}>{tx("Upcoming", "القادمة")}</th>
                  <th style={TH} />
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.id} style={{ opacity: r.active ? 1 : 0.6 }}>
                    <td style={TD}>
                      <button type="button" className="btn ghost" disabled={!canManage} onClick={() => setEditing(r)} style={{ padding: 0, height: "auto", display: "flex", gap: 8 }}>
                        <ColorDot color={r.color} />
                        <bdi>{nameOf(r)}</bdi>
                      </button>
                    </td>
                    <td style={TD}>{r.role ?? <span className="muted">—</span>}</td>
                    <td style={TD}>{r.user?.name ?? <span className="muted">—</span>}</td>
                    <td style={{ ...TD, color: r.scheduleConfigured ? undefined : "var(--warn)" }}>
                      <bdi>{scheduleSummary(r.schedule, lang)}</bdi>
                    </td>
                    <td style={TD}>
                      <bdi>{r.serviceIds.length}</bdi>
                    </td>
                    <td style={TD}>
                      <bdi>{r.upcomingCount}</bdi>
                    </td>
                    <td style={{ ...TD, textAlign: "end", whiteSpace: "nowrap" }}>
                      {status(r)} {actions(r)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <StaffDialog
          resource={editing === "new" ? null : editing}
          services={services}
          members={teamQ.data ?? []}
          takenUserIds={takenUserIds(editing === "new" ? null : editing)}
          tx={tx}
          lang={lang}
          tz={tz}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
      {deleting && (
        <DeleteDialog
          tx={tx}
          lang={lang}
          title={tx("Delete staff", "حذف الموظف")}
          name={nameOf(deleting)}
          load={() => staffPreview(deleting.id)}
          counts={(p) => ({ bookingCount: p.bookingCount, upcomingCount: p.upcomingCount, links: p.serviceCount })}
          linksLabel={["Services linked", "الخدمات المرتبطة"]}
          remove={() => deleteStaff(deleting.id)}
          onClose={() => setDeleting(null)}
          onDone={() => {
            setDeleting(null);
            refresh();
          }}
        />
      )}
      {importing && (
        <CatalogImportWizard tx={tx} lang={lang} tz={tz} initialKind="staff" onClose={() => setImporting(false)} onFinished={refresh} />
      )}
    </div>
  );
}
