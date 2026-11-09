import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import { PageHeader } from "@/components/PageHeader";
import { KINDS, kindLabel, useInvalidateActivities, useTeam } from "@/components/activities/activityApi";
import { usePermissions } from "@/auth/usePermissions";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { decodeJson, encodeJson, getHashParam, setHashParam } from "@/lib/hashState";
import type { Pipeline } from "@/lib/types";
import { BulkFollowUpBar } from "./followups/BulkFollowUpBar";
import { FollowUpRow } from "./followups/FollowUpRow";
import { groupForDisplay, pruneSelection, type ActivityKind, type QueueResponse, type SectionKey } from "./followups/followupsLogic";

interface FuState {
  scope: "mine" | "team";
  assigneeId: string;
  kind: ActivityKind | "";
  pipelineId: string;
}
const DEFAULT: FuState = { scope: "mine", assigneeId: "", kind: "", pipelineId: "" };

function readState(): FuState {
  const v = decodeJson(getHashParam(window.location.hash, "fu"));
  if (!v || typeof v !== "object") return DEFAULT;
  const o = v as Partial<FuState>;
  return {
    scope: o.scope === "team" ? "team" : "mine",
    assigneeId: typeof o.assigneeId === "string" ? o.assigneeId : "",
    kind: KINDS.includes(o.kind as ActivityKind) ? (o.kind as ActivityKind) : "",
    pipelineId: typeof o.pipelineId === "string" ? o.pipelineId : "",
  };
}

