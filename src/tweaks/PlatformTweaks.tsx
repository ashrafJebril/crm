import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTweaks } from "./context";
import type { Accent, Density, Lang, Theme } from "@/lib/types";

const STYLES = `
.twk-panel{position:fixed;inset-inline-end:16px;bottom:16px;z-index:2147483646;width:280px;
  max-height:calc(100vh - 32px);display:flex;flex-direction:column;
  background:var(--bg-elev);color:var(--ink);
  -webkit-backdrop-filter:blur(24px) saturate(160%);backdrop-filter:blur(24px) saturate(160%);
  border:1px solid var(--line);border-radius:14px;
  box-shadow:var(--shadow-lg);
  font-size:11.5px;line-height:1.4;overflow:hidden}
.twk-fab{position:fixed;inset-inline-end:16px;bottom:16px;z-index:2147483645;
  width:38px;height:38px;border-radius:999px;border:1px solid var(--line);
  background:var(--bg-elev);color:var(--ink-1);cursor:pointer;
  display:grid;place-items:center;box-shadow:var(--shadow)}
.twk-fab:hover{color:var(--accent);border-color:var(--accent-ring)}
.twk-hd{display:flex;align-items:center;justify-content:space-between;
  padding:12px 10px 12px 16px;border-bottom:1px solid var(--line-soft)}
.twk-hd b{font-size:12px;font-weight:600;letter-spacing:.01em}
.twk-x{appearance:none;border:0;background:transparent;color:var(--ink-3);
  width:22px;height:22px;border-radius:6px;cursor:pointer;font-size:13px;line-height:1}
.twk-x:hover{background:var(--bg-2);color:var(--ink)}
.twk-body{padding:6px 16px 16px;display:flex;flex-direction:column;gap:12px;
  overflow-y:auto;min-height:0}
.twk-row{display:flex;flex-direction:column;gap:6px}
.twk-row-h{flex-direction:row;align-items:center;justify-content:space-between;gap:10px}
.twk-lbl{display:flex;justify-content:space-between;align-items:baseline;
  color:var(--ink-2)}
.twk-lbl>span:first-child{font-weight:500}
.twk-sect{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
  color:var(--ink-3);padding-top:8px;font-family:var(--font-mono)}
.twk-sect:first-child{padding-top:0}
.twk-seg{position:relative;display:flex;padding:2px;border-radius:8px;
  background:var(--bg-2);border:1px solid var(--line-soft);user-select:none}
.twk-seg button{appearance:none;position:relative;z-index:1;flex:1;border:0;
  background:transparent;color:var(--ink-2);font:inherit;font-weight:500;
  min-height:22px;border-radius:6px;cursor:pointer;padding:4px 6px}
.twk-seg button[aria-checked="true"]{background:var(--bg-elev);color:var(--ink);
  box-shadow:0 1px 2px oklch(0 0 0 / 0.15)}
.twk-toggle{position:relative;width:32px;height:18px;border:1px solid var(--line);
  border-radius:999px;background:var(--bg-2);transition:background .15s;cursor:pointer;padding:0}
.twk-toggle[data-on="1"]{background:var(--accent);border-color:transparent}
.twk-toggle i{position:absolute;top:1px;inset-inline-start:1px;width:14px;height:14px;
  border-radius:50%;background:var(--ink-2);transition:inset-inline-start .15s}
.twk-toggle[data-on="1"] i{inset-inline-start:15px;background:var(--accent-ink)}
.twk-chips{display:flex;gap:6px}
.twk-chip{position:relative;appearance:none;flex:1;height:32px;padding:0;border:0;
  border-radius:8px;cursor:pointer;
  box-shadow:inset 0 0 0 1px var(--line-soft);transition:box-shadow .12s}
.twk-chip[data-on="1"]{box-shadow:inset 0 0 0 2px var(--ink)}
.twk-chip:hover{transform:translateY(-1px)}
`;

export function PlatformTweaks() {
  const { t, setTweak } = useTweaks();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) {
    return (
      <>
        <style>{STYLES}</style>
        <button
          type="button"
          className="twk-fab"
          aria-label="Open tweaks"
          title="Tweaks"
          onClick={() => setOpen(true)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <circle cx="12" cy="12" r="2.5" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h0a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
        </button>
      </>
    );
  }

  return (
    <>
      <style>{STYLES}</style>
      <div className="twk-panel" ref={panelRef}>
        <div className="twk-hd">
          <b>Tweaks</b>
          <button type="button" className="twk-x" aria-label="Close" onClick={() => setOpen(false)}>
            ✕
          </button>
        </div>
        <div className="twk-body">
          <Section label="Appearance" />
          <Segmented
            label="Theme"
            value={t.theme}
            options={["dark", "light"] as Theme[]}
            onChange={(v) => setTweak("theme", v)}
          />
          <AccentChips value={t.accent} onChange={(v) => setTweak("accent", v)} />
          <Segmented
            label="Density"
            value={t.density}
            options={["compact", "regular", "cozy"] as Density[]}
            onChange={(v) => setTweak("density", v)}
          />

          <Section label="Locale" />
          <Segmented
            label="Language"
            value={t.lang}
            options={["en", "ar"] as Lang[]}
            onChange={(v) => setTweak("lang", v)}
          />

          <Section label="Layout" />
          <Switch
            label="Collapse sidebar"
            value={t.collapsed}
            onChange={(v) => setTweak("collapsed", v)}
          />
          <Switch
            label="Show AI personalities"
            value={t.showAIPersonality}
            onChange={(v) => setTweak("showAIPersonality", v)}
          />
        </div>
      </div>
    </>
  );
}

function Section({ label }: { label: string }) {
  return <div className="twk-sect">{label}</div>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="twk-row">
      <div className="twk-lbl">
        <span>{label}</span>
      </div>
      {children}
    </div>
  );
}

function Segmented<V extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: V;
  options: V[];
  onChange: (v: V) => void;
}) {
  return (
    <Row label={label}>
      <div role="radiogroup" className="twk-seg">
        {options.map((o) => (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={o === value}
            onClick={() => onChange(o)}
          >
            {o}
          </button>
        ))}
      </div>
    </Row>
  );
}

function Switch({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="twk-row twk-row-h">
      <span style={{ fontWeight: 500, color: "var(--ink-2)" }}>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        className="twk-toggle"
        data-on={value ? "1" : "0"}
        onClick={() => onChange(!value)}
      >
        <i />
      </button>
    </div>
  );
}

const ACCENT_PREVIEW: Record<Accent, string> = {
  green:   "oklch(0.78 0.18 150)",
  indigo:  "oklch(0.72 0.18 268)",
  amber:   "oklch(0.84 0.17 78)",
  magenta: "oklch(0.72 0.22 350)",
};

function AccentChips({ value, onChange }: { value: Accent; onChange: (v: Accent) => void }) {
  return (
    <Row label="Accent">
      <div className="twk-chips" role="radiogroup">
        {(Object.keys(ACCENT_PREVIEW) as Accent[]).map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={value === k}
            data-on={value === k ? "1" : "0"}
            className="twk-chip"
            style={{ background: ACCENT_PREVIEW[k] }}
            onClick={() => onChange(k)}
            title={k}
            aria-label={k}
          />
        ))}
      </div>
    </Row>
  );
}
