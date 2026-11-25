import { useMemo, type CSSProperties } from "react";
import { useFetch } from "@/api/useFetch";
import type { Tx } from "@/lib/tx";
import type { Campaign, CustomFieldDef, Lang, Pipeline, Segment, TagRow } from "@/lib/types";
import { countLabel, type LookupKind, type RuleLookups, type RulePart } from "./rulesModel";

export const FIELD: CSSProperties = {
  height: 32,
  padding: "0 8px",
  borderRadius: 8,
  border: "1px solid var(--line)",
  background: "var(--bg-1)",
  color: "var(--ink)",
  fontSize: 13,
  fontFamily: "inherit",
};

export const SECTION_LABEL: CSSProperties = {
  fontSize: 11,
  color: "var(--ink-3)",
  textTransform: "uppercase",
  margin: "6px 0 10px",
};

export const DANGER_BTN: CSSProperties = { background: "var(--bad)", color: "white", borderColor: "transparent" };

export const segName = (s: { name: string; nameAr?: string | null }, lang: Lang): string =>
  lang === "ar" && s.nameAr ? s.nameAr : s.name;

/** A rule sentence: user data (names, values, dates) in `<bdi>`. */
export function RuleText({ parts }: { parts: RulePart[] }) {
  return (
    <>
      {parts.map((p, i) => (p.bdi ? <bdi key={i} dir="auto">{p.text}</bdi> : <span key={i}>{p.text}</span>))}
    </>
  );
}

/** A member count that may be unknown; null never shows as 0 or blank. */
export function CountText({ count, timedOut, skipped, tx, short = false, style }: {
  count: number | null | undefined;
  timedOut?: boolean;
  skipped?: boolean;
  tx: Tx;
  short?: boolean;
  style?: CSSProperties;
}) {
  const l = countLabel(count, timedOut, tx, skipped);
  return (
    <bdi title={l.title} style={style} data-count-state={l.state}>
      {short ? l.short : l.text}
    </bdi>
  );
}

export function TypeBadge({ origin, tx, color }: { origin: string; tx: Tx; color?: string | null }) {
  const label = origin === "crm" ? tx("Smart", "ذكي") : origin === "hjz" ? tx("HJZ", "HJZ") : tx("Group", "مجموعة");
  return (
    <span
      className="mono"
      style={{
        fontSize: 10, textTransform: "uppercase", padding: "2px 8px", borderRadius: 999, whiteSpace: "nowrap",
        background: color ? `hsl(${color} 70% 45% / 0.15)` : "var(--bg-2)", color: "var(--ink-2)",
      }}
    >
      {label}
    </span>
  );
}

export function IssueDot({ count, tx }: { count: number; tx: Tx }) {
  if (count <= 0) return null;
  const t = tx(`${count} condition(s) match nobody until fixed`, `${count} شرط لا يطابق أحدًا حتى يُصلَح`);
  return (
    <span
      role="img"
      aria-label={t}
      title={t}
      style={{ width: 9, height: 9, borderRadius: 999, background: "var(--warn)", display: "inline-block", flexShrink: 0 }}
    />
  );
}

/**
 * Everything the editor and the rule sentences look names up in (shared
 * react-query cache). A list that is still loading or not readable by this
 * role is `undefined` in the lookups (final review M5), so its references read
 * "…" or "(not visible to you)", never "(deleted …)". The `*Rows` arrays are
 * always arrays, for the pickers.
 */
export function useRuleLookups(enabled = true): RuleLookups & {
  tags?: TagRow[];
  tagRows: TagRow[];
  segmentRows: Segment[];
  pipelineRows: Pipeline[];
  defRows: CustomFieldDef[];
  campaignRows: Campaign[];
  loaded: Record<LookupKind, boolean>;
} {
  const segmentsQ = useFetch<Segment[]>(enabled ? "/segments" : null);
  const pipelinesQ = useFetch<Pipeline[]>(enabled ? "/pipelines" : null);
  const defsQ = useFetch<CustomFieldDef[]>(enabled ? "/custom-fields" : null);
  const campaignsQ = useFetch<Campaign[]>(enabled ? "/campaigns" : null);
  const tagsQ = useFetch<TagRow[]>(enabled ? "/tags" : null);
  return useMemo(() => {
    const denied = (err: string | null, data: unknown) => !data && !!err && FORBIDDEN_RE.test(err);
    const pipelines = pipelinesQ.data ? pipelinesQ.data.map((p) => ({ ...p, stages: p.stages ?? [] })) : undefined;
    return {
      segments: segmentsQ.data ?? undefined,
      pipelines,
      defs: defsQ.data ?? undefined,
      campaigns: campaignsQ.data ?? undefined,
      tags: tagsQ.data ?? undefined,
      forbidden: {
        segments: denied(segmentsQ.error, segmentsQ.data),
        pipelines: denied(pipelinesQ.error, pipelinesQ.data),
        defs: denied(defsQ.error, defsQ.data),
        campaigns: denied(campaignsQ.error, campaignsQ.data),
        tags: denied(tagsQ.error, tagsQ.data),
      },
      loaded: {
        segments: !!segmentsQ.data,
        pipelines: !!pipelinesQ.data,
        defs: !!defsQ.data,
        campaigns: !!campaignsQ.data,
        tags: !!tagsQ.data,
      },
      tagRows: tagsQ.data ?? [],
      segmentRows: segmentsQ.data ?? [],
      pipelineRows: pipelinesQ.data ?? [],
      defRows: defsQ.data ?? [],
      campaignRows: campaignsQ.data ?? [],
    };
  }, [segmentsQ.data, segmentsQ.error, pipelinesQ.data, pipelinesQ.error, defsQ.data, defsQ.error, campaignsQ.data, campaignsQ.error, tagsQ.data, tagsQ.error]);
}

/** useFetch exposes only the message; the server's 403 text is "Missing permission" or a no-permission key. */
const FORBIDDEN_RE = /permission|forbidden|HTTP 403/i;