export default function FollowUps() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { can } = usePermissions();
  const team = useTeam();
  const invalidate = useInvalidateActivities();
  const pipelines = useFetch<Pipeline[]>("/pipelines").data ?? [];
  const canTeam = can("contacts.view");

  const [st, setSt] = useState<FuState>(readState);
  // Back/forward or a pasted link changes ?fu= without remounting: re-read it.
  useEffect(() => {
    const onHash = () => setSt((cur) => {
      const next = readState();
      return JSON.stringify(next) === JSON.stringify(cur) ? cur : next;
    });
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const scope = st.scope === "team" && canTeam ? "team" : "mine";
  const update = (patch: Partial<FuState>) => {
    const next = { ...st, ...patch };
    setSt(next);
    const isDefault = JSON.stringify(next) === JSON.stringify(DEFAULT);
    const hash = setHashParam(window.location.hash, "fu", isDefault ? null : encodeJson(next));
    window.history.replaceState(null, "", hash);
  };

  const params = new URLSearchParams({ scope });
  if (scope === "team" && st.assigneeId) params.set("assigneeId", st.assigneeId);
  if (st.kind) params.set("kind", st.kind);
  if (st.pipelineId) params.set("pipelineId", st.pipelineId);
  const base = `/activities/queue?${params.toString()}`;

  // Upcoming pages are infinite-query pages keyed by the filter base, so the 60 s
  // refetch refreshes every loaded page instead of dropping "Load more" results.
  const q = useInfiniteQuery<QueueResponse, Error, { pages: QueueResponse[] }, string[], string | null>({
    queryKey: [base],
    initialPageParam: null,
    queryFn: ({ pageParam, signal }) =>
      api.get<QueueResponse>(pageParam ? `${base}&cursorUpcoming=${encodeURIComponent(pageParam)}` : base, signal),
    getNextPageParam: (last) => last.nextCursorUpcoming ?? null,
    refetchInterval: 60_000,
  });
  const loadingMore = q.isFetchingNextPage;
  const cursor = q.hasNextPage ? (q.data?.pages[q.data.pages.length - 1]?.nextCursorUpcoming ?? null) : null;
  const loadMore = () => void q.fetchNextPage();

  const data: QueueResponse | undefined = useMemo(() => {
    const pages = q.data?.pages;
    if (!pages || pages.length === 0) return undefined;
    const first = pages[0];
    const seen = new Set<string>();
    const upcoming = pages.flatMap((p) => p.upcoming).filter((a) => !seen.has(a.id) && !!seen.add(a.id));
    return { ...first, upcoming, nextCursorUpcoming: pages[pages.length - 1].nextCursorUpcoming };
  }, [q.data]);
  const sections = data ? groupForDisplay(data) : [];

  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => setSelected(new Set()), [base]);
  // After a refresh, drop selected ids that are no longer listed.
  useEffect(() => {
    if (!data) return;
    const ids = [...data.overdue, ...data.today, ...data.upcoming].map((a) => a.id);
    setSelected((s) => pruneSelection(s, ids));
  }, [data]);
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const nameOf = useMemo(() => new Map(team.map((m) => [m.id, m.name])), [team]);
  const title: Record<SectionKey, string> = {
    overdue: tx("Overdue", "متأخرة"),
    today: tx("Today", "اليوم"),
    upcoming: tx("Upcoming", "القادمة"),
  };

  const tab = (key: "mine" | "team", label: string, disabled = false) => (
    <button
      type="button" className={`btn sm ${scope === key ? "primary" : ""}`.trim()} disabled={disabled}
      title={disabled ? tx("You don't have permission to do this", "ليست لديك صلاحية للقيام بذلك") : undefined}
      onClick={() => update({ scope: key, assigneeId: "" })}
    >
      {label}
    </button>
  );

  return (
    <div style={{ flex: 1, overflowY: "auto", paddingBottom: 24 }}>
      <PageHeader
        title={tx("Follow-ups", "المتابعات")}
        subtitle={tx("Calls, meetings and tasks that need your attention", "المكالمات والاجتماعات والمهام التي تحتاج إلى اهتمامك")}
      />
      <div style={{ padding: "0 24px", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {tab("mine", tx("Mine", "خاصتي"))}
        {tab("team", tx("Team", "الفريق"), !canTeam)}
        {scope === "team" && (
          <select className="input" aria-label={tx("Person", "الشخص")} value={st.assigneeId} onChange={(e) => update({ assigneeId: e.target.value })}>
            <option value="">{tx("Everyone", "الجميع")}</option>
            {team.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        )}
        <select className="input" aria-label={tx("Kind", "النوع")} value={st.kind} onChange={(e) => update({ kind: e.target.value as FuState["kind"] })}>
          <option value="">{tx("All kinds", "كل الأنواع")}</option>
          {KINDS.map((k) => <option key={k} value={k}>{kindLabel(tx, k)}</option>)}
        </select>
        <select className="input" aria-label={tx("Pipeline", "المسار")} value={st.pipelineId} onChange={(e) => update({ pipelineId: e.target.value })}>
          <option value="">{tx("All pipelines", "كل المسارات")}</option>
          {pipelines.map((p) => <option key={p.id} value={p.id}>{t.lang === "ar" && p.nameAr ? p.nameAr : p.name}</option>)}
        </select>
      </div>

      <div style={{ padding: "12px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
        {q.isPending ? (
          <div style={{ color: "var(--ink-3)", fontSize: 13 }}>{tx("Loading…", "جارٍ التحميل…")}</div>
        ) : q.isError ? (
          <div style={{ color: "var(--bad)", fontSize: 13 }}>{q.error.message}</div>
        ) : sections.length === 0 ? (
          <div style={{ color: "var(--ink-3)", fontSize: 13, padding: 24, textAlign: "center" }}>
            {tx("Nothing to follow up. You're all caught up.", "لا توجد متابعات. أنت على اطلاع بكل شيء.")}
          </div>
        ) : (
          sections.map((sec) => (
            <section key={sec.key} className="card" style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ padding: "10px 12px", fontSize: 13, fontWeight: 600, color: sec.key === "overdue" ? "var(--bad)" : "var(--ink)", background: "var(--bg-2)" }}>
                {title[sec.key]} <span className="mono" style={{ color: "var(--ink-3)", fontWeight: 400 }}>({sec.count})</span>
              </div>
              {sec.items.map((a) => (
                <FollowUpRow
                  key={a.id}
                  a={a}
                  selected={selected.has(a.id)}
                  onToggle={() => toggle(a.id)}
                  assigneeName={a.assigneeId ? nameOf.get(a.assigneeId) ?? null : null}
                  onChanged={invalidate}
                />
              ))}
              {sec.key === "upcoming" && cursor && (
                <div style={{ padding: 10, textAlign: "center" }}>
                  <button type="button" className="btn sm" disabled={loadingMore} onClick={loadMore}>
                    {loadingMore ? tx("Loading…", "جارٍ التحميل…") : tx("Load more", "تحميل المزيد")}
                  </button>
                </div>
              )}
            </section>
          ))
        )}
        {selected.size > 0 && <BulkFollowUpBar ids={[...selected]} onClear={() => setSelected(new Set())} />}
      </div>
    </div>
  );
}
