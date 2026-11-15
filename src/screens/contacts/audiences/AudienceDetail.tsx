import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import { usePermissions, NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";
import { useToast } from "@/components/Toast";
import { IconPlus, IconX } from "@/icons";
import { openRecord } from "@/lib/openRecord";
import type { Tx } from "@/lib/tx";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import type { AudienceContact, AudienceContactsPage, AudienceDetail as Detail, Campaign, Lang, Segment } from "@/lib/types";
import { campaignStatusLabel } from "../../campaigns/campaignDetailModel";
import { ImportChip, ImportWizard } from "../import/ImportWizard";
import { lifecycleLabel } from "../lifecycle";
import { AudienceSheet } from "./AudienceSheet";
import { audienceDeleteStateFromRefs, audienceErrorText, isForbidden } from "./audienceErrors";
import { AudienceDeleteDialog } from "./DeleteDialogs";
import { countedAtLabel, describeRule, describeTree, isGroup, issueText, legacyToTree, nodeAt } from "./rulesModel";
import { CountText, FIELD, IssueDot, RuleText, SECTION_LABEL, TypeBadge, segName, useRuleLookups } from "./ui";

interface Props {
  tx: Tx;
  lang: Lang;
  id: string;
  onBack: () => void;
  /** Open another audience (the "Used by" links). */
  onOpen: (id: string) => void;
  /** The audience changed or was deleted: refresh the list behind it. */
  onChanged: () => void;
}

/** One audience: header and count, issues, rules, members (keyset), candidates and import for groups, and "Used by". */
export function AudienceDetail({ tx, lang, id, onBack, onOpen, onChanged }: Props) {
  const { can } = usePermissions();
  const { toast } = useToast();
  const [reload, setReload] = useState(0);
  const detailQ = useFetch<Detail>(`/segments/${encodeURIComponent(id)}`, { key: reload });
  const lk = useRuleLookups();
  const [count, setCount] = useState<{ count: number | null; countedAt: string | null; timedOut: boolean } | null>(null);
  const [recounting, setRecounting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importWatchId, setImportWatchId] = useState<string | null>(null);
  const [membersKey, setMembersKey] = useState(0);
  const d = detailQ.data && detailQ.data.id === id ? detailQ.data : null;

  useEffect(() => setCount(null), [id, reload]);

  const refresh = () => {
    setReload((n) => n + 1);
    setMembersKey((n) => n + 1);
    onChanged();
  };

  if (!d) {
    const gone = detailQ.error && /not_found|not found/i.test(detailQ.error);
    return (
      <div style={{ padding: "0 24px 24px", display: "grid", gap: 12 }}>
        <BackLink tx={tx} onBack={onBack} />
        {detailQ.loading && <div className="mono muted" style={{ fontSize: 12 }}>{tx("Loading…", "جارٍ التحميل…")}</div>}
        {detailQ.error && (
          <div role="alert" style={{ fontSize: 13, color: "var(--bad)" }}>
            {gone ? tx("This audience no longer exists.", "هذا الجمهور لم يعد موجودًا.") : tx("Couldn't load this audience.", "تعذر تحميل هذا الجمهور.")}
          </div>
        )}
      </div>
    );
  }

  const smart = d.origin === "crm";
  const manual = d.origin === "manual";
  const hjz = d.origin === "hjz";
  const tree = smart ? d.rules ?? legacyToTree(d.filter) : null;
  const issues = d.issues ?? [];
  const shown = count ?? { count: d.count, countedAt: d.countedAt ?? null, timedOut: !!d.timedOut };
  const counted = countedAtLabel(shown.countedAt, tx);
  const canEdit = !hjz && can("audiences.update");
  const canDelete = !hjz && can("audiences.delete");

  const recount = async () => {
    setRecounting(true);
    try {
      setCount(await api.get<{ count: number | null; countedAt: string | null; timedOut: boolean }>(`/segments/${encodeURIComponent(id)}/count`));
    } catch (e) {
      toast(audienceErrorText(e, tx), "error");
    } finally {
      setRecounting(false);
    }
  };

  return (
    <div style={{ padding: "0 24px 24px", display: "grid", gap: 16 }}>
      <BackLink tx={tx} onBack={onBack} />

      {/* Header */}
      <div className="card" style={{ padding: 16, display: "grid", gap: 10, borderInlineStart: `4px solid ${d.color ? `hsl(${d.color} 70% 45%)` : "var(--line)"}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, fontSize: 18 }}><bdi dir="auto">{segName(d, lang)}</bdi></h2>
          <TypeBadge origin={d.origin} tx={tx} color={d.color} />
          <IssueDot count={issues.length} tx={tx} />
          <span style={{ flex: 1 }} />
          {canEdit && (
            <button type="button" className="btn sm" onClick={() => setEditing(true)}>{tx("Edit", "تعديل")}</button>
          )}
          {canDelete && (
            <button type="button" className="btn ghost sm" style={{ color: "var(--bad)" }} onClick={() => setDeleting(true)}>{tx("Delete", "حذف")}</button>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <CountText count={shown.count} timedOut={shown.timedOut} tx={tx} style={{ fontSize: shown.count === null ? 15 : 26, fontWeight: 700, fontVariantNumeric: "tabular-nums" }} />
          {shown.count !== null && <span className="muted" style={{ fontSize: 12 }}>{tx("contacts", "جهة اتصال")}</span>}
          {counted && <span className="mono muted" style={{ fontSize: 11 }}>{counted}</span>}
          <button type="button" className="btn ghost sm" disabled={recounting} onClick={() => void recount()}>
            {recounting ? tx("Counting…", "جارٍ العدّ…") : tx("Recount", "أعد العدّ")}
          </button>
        </div>
        {hjz && <div className="muted" style={{ fontSize: 12 }}>{tx("Managed by HJZ: read-only here.", "تُدار من HJZ: للقراءة فقط هنا.")}</div>}
      </div>

      {/* Issues */}
      {smart && issues.length > 0 && (
        <div role="alert" style={{ padding: 12, borderRadius: 10, display: "grid", gap: 6, background: "color-mix(in oklab, var(--warn) 12%, var(--bg-2))", border: "1px solid var(--warn)" }}>
          <strong style={{ fontSize: 13 }}>{tx("Some conditions match nobody", "بعض الشروط لا تطابق أحدًا")}</strong>
          {issues.map((iss, i) => {
            const n = tree ? nodeAt(tree, iss.path) : null;
            return (
              <div key={i} style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                {n && !isGroup(n) && (
                  <span style={{ fontWeight: 600 }}><RuleText parts={describeRule(n, tx, lk)} />: </span>
                )}
                {issueText(iss, tx)}
              </div>
            );
          })}
          {canEdit && (
            <div><button type="button" className="btn sm" onClick={() => setEditing(true)}>{tx("Fix rules", "أصلح الشروط")}</button></div>
          )}
        </div>
      )}

      {/* Rules */}
      {tree && (
        <section>
          <div className="mono" style={SECTION_LABEL}>{tx("Who is in it", "من يضم")}</div>
          <div style={{ fontSize: 13.5, lineHeight: 1.6 }}><RuleText parts={describeTree(tree, tx, lk)} /></div>
        </section>
      )}

      {/* Members */}
      <section style={{ display: "grid", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div className="mono" style={{ ...SECTION_LABEL, margin: 0 }}>{tx("Members", "الأعضاء")}</div>
          <span style={{ flex: 1 }} />
          {manual && can("audiences.update") && (
            <>
              <button type="button" className={`btn sm ${adding ? "primary" : ""}`.trim()} onClick={() => setAdding((v) => !v)}>
                <IconPlus w={12} /> {tx("Add people", "إضافة أشخاص")}
              </button>
              <button type="button" className="btn sm" onClick={() => setImporting(true)}>{tx("Import file", "استيراد ملف")}</button>
              <ImportChip tx={tx} watchId={importWatchId} onFinished={() => { setImportWatchId(null); refresh(); }} />
            </>
          )}
        </div>
        {manual && adding && (
          <div className="card" style={{ padding: 12, display: "grid", gap: 8 }}>
            <strong style={{ fontSize: 13 }}>{tx("Add people to this group", "أضف أشخاصًا إلى هذه المجموعة")}</strong>
            <ContactPager
              tx={tx}
              lang={lang}
              base={`/segments/${encodeURIComponent(id)}/candidates`}
              reloadKey={membersKey}
              searchLabel={tx("Search contacts not in this group…", "ابحث في جهات الاتصال خارج هذه المجموعة…")}
              empty={tx("Everyone matching is already in this group.", "كل من يطابق موجود في هذه المجموعة.")}
              action={(c, drop) => (
                <MemberAction
                  tx={tx}
                  label={tx("Add", "إضافة")}
                  icon={<IconPlus w={12} />}
                  run={() => api.post(`/segments/${encodeURIComponent(id)}/members`, { contactIds: [c.id] })}
                  onDone={() => { drop(); setMembersKey((n) => n + 1); setReload((n) => n + 1); onChanged(); }}
                />
              )}
            />
          </div>
        )}
        <ContactPager
          tx={tx}
          lang={lang}
          base={`/segments/${encodeURIComponent(id)}/contacts`}
          reloadKey={membersKey}
          searchLabel={tx("Search members…", "ابحث في الأعضاء…")}
          empty={tx("No members.", "لا أعضاء.")}
          action={
            manual && can("audiences.update")
              ? (c, drop) => (
                  <MemberAction
                    tx={tx}
                    label={tx("Remove", "إزالة")}
                    icon={<IconX w={12} />}
                    run={() => api.delete(`/segments/${encodeURIComponent(id)}/members/${encodeURIComponent(c.id)}`)}
                    onDone={() => { drop(); setReload((n) => n + 1); onChanged(); }}
                  />
                )
              : undefined
          }
        />
      </section>

      {/* Used by */}
      <section style={{ display: "grid", gap: 6 }}>
        <div className="mono" style={{ ...SECTION_LABEL, margin: 0 }}>{tx("Used by", "يستخدمه")}</div>
        {d.references.audiences.length === 0 && d.references.campaigns.length === 0 && (
          <div className="muted" style={{ fontSize: 12.5 }}>{tx("Nothing uses this audience yet.", "لا شيء يستخدم هذا الجمهور بعد.")}</div>
        )}
        {d.references.audiences.length > 0 && (
          <div style={{ fontSize: 13 }}>
            <span className="muted">{tx("Audiences: ", "الجماهير: ")}</span>
            {d.references.audiences.map((a, i) => (
              <span key={a.id}>
                {i > 0 ? tx(", ", "، ") : ""}
                <button type="button" className="btn ghost sm" style={{ padding: "0 4px" }} onClick={() => onOpen(a.id)}>
                  <bdi dir="auto">{segName(a, lang)}</bdi>
                </button>
              </span>
            ))}
          </div>
        )}
        {d.references.campaigns.length > 0 && (
          <div style={{ fontSize: 13 }}>
            <span className="muted">{tx("Campaigns: ", "الحملات: ")}</span>
            {d.references.campaigns.map((c, i) => (
              <span key={c.id}>
                {i > 0 ? tx(", ", "، ") : ""}
                <a href={`#/campaigns?id=${encodeURIComponent(c.id)}`}><bdi dir="auto">{c.name}</bdi></a>
                <span className="muted"> ({campaignStatusLabel(c.status as Campaign["status"], tx)})</span>
              </span>
            ))}
          </div>
        )}
      </section>

      {editing && (
        <AudienceSheet
          tx={tx}
          lang={lang}
          mode={smart ? "smart" : "manual"}
          initial={d}
          dependents={d.references.audiences}
          onClose={() => setEditing(false)}
          onSaved={(_row: Segment) => {
            setEditing(false);
            refresh();
          }}
        />
      )}
      {deleting && (
        <AudienceDeleteDialog
          tx={tx}
          lang={lang}
          audience={d}
          initial={audienceDeleteStateFromRefs(d.references)}
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            setDeleting(false);
            onChanged();
            onBack();
          }}
        />
      )}
      {importing && (
        <ImportWizard
          tx={tx}
          lang={lang}
          kind="audience"
          initialGroupId={d.id}
          onClose={(runningId) => {
            setImporting(false);
            if (runningId) setImportWatchId(runningId);
          }}
          onImported={refresh}
        />
      )}
    </div>
  );
}

