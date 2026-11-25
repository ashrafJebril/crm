import { useEffect, useState } from "react";
import type { Tx } from "@/lib/tx";
import { RANGE_PRESETS, customRangeOk, rangeDays, type InsightsParams, type RangePreset } from "./insightsParams";

const PRESET_COPY: Record<RangePreset, [en: string, ar: string]> = {
  "7": ["7 days", "7 أيام"],
  "30": ["30 days", "30 يومًا"],
  "90": ["90 days", "90 يومًا"],
  custom: ["Custom", "مخصص"],
};

/** Range presets plus a custom from/to, in workspace-local days ("Days in <tz>"). */
export function RangePicker({
  params,
  setParams,
  today,
  tz,
  tx,
}: {
  params: InsightsParams;
  setParams: (patch: Partial<InsightsParams>) => void;
  today: string;
  tz: string;
  tx: Tx;
}) {
  const shown = rangeDays(params, today);
  const [custom, setCustom] = useState(params.range === "custom");
  const [from, setFrom] = useState(shown.from);
  const [to, setTo] = useState(shown.to);
  useEffect(() => {
    setFrom(shown.from);
    setTo(shown.to);
  }, [shown.from, shown.to]);
  useEffect(() => setCustom(params.range === "custom"), [params.range]);
  const ok = customRangeOk(from, to) && to <= today;

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <span className="muted" style={{ fontSize: 11.5 }}>{tx(`Days in ${tz}`, `الأيام بتوقيت ${tz}`)}</span>
      {RANGE_PRESETS.map((r) => {
        const active = r === "custom" ? custom : !custom && params.range === r;
        return (
          <button
            key={r}
            type="button"
            aria-pressed={active}
            className={`btn ${active ? "primary" : ""}`.trim()}
            onClick={() => (r === "custom" ? setCustom(true) : (setCustom(false), setParams({ range: r, from: null, to: null })))}
          >
            {tx(PRESET_COPY[r][0], PRESET_COPY[r][1])}
          </button>
        );
      })}
      {custom && (
        <form
          style={{ display: "flex", gap: 6, alignItems: "center" }}
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) setParams({ range: "custom", from, to });
          }}
        >
          <input type="date" aria-label={tx("From", "من")} value={from} max={today} onChange={(e) => setFrom(e.target.value)} />
          <span aria-hidden>–</span>
          <input type="date" aria-label={tx("To", "إلى")} value={to} max={today} onChange={(e) => setTo(e.target.value)} />
          <button type="submit" className="btn" disabled={!ok} title={ok ? undefined : tx("Choose up to 366 days, ending today or earlier", "اختر حتى 366 يومًا تنتهي اليوم أو قبله")}>
            {tx("Apply", "تطبيق")}
          </button>
        </form>
      )}
    </div>
  );
}
