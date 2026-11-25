/**
 * SP-10 Services tab: table (colour, name EN/AR, duration, price, staff,
 * upcoming bookings, active), search (`q` in the hash), archived filter,
 * create/edit, delete-with-preview (archive when referenced) and restore.
 * Visible with bookings.view; every write and the import need bookings.manage.
 */
import { useMemo, useState } from "react";
import { useFetch } from "@/api/useFetch";
import { PageHeader } from "@/components/PageHeader";
import { IconPlus, IconSearch, IconTrash } from "@/icons";
import type { Tx } from "@/lib/tx";
import type { Lang, Service, StaffResource } from "@/lib/types";
import { bookingErrorText } from "./bookingErrors";
import { deleteService, restoreService, servicePreview, servicesPath, staffPath } from "./catalogApi";
import type { CatalogParams } from "./catalogParams";
import { ColorDot, DeleteDialog, ErrorBox, FIELD, Money, TD, TH } from "./catalogUi";
import { ServiceDialog } from "./ServiceDialog";
import { CatalogImportWizard } from "./CatalogImportWizard";
import { matchesSearch } from "./catalogSearch";

interface Props {
  tx: Tx;
  lang: Lang;
  tz: string;
  canManage: boolean;
  params: CatalogParams;
  setParams: (p: Partial<CatalogParams>) => void;
}