function MemberAction({ tx, label, icon, run, onDone }: { tx: Tx; label: string; icon: ReactNode; run: () => Promise<unknown>; onDone: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn ghost sm"
      disabled={busy}
      style={{ display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}
      onClick={() => {
        setBusy(true);
        run()
          .then(onDone)
          .catch((e) => toast(isForbidden(e) ? tx(NO_PERMISSION_EN, NO_PERMISSION_AR) : audienceErrorText(e, tx), "error"))
          .finally(() => setBusy(false));
      }}
    >
      {icon} {label}
    </button>
  );
}

function BackLink({ tx, onBack }: { tx: Tx; onBack: () => void }) {
  return (
    <div>
      <button type="button" className="btn ghost sm" onClick={onBack}>
        <span aria-hidden="true">‹</span> {tx("All audiences", "كل الجماهير")}
      </button>
    </div>
  );
}

const PAGE = 50;

/** A keyset-paged contact list (`items`, `nextCursor`) with a debounced search; stale answers are dropped. */
function ContactPager({ tx, lang, base, reloadKey, searchLabel, empty, action }: {
  tx: Tx;
  lang: Lang;
  base: string;
  reloadKey: number;
  searchLabel: string;
  empty: string;
  action?: (c: AudienceContact, drop: () => void) => ReactNode;
}) {
  const [q, setQ] = useState("");
  const dq = useDebouncedValue(q.trim(), 300);
  const [items, setItems] = useState<AudienceContact[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(
    (after: string | null) => {
      const my = ++seq.current;
      const params = new URLSearchParams({ limit: String(PAGE) });
      if (dq) params.set("q", dq);
      if (after) params.set("after", after);
      setLoading(true);
      setError(null);
      api
        .get<AudienceContactsPage>(`${base}?${params.toString()}`)
        .then((page) => {
          if (my !== seq.current) return;
          setItems((prev) => (after ? [...prev, ...page.items] : page.items));
          setCursor(page.nextCursor);
          setTimedOut(page.timedOut);
        })
        .catch((e) => {
          if (my !== seq.current) return;
          setError(e instanceof ApiError && e.status === 403 ? tx(NO_PERMISSION_EN, NO_PERMISSION_AR) : audienceErrorText(e, tx));
        })
        .finally(() => {
          if (my === seq.current) setLoading(false);
        });
    },
    [base, dq, tx],
  );

  useEffect(() => {
    setItems([]);
    setCursor(null);
    load(null);
  }, [load, reloadKey]);

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <input dir="auto" aria-label={searchLabel} placeholder={searchLabel} value={q} onChange={(e) => setQ(e.target.value)} style={{ ...FIELD, height: 34, maxWidth: 360 }} />
      {error && <div role="alert" style={{ fontSize: 12, color: "var(--bad)" }}>{error}</div>}
      {timedOut && (
        <div style={{ fontSize: 12, color: "var(--warn)" }}>
          {tx("This list is too large to load right now. Narrow it with a search.", "القائمة كبيرة جدًا لتحميلها الآن. ضيّقها بالبحث.")}
        </div>
      )}
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {items.length === 0 && !loading && !error && !timedOut && (
          <div className="mono muted" style={{ fontSize: 12, padding: 12 }}>{empty}</div>
        )}
        {items.map((c) => (
          <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderBottom: "1px solid var(--line-soft)" }}>
            <button
              type="button"
              onClick={() => openRecord("contact", c.id)}
              style={{ flex: 1, minWidth: 0, textAlign: "start", background: "transparent", border: 0, padding: 0, cursor: "pointer", color: "var(--ink)", fontSize: 13 }}
            >
              <bdi dir="auto" style={{ fontWeight: 500 }}>{c.name || "—"}</bdi>
              {c.phone && <span className="mono muted" style={{ fontSize: 11, marginInlineStart: 8 }}><bdi dir="ltr">{c.phone}</bdi></span>}
              {c.email && <span className="muted" style={{ fontSize: 11, marginInlineStart: 8 }}><bdi dir="ltr">{c.email}</bdi></span>}
            </button>
            {c.lifecycle && <span className="muted" style={{ fontSize: 11 }}>{lifecycleLabel(tx, c.lifecycle)}</span>}
            {action?.(c, () => setItems((prev) => prev.filter((x) => x.id !== c.id)))}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {loading && <span className="mono muted" style={{ fontSize: 12 }}>{tx("Loading…", "جارٍ التحميل…")}</span>}
        {!loading && cursor && (
          <button type="button" className="btn sm" onClick={() => load(cursor)}>{tx("Load more", "تحميل المزيد")}</button>
        )}
        <span className="muted" style={{ fontSize: 11 }} lang={lang}>
          {items.length > 0 ? tx(`Showing ${items.length.toLocaleString("en-US")}`, `يعرض ${items.length.toLocaleString("en-US")}`) : ""}
        </span>
      </div>
    </div>
  );
}
