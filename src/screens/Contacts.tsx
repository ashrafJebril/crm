import {
  memo,
  useEffect,
  useRef,
  useMemo,
  useState,
  type CSSProperties,
  type DragEvent,
} from "react";
import { NextStepChip, useNextSteps } from "@/components/activities/NextStepChip";
import { ActivityDialog } from "@/components/activities/ActivityDialog";
import { useTweaks } from "@/tweaks/context";
import { makeTx, type Tx } from "@/lib/tx";
import { PageHeader } from "@/components/PageHeader";
import { ResponsiveTable } from "@/components/ResponsiveTable";
import { useViewport } from "@/lib/useViewport";
import { BP } from "@/styles/breakpoints";
import "@/styles/screens/contacts.css";
import { Avatar } from "@/components/Avatar";
import { Badge, type BadgeKind } from "@/components/Badge";
import { IconFilter, IconMore, IconPlus } from "@/icons";
import { api } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import { usePermissions } from "@/auth/usePermissions";
import { getHashParam, setHashParam } from "@/lib/hashState";
import { useOpenParam } from "@/lib/useOpenParam";
import { Pager } from "./contacts/Pager";
import { Modal } from "@/components/Modal";
import type { Contact, CustomFieldDef, Pipeline, Segment, TagRow, TeamMember } from "@/lib/types";
import { ContactDetailDrawer } from "./contacts/ContactDetailDrawer";
import { AudiencesTab } from "./contacts/AudiencesTab";
import { contactsTabFromHash, withContactsTab, type ContactsTabId } from "./contacts/contactsTab";
import { countLabel } from "./contacts/audiences/rulesModel";
import { TagsTab } from "./contacts/TagsTab";
import { FieldsTab } from "./contacts/FieldsTab";
import { NewContactModal } from "./contacts/NewContactModal";
import { ImportWizard, ImportChip } from "./contacts/import/ImportWizard";
import { downloadContactsExport } from "./contacts/import/importApi";
import { exportErrorText } from "./contacts/import/importMessages";
import { ContactFilterBar } from "./contacts/ContactFilterBar";
import { BulkBar, PIPELINE_BULK_CAP, type BulkAction } from "./contacts/BulkBar";
import {
  decodeContactFilter, encodeContactFilter, isEmptyFilter, isSelectAllCurrent, pruneFieldFilters, toQuery,
  type ContactFilter,
} from "./contacts/contactFilter";

type View = "table" | "pipeline";

