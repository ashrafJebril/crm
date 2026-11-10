import type { ReactNode } from "react";
import { Badge } from "@/components/Badge";
import type { Tx } from "@/lib/tx";
import type { Lang } from "@/lib/types";
import { STATE_LABEL, badgeKind, type SignalView, type Tone } from "./healthModel";

/** A date-time in the UI language; "Never" when absent. */
export function fmtWhen(iso: string | null | undefined, lang: Lang, tx: Tx): string {
  if (!iso) return tx("Never", "لم يحدث بعد");
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return tx("Never", "لم يحدث بعد");
  return d.toLocaleString(lang === "ar" ? "ar" : "en", { dateStyle: "medium", timeStyle: "short" });
}

/** A tone chip. Unknown is muted (dashed, no dot) so it can never read as a status colour. */
export function ToneChip({ tone, unknown, title, children }: { tone: Tone; unknown?: boolean; title?: string; children: ReactNode }) {
  if (unknown) {
    return (
      <span
        className="badge"
        title={title}
        style={{ background: "transparent", border: "1px dashed var(--line)", color: "var(--ink-3)" }}
      >
        {children}
      </span>
    );
  }
  return (
    <span title={title} style={{ display: "inline-flex" }}>
      <Badge kind={badgeKind(tone)} dot={tone !== "neutral"}>
        {children}
      </Badge>
    </span>
  );
}

/** The small "via Zernio (unverified field)" mark (R1). */
export function SourceMark({ label }: { label: string }) {
  return (
    <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)", border: "1px solid var(--line-soft)", borderRadius: 999, padding: "0 6px" }}>
      {label}
    </span>
  );
}

/**
 * One value: the chip, why it is unknown, the previous value (labelled as
 * previous, never as current) and the passthrough source.
 */
export function SignalValue({ view, tx, lang, compact }: { view: SignalView; tx: Tx; lang: Lang; compact?: boolean }) {
  const title = view.unknown ? view.reason : undefined;
  return (
    <div style={{ display: "grid", gap: 3, justifyItems: "start", minWidth: 0 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <ToneChip tone={view.tone} unknown={view.unknown} title={title}>
          {view.label}
        </ToneChip>
        {view.source && !compact && <SourceMark label={view.source} />}
      </div>
      {view.unknown && !compact && (
        <div style={{ fontSize: 11, color: "var(--ink-3)", lineHeight: 1.4 }}>
          {tx(STATE_LABEL[view.state].en, STATE_LABEL[view.state].ar)}
          {view.reason && !view.previous ? ` · ${view.reason}` : ""}
        </div>
      )}
      {view.previous && (
        <div style={{ fontSize: 11, color: "var(--ink-3)", lineHeight: 1.4 }}>
          {tx("Previous", "القيمة السابقة")}: {view.previous.label}
          {compact ? "" : ` · ${fmtWhen(view.previous.at, lang, tx)}`}
        </div>
      )}
    </div>
  );
}