export function ServicesTab({ tx, lang, tz, canManage, params, setParams }: Props) {
  const servicesQ = useFetch<{ items: Service[] }>(servicesPath(params.archived));
  const staffQ = useFetch<{ items: StaffResource[] }>(staffPath(true));
  const [editing, setEditing] = useState<Service | "new" | null>(null);
  const [deleting, setDeleting] = useState<Service | null>(null);
  const [importing, setImporting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const services = useMemo(() => servicesQ.data?.items ?? [], [servicesQ.data]);
  const staff = useMemo(() => staffQ.data?.items ?? [], [staffQ.data]);
  const visible = useMemo(() => services.filter((s) => matchesSearch(params.q, s.name, s.nameAr)), [services, params.q]);
  const refresh = () => {
    void servicesQ.refetch();
    void staffQ.refetch();
  };

  const restore = async (s: Service) => {
    setActionError(null);
    try {
      await restoreService(s.id);
      refresh();
    } catch (e) {
      setActionError(bookingErrorText(e, tx));
    }
  };

  return (
    <div>
      <PageHeader
        title={tx("Services", "الخدمات")}
        subtitle={tx("What customers can book, how long it takes and who provides it.", "ما يمكن للعملاء حجزه ومدته ومن يقدّمه.")}
        actions={
          canManage ? (
            <>
              <button className="btn" onClick={() => setImporting(true)}>
                {tx("Import", "استيراد")}
              </button>
              <button className="btn primary" onClick={() => setEditing("new")}>
                <IconPlus w={14} />
                {tx("New service", "خدمة جديدة")}
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
              aria-label={tx("Search services", "البحث في الخدمات")}
              placeholder={tx("Search by name", "ابحث بالاسم")}
              style={{ ...FIELD, width: "100%", paddingInlineStart: 30 }}
              value={params.q}
              onChange={(e) => setParams({ q: e.target.value })}
            />
          </div>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: "var(--ink-2)" }}>
            <input type="checkbox" checked={params.archived} onChange={(e) => setParams({ archived: e.target.checked })} />
            {tx("Show paused and archived", "إظهار الموقوفة والمؤرشفة")}
          </label>
        </div>
        {servicesQ.error && <ErrorBox>{servicesQ.error}</ErrorBox>}
        {actionError && <ErrorBox>{actionError}</ErrorBox>}
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, minWidth: 760 }}>
            <thead>
              <tr>
                <th style={TH}>{tx("Service", "الخدمة")}</th>
                <th style={TH}>{tx("Duration", "المدة")}</th>
                <th style={TH}>{tx("Price", "السعر")}</th>
                <th style={TH}>{tx("Staff", "الموظفون")}</th>
                <th style={TH}>{tx("Upcoming", "القادمة")}</th>
                <th style={TH}>{tx("Status", "الحالة")}</th>
                <th style={TH} />
              </tr>
            </thead>
            <tbody>
              {servicesQ.loading && !services.length && (
                <tr>
                  <td style={TD} colSpan={7} className="muted">
                    {tx("Loading…", "جارٍ التحميل…")}
                  </td>
                </tr>
              )}
              {!servicesQ.loading && !visible.length && (
                <tr>
                  <td style={TD} colSpan={7} className="muted">
                    {params.q ? tx("No service matches this search.", "لا توجد خدمة تطابق البحث.") : tx("No services yet.", "لا توجد خدمات بعد.")}
                  </td>
                </tr>
              )}
              {visible.map((s) => (
                <tr key={s.id} style={{ opacity: s.active ? 1 : 0.6 }}>
                  <td style={TD}>
                    <button
                      type="button"
                      className="btn ghost"
                      disabled={!canManage}
                      onClick={() => setEditing(s)}
                      style={{ display: "flex", gap: 8, alignItems: "center", padding: 0, height: "auto", textAlign: "start" }}
                    >
                      <ColorDot color={s.color} />
                      <span style={{ display: "grid" }}>
                        <bdi style={{ fontWeight: 500 }}>{lang === "ar" ? s.nameAr : s.name}</bdi>
                        <bdi className="muted" style={{ fontSize: 12 }}>{lang === "ar" ? s.name : s.nameAr}</bdi>
                      </span>
                    </button>
                  </td>
                  <td style={TD}>
                    <bdi>{s.durationMin}</bdi> {tx("min", "دقيقة")}
                  </td>
                  <td style={TD}>
                    <Money price={s.price} currency={s.currency} lang={lang} />
                  </td>
                  <td style={TD}>
                    <bdi>{s.staffIds.length}</bdi>
                  </td>
                  <td style={TD}>
                    <bdi>{s.upcomingCount}</bdi>
                  </td>
                  <td style={TD}>
                    {s.archivedAt ? (
                      <span className="chip">{tx("Archived", "مؤرشفة")}</span>
                    ) : s.active ? (
                      <span className="chip" style={{ color: "var(--ok)" }}>{tx("Active", "نشطة")}</span>
                    ) : (
                      <span className="chip">{tx("Paused", "موقوفة")}</span>
                    )}
                  </td>
                  <td style={{ ...TD, textAlign: "end", whiteSpace: "nowrap" }}>
                    {canManage && (s.archivedAt || !s.active) && (
                      <button className="btn sm" onClick={() => void restore(s)}>
                        {tx("Restore", "استعادة")}
                      </button>
                    )}
                    {canManage && !s.archivedAt && (
                      <button className="btn ghost icon sm" aria-label={tx("Delete or archive", "حذف أو أرشفة")} onClick={() => setDeleting(s)}>
                        <IconTrash w={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <ServiceDialog
          service={editing === "new" ? null : editing}
          staff={staff}
          tx={tx}
          lang={lang}
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
          title={tx("Delete service", "حذف الخدمة")}
          name={lang === "ar" ? deleting.nameAr : deleting.name}
          load={() => servicePreview(deleting.id)}
          counts={(p) => ({ bookingCount: p.bookingCount, upcomingCount: p.upcomingCount, links: p.staffCount })}
          linksLabel={["Staff linked", "الموظفون المرتبطون"]}
          remove={() => deleteService(deleting.id)}
          onClose={() => setDeleting(null)}
          onDone={() => {
            setDeleting(null);
            refresh();
          }}
        />
      )}
      {importing && (
        <CatalogImportWizard
          tx={tx}
          lang={lang}
          tz={tz}
          initialKind="services"
          onClose={() => setImporting(false)}
          onFinished={refresh}
        />
      )}
    </div>
  );
}