/** One page of the contacts table from GET /contacts/page. */
interface ContactsPage {
  items: Contact[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

interface BulkResult {
  affected: number;
  created?: number;
  skipped?: number;
  blocked?: string[];
  truncated?: boolean;
}

const INPUT_STYLE: CSSProperties = {
  height: 32,
  padding: "0 10px",
  borderRadius: 8,
  background: "var(--bg-1)",
  border: "1px solid var(--line-soft)",
  color: "var(--ink)",
  fontSize: 13,
  outline: 0,
  fontFamily: "inherit",
};

interface ContactsTableProps {
  tx: Tx;
  contacts: Contact[];
  selected: Set<string>;
  setSelected: (next: Set<string>) => void;
  onOpenContact: (id: string) => void;
  tagColorByName: Map<string, string>;
}

function tagKind(tag: string): BadgeKind {
  if (tag === "VIP") return "warn";
  if (tag === "Hot") return "bad";
  return "";
}

function ContactsTable({
  tx,
  contacts,
  selected,
  setSelected,
  onOpenContact,
  tagColorByName,
}: ContactsTableProps) {
  const pageAll = contacts.length > 0 && contacts.every((c) => selected.has(c.id));
  // One batched request for the whole page.
  const nextSteps = useNextSteps("contactIds", useMemo(() => contacts.map((c) => c.id), [contacts]));
  const { can: canDo } = usePermissions();
  // A ticket-linked next step needs tickets.update; a contact-level one contacts.update.
  const canEditStep = (id: string) => (nextSteps[id]?.ticketId ? canDo("tickets.update") : canDo("contacts.update"));
  const [stepFor, setStepFor] = useState<string | null>(null);
  const togglePage = () => {
    const next = new Set(selected);
    for (const c of contacts) {
      if (pageAll) next.delete(c.id);
      else next.add(c.id);
    }
    setSelected(next);
  };
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  // SP-30: below sm a card list (the table scrolls inside its own container above that).
  const { width } = useViewport();
  if (width < BP.sm) {
    return (
      <div className="ct-cards" role="list" aria-label={tx("Contacts", "جهات الاتصال")}>
        {contacts.map((c) => (
          <div
            key={c.id}
            role="listitem"
            className="ct-card"
            aria-selected={selected.has(c.id)}
            onClick={() => onOpenContact(c.id)}
          >
            <label className="ct-card-check" onClick={(e) => e.stopPropagation()}>
              <input
                type="checkbox"
                aria-label={tx(`Select ${c.name}`, `تحديد ${c.name}`)}
                checked={selected.has(c.id)}
                onChange={() => toggle(c.id)}
              />
            </label>
            <Avatar name={c.name} color={String(150 + (c.id.charCodeAt(1) || 0) * 6)} />
            <div className="ct-card-main">
              <button
                type="button"
                className="ct-card-name"
                style={{ background: "none", border: 0, padding: 0, color: "inherit", font: "inherit", fontWeight: 500, textAlign: "start", cursor: "pointer" }}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenContact(c.id);
                }}
              >
                <bdi>{c.name}</bdi>
              </button>
              <div className="ct-card-meta">
                <span className="mono" dir="ltr">{c.phone}</span>
                <span>·</span>
                <span className="mono">{c.lifecycle}</span>
                {c.tags.slice(0, 2).map((tg) => (
                  <Badge key={tg} kind={tagKind(tg)}>{tg}</Badge>
                ))}
                {c.tags.length > 2 ? <span>+{c.tags.length - 2}</span> : null}
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <ResponsiveTable className="card" style={{ padding: 0 }} label={tx("Contacts table", "جدول جهات الاتصال")}>
      <table className="tbl">
        <thead>
          <tr>
            <th style={{ width: 30 }}>
              <input
                type="checkbox"
                aria-label={tx("Select all on this page", "تحديد كل الصفحة")}
                checked={pageAll}
                onChange={togglePage}
              />
            </th>
            <th>{tx("Name", "الاسم")}</th>
            <th>{tx("Phone", "الهاتف")}</th>
            <th>{tx("Tags", "الوسوم")}</th>
            <th>{tx("Lifecycle", "المرحلة")}</th>
            <th>{tx("Source", "المصدر")}</th>
            <th>{tx("Convs", "محادثات")}</th>
            <th>{tx("Value", "القيمة")}</th>
            <th>{tx("Next step", "الخطوة التالية")}</th>
            <th>{tx("Last seen", "آخر ظهور")}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {contacts.map((c) => (
            <tr
              key={c.id}
              className={selected.has(c.id) ? "selected" : ""}
              onClick={() => onOpenContact(c.id)}
              style={{ cursor: "pointer" }}
            >
              <td onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={selected.has(c.id)}
                  onChange={() => toggle(c.id)}
                />
              </td>
              <td>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Avatar
                    name={c.name}
                    color={String(150 + (c.id.charCodeAt(1) || 0) * 6)}
                  />
                  <div>
                    <div style={{ fontWeight: 500 }}>{c.name}</div>
                    <div className="muted" style={{ fontSize: 11 }}>
                      {c.industry}
                    </div>
                  </div>
                </div>
              </td>
              <td className="mono muted" style={{ fontSize: 12 }}>
                {c.phone}
              </td>
              <td>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {c.tags.map((tg) => {
                    const hue = tagColorByName.get(tg);
                    return hue ? (
                      <span
                        key={tg}
                        style={{
                          fontSize: 11, padding: "2px 8px", borderRadius: 999,
                          background: `hsl(${hue} 70% 45% / 0.15)`,
                          color: `hsl(${hue} 70% 35%)`,
                          border: `1px solid hsl(${hue} 70% 45% / 0.35)`,
                        }}
                      >
                        {tg}
                      </span>
                    ) : (
                      <Badge key={tg} kind={tagKind(tg)}>{tg}</Badge>
                    );
                  })}
                </div>
              </td>
              <td>
                <span className="mono" style={{ fontSize: 12 }}>
                  {c.lifecycle}
                </span>
              </td>
              <td className="muted">{c.source}</td>
              <td className="mono">{c.convs}</td>
              <td className="mono">{c.value}</td>
              <td onClick={(e) => e.stopPropagation()} style={{ maxWidth: 220 }}>
                <NextStepChip step={nextSteps[c.id]} canEdit={canEditStep(c.id)} onClick={() => setStepFor(c.id)} />
              </td>
              <td className="mono muted">{c.lastSeen}</td>
              <td onClick={(e) => e.stopPropagation()}>
                <button className="btn ghost icon sm">
                  <IconMore w={14} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {stepFor && (
        <ActivityDialog
          key={stepFor}
          contactId={stepFor}
          activity={nextSteps[stepFor] ? { id: nextSteps[stepFor]!.activityId, kind: nextSteps[stepFor]!.kind, title: nextSteps[stepFor]!.title, notes: nextSteps[stepFor]!.notes, dueAt: nextSteps[stepFor]!.dueAt, doneAt: null, outcome: nextSteps[stepFor]!.outcome, assigneeId: nextSteps[stepFor]!.assigneeId } : undefined}
          onClose={() => setStepFor(null)}
        />
      )}
    </ResponsiveTable>
  );
}

interface PipelineCard {
  id: string;
  name: string;
  desc: string;
  value: string;
  days: string;
}

type StageId = "new" | "qualified" | "proposal" | "won" | "lost";

interface Stage {
  id: StageId;
  label: string;
  color: string;
  count: number;
}

interface PipelineProps {
  tx: Tx;
  contacts: Contact[];
}

function Pipeline({ tx, contacts }: PipelineProps) {
  const stages: Stage[] = useMemo(
    () => [
      { id: "new", label: tx("New", "جديد"), color: "var(--ink-3)", count: 184 },
      {
        id: "qualified",
        label: tx("Qualified", "مؤهل"),
        color: "var(--info)",
        count: 92,
      },
      { id: "proposal", label: tx("Proposal", "عرض"), color: "var(--accent)", count: 41 },
      { id: "won", label: tx("Won", "فاز"), color: "var(--ok)", count: 28 },
      { id: "lost", label: tx("Lost", "خسر"), color: "var(--bad)", count: 17 },
    ],
    [tx],
  );

  // Seed initial cards from the first ~10 fetched contacts. We bucket them by
  // lifecycle as a heuristic since the backend doesn't yet have a "stage" field.
  const initial = useMemo<Record<StageId, PipelineCard[]>>(() => {
    const empty: Record<StageId, PipelineCard[]> = {
      new: [],
      qualified: [],
      proposal: [],
      won: [],
      lost: [],
    };
    const slice = contacts.slice(0, 10);
    slice.forEach((c) => {
      const lc = c.lifecycle.toLowerCase();
      let stage: StageId = "new";
      if (lc.includes("customer") || lc.includes("patient")) stage = "won";
      else if (lc.includes("lead") && c.tags.includes("Hot")) stage = "qualified";
      else if (lc.includes("lead") && c.tags.includes("Trial")) stage = "qualified";
      else if (lc.includes("lead")) stage = "new";
      empty[stage].push({
        id: c.id,
        name: c.name,
        desc: `${c.industry} · ${c.source}`,
        value: c.value || "—",
        days: c.lastSeen || "—",
      });
    });
    return empty;
  }, [contacts]);

  const [board, setBoard] = useState<Record<StageId, PipelineCard[]>>(initial);
  const [dragging, setDragging] = useState<{ from: StageId; cardId: string } | null>(
    null,
  );
  const [over, setOver] = useState<StageId | null>(null);

  // Re-seed when the source contacts change (e.g. after refetch).
  useEffect(() => {
    setBoard(initial);
  }, [initial]);

  const onDragStart = (from: StageId, cardId: string) => () => {
    setDragging({ from, cardId });
  };

  const onDragOver = (stage: StageId) => (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (over !== stage) setOver(stage);
  };

  const onDrop = (to: StageId) => (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(null);
    if (!dragging) return;
    const { from, cardId } = dragging;
    if (from === to) {
      setDragging(null);
      return;
    }
    setBoard((prev) => {
      const card = prev[from].find((c) => c.id === cardId);
      if (!card) return prev;
      return {
        ...prev,
        [from]: prev[from].filter((c) => c.id !== cardId),
        [to]: [card, ...prev[to]],
      };
    });
    setDragging(null);
  };

  return (
    <div style={{ overflowX: "auto", paddingBottom: 12 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${stages.length}, 280px)`,
          gap: 12,
        }}
      >
        {stages.map((s) => {
          const cards = board[s.id] || [];
          const isOver = over === s.id;
          return (
            <div
              key={s.id}
              onDragOver={onDragOver(s.id)}
              onDragLeave={() => setOver((curr) => (curr === s.id ? null : curr))}
              onDrop={onDrop(s.id)}
              style={{
                background: isOver ? "var(--accent-soft)" : "var(--bg-1)",
                border: `1px solid ${isOver ? "var(--accent-ring)" : "var(--line-soft)"}`,
                borderRadius: 12,
                display: "flex",
                flexDirection: "column",
                transition: "background 0.12s, border-color 0.12s",
              }}
            >
              <div
                style={{
                  padding: "12px 14px",
                  borderBottom: "1px solid var(--line-soft)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    background: s.color,
                  }}
                />
                <span style={{ fontWeight: 500, fontSize: 13 }}>{s.label}</span>
                <span
                  className="mono"
                  style={{
                    fontSize: 11,
                    color: "var(--ink-3)",
                    marginInlineStart: "auto",
                  }}
                >
                  {cards.length || s.count}
                </span>
                <button className="btn ghost icon sm">
                  <IconPlus w={12} />
                </button>
              </div>
              <div
                style={{
                  padding: 8,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  minHeight: 200,
                }}
              >
                {cards.map((card, i) => (
                  <div
                    key={card.id}
                    draggable
                    onDragStart={onDragStart(s.id, card.id)}
                    style={{
                      background: "var(--bg-elev)",
                      border: "1px solid var(--line-soft)",
                      borderRadius: 8,
                      padding: 10,
                      cursor: "grab",
                      boxShadow: "var(--shadow-sm)",
                      opacity:
                        dragging?.from === s.id && dragging?.cardId === card.id
                          ? 0.4
                          : 1,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <Avatar
                        name={card.name}
                        color={String(120 + i * 30)}
                        size="sm"
                      />
                      <span style={{ fontWeight: 500, fontSize: 13, flex: 1 }}>
                        {card.name}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>
                      {card.desc}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        marginTop: 8,
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                      }}
                    >
                      <span style={{ color: "var(--accent)", fontWeight: 500 }}>
                        {card.value}
                      </span>
                      <span style={{ color: "var(--ink-3)" }}>{card.days}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ContactsImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  // SP-16: the tab lives in the hash (`ct`); the old `ct=groups` link opens Audiences.
  const [activeTab, setActiveTabState] = useState<ContactsTabId>(() => contactsTabFromHash(window.location.hash));
  const setActiveTab = (tab: ContactsTabId) => {
    setActiveTabState(tab);
    const next = withContactsTab(window.location.hash, tab);
    if (next !== window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search + next);
    }
  };
  useEffect(() => {
    const on = () => setActiveTabState(contactsTabFromHash(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const [view, setView] = useState<View>("table");
  const [selected, setSelected] = useState<Set<string>>(new Set<string>());
  const [showNew, setShowNew] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importWatchId, setImportWatchId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const { can } = usePermissions();
  const canManageFields = can("settings.manage");
  const [filter, setFilterState] = useState<ContactFilter>(() =>
    decodeContactFilter(getHashParam(window.location.hash, "cf")),
  );
  // Persist the filter in the hash query without triggering hash navigation.
  const setFilter = (f: ContactFilter) => {
    setFilterState(f);
    const next = setHashParam(window.location.hash, "cf", isEmptyFilter(f) ? null : encodeContactFilter(f));
    if (next !== window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search + next);
    }
  };
  const [selectingAll, setSelectingAll] = useState(false);
  const [truncated, setTruncated] = useState(false);
  // True when the selection came from "select all matching": the export then sends only the filter.
  const [selectionIsAll, setSelectionIsAll] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<
    null | { stage: "confirm" } | { stage: "blocked"; blocked: string[]; deleted: number }
  >(null);
  const [pipelineConfirm, setPipelineConfirm] = useState<Extract<BulkAction, { op: "addToPipeline" }> | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [openContactId, setOpenContactId] = useState<string | null>(null);
  // Deep link from a notification: `#/contacts?open=<contactId>`.
  useOpenParam("contacts", setOpenContactId);

  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  // Search runs on the server; wait for a pause in typing before asking.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(id);
  }, [search]);
  const filterExtras = { q: debouncedSearch, segmentId: activeSegmentId };
  const filterQuery = toQuery(filter, filterExtras).toString();
  // Any change to what's being listed starts again from the first page.
  useEffect(() => setPage(1), [filterQuery, pageSize]);
  const queryRef = useRef(filterQuery);
  queryRef.current = filterQuery;
  // Bumped on every selection change so a late select-all response can be discarded.
  const selVersionRef = useRef(0);
  /** The only way the selection changes: bumps the version so an in-flight select-all can't overwrite it. */
  const setSelection = (next: Set<string>, nextTruncated = false, fromSelectAll = false) => {
    selVersionRef.current++;
    setSelected(next);
    setTruncated(nextTruncated);
    setSelectionIsAll(fromSelectAll);
  };
  // A selection (esp. "all matching") belongs to the listing it was made on.
  useEffect(() => {
    setSelection(new Set<string>());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterQuery]);

  const pageParams = toQuery(filter, filterExtras);
  pageParams.set("page", String(page));
  pageParams.set("pageSize", String(pageSize));
  const {
    data,
    loading,
    error,
    refetch: refetchPage,
  } = useFetch<ContactsPage>(`/contacts/page?${pageParams.toString()}`);
  const contacts = data?.items ?? [];
  // A delete can leave the current page empty; step back to the last one.
  useEffect(() => {
    if (data && page > data.pageCount) setPage(data.pageCount);
  }, [data, page]);

  const statsQ = useFetch<{ total: number; leads: number; customers: number }>("/contacts/stats");

  const {
    data: segmentsData,
    refetch: refetchSegments,
  } = useFetch<Segment[]>("/segments");
  const segments = segmentsData ?? [];
  // A chip whose audience was deleted (Audiences tab) would 404 the listing: fall back to everyone.
  useEffect(() => {
    if (activeSegmentId && segmentsData && !segmentsData.some((s) => s.id === activeSegmentId)) setActiveSegmentId(null);
  }, [segmentsData, activeSegmentId]);
  const manualGroups = useMemo(
    () => segments.filter((s) => s.origin === "manual"),
    [segments],
  );

  const teamQ = useFetch<TeamMember[]>("/team");
  const pipelinesQ = useFetch<Pipeline[]>("/pipelines");
  const fieldDefsQ = useFetch<CustomFieldDef[]>("/custom-fields");
  // A stale `cf` in the hash may reference deleted fields; the API would 404 on every load.
  useEffect(() => {
    if (!fieldDefsQ.data) return;
    const pruned = pruneFieldFilters(filter, new Set(fieldDefsQ.data.filter((d) => !d.archivedAt).map((d) => d.id)));
    if (pruned !== filter) setFilter(pruned);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldDefsQ.data, filter]);
  const tagsQ = useFetch<TagRow[]>("/tags");
  const tagColorByName = useMemo(
    () => new Map((tagsQ.data ?? []).map((t) => [t.name, t.color])),
    [tagsQ.data],
  );

  const allCount = statsQ.data?.total ?? 0;
  const refetch = () => {
    refetchPage();
    statsQ.refetch();
  };

  // A contact edited or deleted from the record sheet: refetch the list behind it.
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  useEffect(() => {
    const onChanged = () => refetchRef.current();
    window.addEventListener("record:changed", onChanged);
    return () => window.removeEventListener("record:changed", onChanged);
  }, []);

  const showStatus = (msg: string) => {
    setStatusMsg(msg);
    window.setTimeout(() => setStatusMsg(null), 2000);
  };

  const [bulkTagMode, setBulkTagMode] = useState<"add" | "remove" | null>(null);
  const [bulkTagging, setBulkTagging] = useState(false);

  const applyBulkTags = (names: string[]) => {
    if (selected.size === 0 || bulkTagging || selectingAll || !bulkTagMode) return;
    if (names.length === 0) {
      setBulkTagMode(null);
      return;
    }
    const mode = bulkTagMode;
    setBulkTagging(true);
    const run = async () => {
      try {
        const ids = Array.from(selected);
        let removed = ids.length;
        if (mode === "add") {
          await api.post<{ contactsUpdated: number }>("/tags/assign", { contactIds: ids, add: names });
        } else {
          removed = (await api.post<BulkResult>("/contacts/bulk", { ids, op: "removeTags", names })).affected;
        }
        setBulkTagMode(null);
        setSelection(new Set<string>());
        refetch();
        tagsQ.refetch();
        showStatus(
          mode === "add"
            ? tx(`Tagged ${ids.length} contact${ids.length === 1 ? "" : "s"}.`, `تم وسم ${ids.length} جهة.`)
            : tx(`Removed tags from ${removed} contact${removed === 1 ? "" : "s"}.`, `تمت إزالة الوسوم من ${removed} جهة.`),
        );
      } catch (err) {
        showStatus(err instanceof Error ? err.message : tx("Tag failed.", "فشل الوسم."));
      } finally {
        setBulkTagging(false);
      }
    };
    void run();
  };

  const EXPORT_IDS_CAP = 10_000;
  const runExport = () => {
    if (exporting) return;
    setExporting(true);
    // The current filter, narrowed to the selection when rows are selected.
    downloadContactsExport(filterQuery, Array.from(selected), selectionIsAll)
      .catch((err) => showStatus(exportErrorText(err, tx)))
      .finally(() => setExporting(false));
  };

  const selectAllMatching = () => {
    if (selectingAll) return;
    setSelectingAll(true);
    setBulkError(null);
    const start = { query: filterQuery, selectionVersion: selVersionRef.current };
    api
      .get<{ ids: string[]; total: number; truncated: boolean }>(`/contacts/ids?${filterQuery}`)
      .then((r) => {
        // Ignore a response for a listing/selection that has since changed.
        if (!isSelectAllCurrent(start, { query: queryRef.current, selectionVersion: selVersionRef.current })) return;
        setSelection(new Set(r.ids), r.truncated, true);
      })
      .catch((err) => setBulkError(err instanceof Error ? err.message : tx("Request failed", "فشل الطلب")))
      .finally(() => setSelectingAll(false));
  };

  const handleBulkAction = (a: BulkAction) => {
    if (selected.size === 0 || bulkBusy || selectingAll) return;
    if (a.op === "removeTags") {
      setBulkTagMode("remove");
      return;
    }
    if (a.op === "addToPipeline") {
      // Each new ticket can start automations: confirm first, and never above the cap.
      if (selected.size > PIPELINE_BULK_CAP) return;
      setPipelineConfirm(a);
      return;
    }
    runBulkAction(a);
  };

  const runBulkAction = (a: BulkAction) => {
    if (selected.size === 0 || bulkBusy || selectingAll) return;
    setBulkBusy(true);
    setBulkError(null);
    api
      .post<BulkResult>("/contacts/bulk", { ids: Array.from(selected), ...a })
      .then((res) => {
        setSelection(new Set<string>());
        refetch();
        if (a.op === "addToGroup") refetchSegments();
        showStatus(
          a.op === "addToPipeline"
            ? tx(`Added ${res.created ?? res.affected} · skipped ${res.skipped ?? 0}`, `تمت الإضافة ${res.created ?? res.affected} · تم تخطي ${res.skipped ?? 0}`)
            : tx(`Updated ${res.affected} contact${res.affected === 1 ? "" : "s"}.`, `تم تحديث ${res.affected} جهة.`),
        );
      })
      .catch((err) => setBulkError(err instanceof Error ? err.message : tx("Request failed", "فشل الطلب")))
      .finally(() => {
        setBulkBusy(false);
        setPipelineConfirm(null);
      });
  };

  const runDelete = (ids: string[], force: boolean) => {
    if (ids.length === 0 || bulkDeleting || selectingAll) return;
    setBulkDeleting(true);
    setBulkError(null);
    api
      .post<BulkResult>("/contacts/bulk", { ids, op: "delete", ...(force ? { force: true } : {}) })
      .then((res) => {
        const blocked = res.blocked ?? [];
        // Keep only the blocked contacts selected so "Delete anyway" can target them.
        setSelection(new Set(blocked));
        refetch();
        if (blocked.length > 0) {
          setDeleteDialog({ stage: "blocked", blocked, deleted: res.affected });
        } else {
          setDeleteDialog(null);
          showStatus(tx(`Deleted ${res.affected} contact${res.affected === 1 ? "" : "s"}.`, `تم حذف ${res.affected} جهة.`));
        }
      })
      .catch((err) => {
        setDeleteDialog(null);
        setBulkError(err instanceof Error ? err.message : tx("Delete failed.", "فشل الحذف."));
      })
      .finally(() => setBulkDeleting(false));
  };

  return (
    <div className="ct-page">
      <PageHeader
        title={tx("Contacts", "جهات الاتصال")}
        subtitle={
          statsQ.data
            ? tx(
                `${statsQ.data.total.toLocaleString()} contacts · ${statsQ.data.leads.toLocaleString()} leads · ${statsQ.data.customers.toLocaleString()} customers`,
                `${statsQ.data.total.toLocaleString("ar")} جهة · ${statsQ.data.leads.toLocaleString("ar")} عميل محتمل · ${statsQ.data.customers.toLocaleString("ar")} عميل`,
              )
            : tx("Loading…", "جارٍ التحميل…")
        }
        actions={
          <>
            <div
              style={{
                display: "flex",
                border: "1px solid var(--line)",
                borderRadius: 8,
                padding: 2,
              }}
            >
              <button
                onClick={() => setView("table")}
                style={{
                  background: view === "table" ? "var(--bg-2)" : "transparent",
                  border: 0,
                  padding: "0 10px",
                  height: 26,
                  borderRadius: 6,
                  color: "inherit",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                {tx("Table", "جدول")}
              </button>
              <button
                onClick={() => setView("pipeline")}
                style={{
                  background: view === "pipeline" ? "var(--bg-2)" : "transparent",
                  border: 0,
                  padding: "0 10px",
                  height: 26,
                  borderRadius: 6,
                  color: "inherit",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                {tx("Pipeline", "المسار")}
              </button>
            </div>
            <ImportChip tx={tx} watchId={importWatchId} onFinished={() => { setImportWatchId(null); refetch(); }} />
            <button
              className="btn"
              onClick={() => setShowImport(true)}
              disabled={!can("contacts.create")}
              title={can("contacts.create") ? undefined : tx("You don't have permission to do this", "ليست لديك صلاحية للقيام بذلك")}
            >
              {tx("Import", "استيراد")}
            </button>
            <button
              className="btn"
              onClick={runExport}
              disabled={!can("contacts.manage") || exporting || selected.size > EXPORT_IDS_CAP}
              title={
                !can("contacts.manage")
                  ? tx("Only owners and admins can export", "التصدير متاح للمالكين والمسؤولين فقط")
                  : selected.size > EXPORT_IDS_CAP
                    ? tx("Select at most 10,000 contacts to export", "حدد 10,000 جهة كحد أقصى للتصدير")
                    : undefined
              }
            >
              {exporting
                ? tx("Exporting…", "جارٍ التصدير…")
                : selected.size > 0
                  ? tx(`Export selected (${selected.size.toLocaleString()})`, `تصدير المحدد (${selected.size.toLocaleString("ar")})`)
                  : tx("Export", "تصدير")}
            </button>
            <button className="btn primary" onClick={() => setShowNew(true)} disabled={!can("contacts.create")} title={can("contacts.create") ? undefined : tx("You don't have permission to do this", "ليست لديك صلاحية للقيام بذلك")}>
              <IconPlus w={13} />
              {tx("New contact", "جهة جديدة")}
            </button>
          </>
        }
      />

      <div className="ct-tabs">
        {(
          [
            ["contacts", tx("Contacts", "جهات الاتصال")],
            ["audiences", tx("Audiences", "الجماهير")],
            ["tags", tx("Tags", "الوسوم")],
            ...(canManageFields ? ([["fields", tx("Fields", "الحقول")]] as const) : []),
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`btn sm ${activeTab === id ? "primary" : "ghost"}`.trim()}
            onClick={() => setActiveTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === "contacts" && (
      <div className="ct-body">
        <div className="ct-seg-row">
          {/* Below sm the segment chips scroll in their own row. */}
          <div className="ct-seg-chips">
          <SegmentChip
            label={tx("All", "الكل")}
            count={allCount}
            tx={tx}
            active={activeSegmentId === null}
            onClick={() => setActiveSegmentId(null)}
          />
          {segments.map((s) => (
            <SegmentChip
              key={s.id}
              label={t.lang === "ar" ? s.nameAr || s.name : s.name}
              count={s.count}
              timedOut={s.timedOut}
              skipped={s.skipped}
              tx={tx}
              active={activeSegmentId === s.id}
              color={s.color}
              onClick={() => setActiveSegmentId(s.id)}
            />
          ))}
          </div>
          <span className="ct-seg-spacer" style={{ flex: 1 }} />
          <button
            className="btn ghost sm"
            onClick={() => setActiveTab("audiences")}
          >
            <IconFilter w={12} />
            {tx("Manage audiences", "إدارة الجماهير")}
          </button>
          <input
            placeholder={tx("Search contacts…", "ابحث…")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="ct-search"
            style={INPUT_STYLE}
          />
        </div>

        <ContactFilterBar
          tx={tx}
          lang={t.lang}
          filter={filter}
          onChange={setFilter}
          tags={tagsQ.data ?? []}
          team={teamQ.data ?? []}
          pipelines={pipelinesQ.data ?? []}
          fieldDefs={fieldDefsQ.data ?? []}
        />

        {statusMsg && (
          <div
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              background: "var(--accent-soft)",
              color: "var(--accent)",
              fontSize: 12,
              border: "1px solid var(--accent-ring)",
            }}
          >
            {statusMsg}
          </div>
        )}

        {error && !loading && !data && (
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

        {loading && !data && (
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

        {data && view === "table" && selected.size > 0 && (
          <BulkBar
            tx={tx}
            lang={t.lang}
            count={selected.size}
            totalMatching={data.total}
            pageAllSelected={contacts.length > 0 && contacts.every((c) => selected.has(c.id))}
            selectingAll={selectingAll}
            truncated={truncated}
            busy={bulkBusy || bulkDeleting || selectingAll}
            team={teamQ.data ?? []}
            pipelines={pipelinesQ.data ?? []}
            manualGroups={manualGroups}
            error={bulkError}
            onSelectAllMatching={selectAllMatching}
            onClear={() => setSelection(new Set<string>())}
            onTag={() => setBulkTagMode("add")}
            onRemoveTag={() => setBulkTagMode("remove")}
            onDelete={() => setDeleteDialog({ stage: "confirm" })}
            onAction={handleBulkAction}
          />
        )}
        {data && view === "table" && (
          <ContactsTable
            tx={tx}
            contacts={contacts}
            selected={selected}
            setSelected={(next) => setSelection(next)}
            onOpenContact={setOpenContactId}
            tagColorByName={tagColorByName}
          />
        )}
        {data && view === "table" && (
          <Pager
            tx={tx}
            page={data.page}
            pageCount={data.pageCount}
            pageSize={pageSize}
            total={data.total}
            onPage={setPage}
            onPageSize={setPageSize}
            busy={loading}
          />
        )}
        {data && view === "pipeline" && (
          <Pipeline tx={tx} contacts={contacts} />
        )}
      </div>
      )}

      {activeTab === "audiences" && (
        <AudiencesTab
          tx={tx}
          lang={t.lang}
          onChanged={() => {
            refetchSegments();
            refetch();
          }}
        />
      )}
      {activeTab === "tags" && (
        <TagsTab
          tx={tx}
          lang={t.lang}
          onCatalogChanged={() => {
            tagsQ.refetch();
            refetchSegments();
            refetch();
          }}
        />
      )}

      {activeTab === "fields" && canManageFields && (
        <FieldsTab
          tx={tx}
          lang={t.lang}
          onChanged={() => {
            void fieldDefsQ.refetch();
            refetch();
          }}
        />
      )}

      {showImport && (
        <ImportWizard
          tx={tx}
          lang={t.lang}
          kind="contacts"
          onClose={(runningId) => {
            setShowImport(false);
            if (runningId) setImportWatchId(runningId);
          }}
          onImported={() => {
            setActiveSegmentId(null);
            refetch();
            refetchSegments();
          }}
        />
      )}

      {showNew && (
        <NewContactModal
          tx={tx}
          onClose={() => setShowNew(false)}
          onCreated={() => {
            refetch();
            showStatus(tx("Contact created.", "تم إنشاء جهة الاتصال."));
          }}
        />
      )}

      {bulkTagMode && (
        <BulkTagModal
          tx={tx}
          mode={bulkTagMode}
          count={selected.size}
          saving={bulkTagging}
          tags={tagsQ.data ?? []}
          onClose={() => setBulkTagMode(null)}
          onApply={applyBulkTags}
        />
      )}

      {pipelineConfirm && (
        <PipelineConfirmModal
          tx={tx}
          count={selected.size}
          pipelineName={(() => {
            const pl = (pipelinesQ.data ?? []).find((x) => x.id === pipelineConfirm.pipelineId);
            return pl ? (t.lang === "ar" ? pl.nameAr || pl.name : pl.name) : "";
          })()}
          busy={bulkBusy}
          onCancel={() => setPipelineConfirm(null)}
          onConfirm={() => runBulkAction(pipelineConfirm)}
        />
      )}

      {deleteDialog && (
        <Modal
          onClose={bulkDeleting ? () => {} : () => setDeleteDialog(null)}
          width={420}
          label={tx("Delete contacts", "حذف جهات الاتصال")}
          panelStyle={{ display: "flex", flexDirection: "column", gap: 12 }}
        >
          {deleteDialog.stage === "confirm" ? (
            <>
              <h3 style={{ margin: 0, fontSize: 15 }}>{tx("Delete selected contacts?", "حذف جهات الاتصال المحددة؟")}</h3>
              <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>
                {tx(
                  `${selected.size.toLocaleString()} contact(s) will be deleted, along with their conversations. Contacts with linked tickets or bookings are skipped unless you choose to delete them anyway.`,
                  `سيتم حذف ${selected.size.toLocaleString("ar")} جهة مع محادثاتها. تُتخطى الجهات المرتبطة بتذاكر أو حجوزات ما لم تختر حذفها رغم ذلك.`,
                )}
              </div>
            </>
          ) : (
            <>
              <h3 style={{ margin: 0, fontSize: 15 }}>{tx("Some contacts were not deleted", "لم تُحذف بعض الجهات")}</h3>
              <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>
                {tx(
                  `Deleted ${deleteDialog.deleted}. ${deleteDialog.blocked.length} contact(s) are linked to tickets or bookings and were kept. Delete them anyway? Their conversations and linked records are removed too. This cannot be undone.`,
                  `تم حذف ${deleteDialog.deleted}. ${deleteDialog.blocked.length} جهة مرتبطة بتذاكر أو حجوزات وتم الإبقاء عليها. هل تريد حذفها رغم ذلك؟ ستُحذف محادثاتها وسجلاتها المرتبطة أيضًا. لا يمكن التراجع.`,
                )}
              </div>
            </>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="btn ghost" disabled={bulkDeleting} onClick={() => setDeleteDialog(null)}>
              {deleteDialog.stage === "confirm" ? tx("Cancel", "إلغاء") : tx("Keep them", "إبقاؤها")}
            </button>
            <button
              type="button"
              className="btn"
              style={{ background: "var(--bad)", color: "white", borderColor: "transparent" }}
              disabled={bulkDeleting}
              onClick={() =>
                deleteDialog.stage === "confirm"
                  ? runDelete(Array.from(selected), false)
                  : runDelete(deleteDialog.blocked, true)
              }
            >
              {bulkDeleting
                ? tx("Deleting…", "جارٍ الحذف…")
                : deleteDialog.stage === "confirm"
                  ? tx("Delete", "حذف")
                  : tx("Delete anyway", "حذف رغم ذلك")}
            </button>
          </div>
        </Modal>
      )}

      {openContactId && (
        <ContactDetailDrawer
          contactId={openContactId}
          onClose={() => setOpenContactId(null)}
          onChanged={refetch}
        />
      )}

    </div>
  );
}

/* ─── Segment chip helper ───────────────────────────────────────────── */

interface SegmentChipProps {
  label: string;
  /** SP-16: null while a smart audience's count is unknown (never shown as 0). */
  count: number | null;
  timedOut?: boolean;
  skipped?: boolean;
  tx: Tx;
  active: boolean;
  color?: string | null;
  onClick: () => void;
}

function SegmentChip({ label, count, timedOut, skipped, tx, active, color, onClick }: SegmentChipProps) {
  const c = countLabel(count, timedOut, tx, skipped);
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 11px",
        borderRadius: 999,
        fontSize: 12,
        border: `1px solid ${active ? "var(--accent-ring)" : "var(--line-soft)"}`,
        background: active ? "var(--accent-soft)" : "transparent",
        color: active ? "var(--accent)" : "var(--ink-1)",
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      {color && (
        <span
          style={{
            display: "inline-block",
            width: 6,
            height: 6,
            borderRadius: 999,
            background: `oklch(0.7 0.15 ${color})`,
          }}
        />
      )}
      <bdi dir="auto">{label}</bdi>
      <span
        className="mono muted"
        title={c.title}
        style={{
          fontSize: 10,
          color: active ? "var(--accent)" : "var(--ink-3)",
        }}
      >
        {c.short}
      </span>
    </button>
  );
}

/* ─── Add-to-pipeline confirm ────────────────────────────────────────── */

function PipelineConfirmModal({ tx, count, pipelineName, busy, onCancel, onConfirm }: {
  tx: Tx;
  count: number;
  pipelineName: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // The pipeline name is user text: isolate it so its direction can't scramble the sentence.
  const [before, after] = tx(
    `Create ${count.toLocaleString()} tickets in {p}? Each new ticket can start automations.`,
    `إنشاء ${count.toLocaleString("ar")} تذكرة في {p}؟ قد تبدأ كل تذكرة جديدة عمليات أتمتة.`,
  ).split("{p}");
  return (
    <Modal onClose={busy ? () => {} : onCancel} width={420} label={tx("Add to pipeline", "إضافة إلى مسار")}
      panelStyle={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>{tx("Add to pipeline", "إضافة إلى مسار")}</h3>
      <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>
        {before}<bdi dir="auto">{pipelineName}</bdi>{after}
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" className="btn ghost" disabled={busy} onClick={onCancel}>{tx("Cancel", "إلغاء")}</button>
        <button type="button" className="btn primary" disabled={busy} onClick={onConfirm}>
          {busy ? tx("Creating…", "جارٍ الإنشاء…") : tx("Create tickets", "إنشاء التذاكر")}
        </button>
      </div>
    </Modal>
  );
}

/* ─── Bulk tag modal ─────────────────────────────────────────────────── */

interface BulkTagModalProps {
  tx: Tx;
  mode: "add" | "remove";
  count: number;
  saving: boolean;
  tags: TagRow[];
  onClose: () => void;
  onApply: (selectedNames: string[]) => void;
}

function BulkTagModal({ tx, mode, count, saving, tags, onClose, onApply }: BulkTagModalProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [customNames, setCustomNames] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const canSubmit = selected.size > 0 && !saving;

  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const addDraft = () => {
    const name = draft.trim();
    if (!name) return;
    if (!customNames.includes(name) && !tags.some((t) => t.name === name)) {
      setCustomNames((prev) => [...prev, name]);
    }
    setSelected((prev) => new Set(prev).add(name));
    setDraft("");
  };

  const chipStyle = (hue: string | null, isSelected: boolean): CSSProperties =>
    isSelected
      ? {
          background: hue ? `hsl(${hue} 70% 45%)` : "var(--accent)",
          color: "#fff",
          border: `1px solid ${hue ? `hsl(${hue} 70% 40%)` : "var(--accent)"}`,
        }
      : {
          background: hue ? `hsl(${hue} 70% 45% / 0.12)` : "transparent",
          color: hue ? `hsl(${hue} 70% 35%)` : "var(--ink-2)",
          border: `1px solid ${hue ? `hsl(${hue} 70% 45% / 0.35)` : "var(--line-soft)"}`,
        };

  return (
    <Modal onClose={onClose} width={420} label={mode === "add" ? tx("Add tags", "إضافة وسوم") : tx("Remove tags", "إزالة وسوم")} panelStyle={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>
            {mode === "add" ? tx("Add tags", "إضافة وسوم") : tx("Remove tags", "إزالة وسوم")}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
            {mode === "add"
              ? tx(`Add tags to ${count} contact${count === 1 ? "" : "s"}.`, `إضافة وسوم إلى ${count} جهة.`)
              : tx(`Remove tags from ${count} contact${count === 1 ? "" : "s"}.`, `إزالة وسوم من ${count} جهة.`)}
          </div>
        </div>

        <div>
          <label
            className="mono muted"
            style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.06 }}
          >
            {tx("Tags", "الوسوم")}
          </label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            {tags.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => toggle(t.name)}
                style={{
                  ...chipStyle(t.color, selected.has(t.name)),
                  fontSize: 12,
                  padding: "4px 10px",
                  borderRadius: 999,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                {t.name}
              </button>
            ))}
            {customNames.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => toggle(name)}
                style={{
                  ...chipStyle(null, selected.has(name)),
                  fontSize: 12,
                  padding: "4px 10px",
                  borderRadius: 999,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                {name}
                <span style={{ fontSize: 10, opacity: 0.75 }}>
                  {tx("new", "جديد")}
                </span>
              </button>
            ))}
            {tags.length === 0 && customNames.length === 0 && (
              <span className="muted" style={{ fontSize: 12 }}>
                {tx("No tags yet — create one below.", "لا توجد وسوم بعد — أنشئ واحدًا أدناه.")}
              </span>
            )}
          </div>
        </div>

        {mode === "add" && <div>
          <label
            className="mono muted"
            style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.06 }}
          >
            {tx("Quick-create", "إنشاء سريع")}
          </label>
          <input
            type="text"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addDraft();
              }
              if (e.key === "Escape") onClose();
            }}
            placeholder={tx("Type a name and press Enter…", "اكتب اسمًا واضغط Enter…")}
            style={{
              width: "100%",
              marginTop: 6,
              padding: "9px 11px",
              borderRadius: 8,
              border: "1px solid var(--line)",
              background: "var(--bg)",
              color: "var(--ink-1)",
              fontSize: 13,
              fontFamily: "inherit",
              outline: "none",
            }}
          />
        </div>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn" type="button" onClick={onClose} disabled={saving}>
            {tx("Cancel", "إلغاء")}
          </button>
          <button
            className="btn primary"
            type="button"
            onClick={() => onApply(Array.from(selected))}
            disabled={!canSubmit}
          >
            {saving ? tx("Applying…", "جارٍ التطبيق…") : mode === "add" ? tx("Apply", "تطبيق") : tx("Remove", "إزالة")}
          </button>
        </div>
    </Modal>
  );
}

const Contacts = memo(ContactsImpl);
export default Contacts;
