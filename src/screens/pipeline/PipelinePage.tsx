import { useCallback, useEffect, useMemo, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { usePipelines, usePipelineSummary } from "./hooks/usePipelineData";
import { useTicketRealtime } from "./hooks/useTicketRealtime";
import { PipelineHeader } from "./PipelineHeader";
import { PipelineBoard } from "./PipelineBoard";
import { TicketDetailDrawer } from "./TicketDetailDrawer";
import { useOpenParam } from "@/lib/useOpenParam";
import { openRecord } from "@/lib/openRecord";
import { useQueryClient } from "@tanstack/react-query";
import { NewTicketModal } from "./NewTicketModal";
import { PipelineTable } from "./PipelineTable";
import { useLocalDayKey } from "./hooks/useLocalDayKey";
import { usePermissions } from "@/auth/usePermissions";
import { BoardFilters } from "./BoardFilters";
import { BoardBulkBar } from "./BoardBulkBar";
import {
  DEFAULT_SORT,
  decodeBoardFilters,
  encodeBoardFilters,
  filtersActive,
  nextSort,
  scopeToPipeline,
  toQuery,
  type BoardFilters as Filters,
  type Sort,
} from "./boardQuery";
import { getHashParam, setHashParam } from "@/lib/hashState";
import { makeTx } from "@/lib/tx";
import { useTeam, useWorkspaceTz } from "@/components/activities/activityApi";
import type { Ticket } from "@/lib/types";
import { slaShownFor } from "./ticketSla";

const LAST_USED_KEY = "pipeline:lastUsed";

export default function PipelinePage() {
  const { t } = useTweaks();
  const lang = t.lang;
  const { data: pipelines = [], isLoading } = usePipelines();

  const initialPipelineId =
    (typeof localStorage !== "undefined" && localStorage.getItem(LAST_USED_KEY)) ||
    pipelines[0]?.id ||
    "";

  const [pipelineId, setPipelineId] = useState<string>(initialPipelineId);

  // No selection, or the remembered pipeline is gone/archived: fall back to the first one.
  useEffect(() => {
    if (pipelines.length === 0) return;
    if (!pipelineId || !pipelines.some((p) => p.id === pipelineId)) {
      setPipelineId(pipelines[0].id);
    }
  }, [pipelines, pipelineId]);

  useEffect(() => {
    if (pipelineId && (pipelines.length === 0 || pipelines.some((p) => p.id === pipelineId))) localStorage.setItem(LAST_USED_KEY, pipelineId);
  }, [pipelineId, pipelines]);

  const { data: summary } = usePipelineSummary(pipelineId || null);
  useTicketRealtime(pipelineId || null);

  // A record deleted or edited from the record sheet: refetch the board behind it.
  const qc = useQueryClient();
  useEffect(() => {
    const onChanged = () => {
      void qc.invalidateQueries({ queryKey: ["tickets"] });
    };
    window.addEventListener("record:changed", onChanged);
    return () => window.removeEventListener("record:changed", onChanged);
  }, [qc]);

  const tx = makeTx(lang);
  const tz = useWorkspaceTz();
  const team = useTeam();

  // View and filters live in the hash (?pv=table, ?pf=<base64 json>) so a reload or link keeps them.
  const [view, setView] = useState<"board" | "table">(() =>
    getHashParam(window.location.hash, "pv") === "table" ? "table" : "board",
  );
  const [filters, setFilters] = useState<Filters>(() => decodeBoardFilters(getHashParam(window.location.hash, "pf")));
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [search, setSearch] = useState(filters.q);
  useEffect(() => {
    const h = window.setTimeout(() => setFilters((f) => (f.q === search ? f : { ...f, q: search })), 250);
    return () => window.clearTimeout(h);
  }, [search]);
  useEffect(() => {
    let h = window.location.hash;
    h = setHashParam(h, "pv", view === "table" ? "table" : null);
    h = setHashParam(h, "pf", filtersActive(filters) ? encodeBoardFilters(filters) : null);
    if (h !== window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search + h);
    }
  }, [view, filters]);

  const { can } = usePermissions();
  // "Today"-relative presets must not freeze while the page stays open past midnight.
  const dayKey = useLocalDayKey(tz);
  // Final review I1: the SLA filter, sort, column and chips are support-only.
  const pipelineKind = (pipelines.find((p) => p.id === pipelineId) ?? pipelines[0])?.kind;
  const showSla = slaShownFor(pipelineKind);
  const scoped = useMemo(() => scopeToPipeline(filters, sort, pipelineKind), [filters, sort, pipelineKind]);
  const filterQs = useMemo(() => toQuery(scoped.filters, null, { now: new Date(), tz }), [scoped.filters, tz, dayKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const tableQs = useMemo(() => toQuery(scoped.filters, scoped.sort, { now: new Date(), tz }), [scoped, tz, dayKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bulk selection (cards and table rows). Anything that changes the visible set clears it.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const clearSelection = useCallback(() => setSelected(new Set()), []);
  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const toggleAll = useCallback((ids: string[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);
  useEffect(clearSelection, [pipelineId, view, filterQs, clearSelection]);

  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [showNew, setShowNew] = useState(false);
  // Deep link from a notification: `#/pipeline?open=<ticketId>`.
  const [deepTicketId, setDeepTicketId] = useState<string | null>(null);
  useOpenParam("pipeline", (id) => {
    setSelectedTicket(null);
    setDeepTicketId(id);
  });

  // Keyboard shortcuts: N = new, / = search focus, Esc = close drawer/modal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showNew) setShowNew(false);
        else if (selectedTicket || deepTicketId) {
          setSelectedTicket(null);
          setDeepTicketId(null);
        }
        return;
      }
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        setShowNew(true);
      } else if (e.key === "/") {
        e.preventDefault();
        document.querySelector<HTMLInputElement>("[data-pipeline-search]")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showNew, selectedTicket, deepTicketId]);

  const pipeline = pipelines.find((p) => p.id === pipelineId) ?? pipelines[0];

  if (isLoading) {
    return (
      <div style={{ padding: 24, color: "var(--ink-3)", fontSize: 12 }}>
        {lang === "ar" ? "جارٍ التحميل..." : "Loading pipelines..."}
      </div>
    );
  }

  if (!pipeline) {
    return (
      <div style={{ padding: 24, color: "var(--ink-3)", fontSize: 13 }}>
        {lang === "ar" ? "لا توجد خطوط أنابيب" : "No pipelines configured"}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <PipelineHeader
        lang={lang}
        pipelines={pipelines}
        selectedPipelineId={pipelineId}
        onPipelineChange={setPipelineId}
        summary={summary}
        search={search}
        onSearchChange={setSearch}
        view={view}
        onViewChange={setView}
        onNewTicket={() => setShowNew(true)}
      />
      <BoardFilters
        tx={tx}
        filters={scoped.filters}
        showSla={showSla}
        team={team}
        onChange={(f) => {
          if (f.q !== filters.q) setSearch(f.q);
          setFilters(f);
        }}
      />
      <div style={{ flex: 1, minHeight: 0 }}>
        {view === "table" ? (
          <PipelineTable
            tx={tx}
            lang={lang}
            tz={tz}
            pipelineId={pipeline.id}
            stages={pipeline.stages}
            team={team}
            qs={tableQs}
            sort={scoped.sort}
            showSla={showSla}
            onSort={(k) => setSort((s) => nextSort(s, k))}
            selected={selected}
            onToggle={toggleSelect}
            onToggleAll={toggleAll}
          />
        ) : (
          <PipelineBoard
            pipeline={pipeline}
            showSla={showSla}
            lang={lang}
            filterQs={filterQs}
            selectedIds={selected}
            onToggleSelect={toggleSelect}
            onCardClick={setSelectedTicket}
            onOpenConversation={(cid) => {
              window.location.hash = `#/inbox?open=${encodeURIComponent(cid)}`;
            }}
          />
        )}
      </div>
      <BoardBulkBar
        tx={tx}
        lang={lang}
        pipelineId={pipeline.id}
        isLeads={pipeline.kind === "leads"}
        ids={[...selected]}
        team={team}
        onClear={clearSelection}
        moveLocked={pipeline.agentCanMove === false && !can("pipelines.update")}
      />

      {selectedTicket || deepTicketId ? (
        <TicketDetailDrawer
          ticketId={selectedTicket?.id ?? deepTicketId!}
          pipelineId={selectedTicket?.pipelineId ?? ""}
          stageId={selectedTicket?.stageId ?? ""}
          lang={lang}
          onClose={() => {
            setSelectedTicket(null);
            setDeepTicketId(null);
          }}
          onOpenConversation={(cid) => {
            openRecord("conversation", cid);
          }}
        />
      ) : null}

      {showNew && pipeline ? (
        <NewTicketModal
          mode="direct"
          contactId="" // TODO: replace with contact-picker; primary creation is via Inbox conversion.
          lang={lang}
          onClose={() => setShowNew(false)}
        />
      ) : null}
    </div>
  );
}
