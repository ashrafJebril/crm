import { useEffect, useState } from "react";

interface SchedulePickerProps {
  /** When null, "Post now" mode. When a Date, "Schedule for later". */
  value: Date | null;
  onChange: (v: Date | null) => void;
  tx: (en: string, ar: string) => string;
}

function toInputDateTime(d: Date): string {
  // Format as YYYY-MM-DDTHH:MM in local time for <input type="datetime-local">.
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function defaultLater(): Date {
  // Default to 1 hour from now, rounded down to the minute.
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setSeconds(0, 0);
  return d;
}

export function SchedulePicker({ value, onChange, tx }: SchedulePickerProps) {
  const mode = value === null ? "now" : "later";
  const [draft, setDraft] = useState<string>(() =>
    value ? toInputDateTime(value) : toInputDateTime(defaultLater()),
  );

  // Keep `draft` in sync if the parent resets `value` (e.g., after publishing).
  useEffect(() => {
    if (value) setDraft(toInputDateTime(value));
  }, [value]);

  const onSetMode = (next: "now" | "later") => {
    if (next === "now") {
      onChange(null);
    } else {
      const parsed = new Date(draft);
      if (!Number.isNaN(parsed.getTime())) onChange(parsed);
      else onChange(defaultLater());
    }
  };

  const onDraftChange = (s: string) => {
    setDraft(s);
    const parsed = new Date(s);
    if (!Number.isNaN(parsed.getTime())) onChange(parsed);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 6 }}>
        {(["now", "later"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onSetMode(m)}
            style={{
              padding: "5px 12px",
              borderRadius: 999,
              border: mode === m ? "1px solid var(--accent-ring)" : "1px solid var(--line-soft)",
              background: mode === m ? "var(--accent-soft)" : "var(--bg-2)",
              color: "var(--ink-1)",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {m === "now" ? tx("Post now", "نشر الآن") : tx("Schedule", "جدولة")}
          </button>
        ))}
      </div>
      {mode === "later" && (
        <input
          type="datetime-local"
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          min={toInputDateTime(new Date())}
          style={{
            padding: "8px 10px",
            background: "var(--bg-2)",
            border: "1px solid var(--line)",
            borderRadius: 10,
            color: "var(--ink-1)",
            fontSize: 13,
            fontFamily: "inherit",
            outline: "none",
            width: 220,
          }}
        />
      )}
    </div>
  );
}
