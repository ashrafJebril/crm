import { useEffect, useState } from "react";
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
import { TEAM } from "@/data/team";
import type { Ticket } from "@/lib/types";

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

  const [search, setSearch] = useState("");
  const [ownerFilter, setOwnerFilter] = useState<string>("");
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
        ownerFilter={ownerFilter}
        onOwnerChange={setOwnerFilter}
        onNewTicket={() => setShowNew(true)}
        owners={TEAM.map((m) => ({ id: m.id, name: m.name }))}
      />
      <div style={{ flex: 1, minHeight: 0 }}>
        <PipelineBoard
          pipeline={pipeline}
          lang={lang}
          ownerFilter={ownerFilter || undefined}
          searchQuery={search}
          onCardClick={setSelectedTicket}
          onOpenConversation={(cid) => {
            window.location.hash = `#/inbox?open=${encodeURIComponent(cid)}`;
          }}
        />
      </div>

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
