/**
 * SP-10 booking search typeahead (bookings.view): GET /appointments/search,
 * debounced; a result opens the booking sheet (`?record=booking:<id>`).
 */
import { useState } from "react";
import { useFetch } from "@/api/useFetch";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { openRecord } from "@/lib/openRecord";
import { IconSearch } from "@/icons";
import type { Tx } from "@/lib/tx";
import type { Lang } from "@/lib/types";
import type { BookingSearchItem } from "./bookingApi";
import { STATUS_WORDS } from "./bookingStatus";
import { timeInTz, wallClock } from "./bookingTime";
import { FIELD } from "./catalogUi";

export function BookingSearch({ tx, lang, tz }: { tx: Tx; lang: Lang; tz: string }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const term = useDebouncedValue(q.trim(), 250);
  const res = useFetch<{ items: BookingSearchItem[] }>(term.length >= 2 ? `/appointments/search?q=${encodeURIComponent(term)}` : null);
  const items = term.length >= 2 ? res.data?.items ?? [] : [];
  return (
    <div style={{ position: "relative", width: 240 }}>
      <span style={{ position: "absolute", insetInlineStart: 8, top: 7, color: "var(--ink-3)" }}>
        <IconSearch w={13} />
      </span>
      <input
        type="search"
        role="combobox"
        aria-expanded={open && items.length > 0}
        aria-label={tx("Search bookings", "البحث في الحجوزات")}
        placeholder={tx("Search bookings", "ابحث في الحجوزات")}
        style={{ ...FIELD, height: 28, fontSize: 12, width: "100%", paddingInlineStart: 26 }}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
      />
      {open && term.length >= 2 && (
        <ul
          role="listbox"
          style={{
            position: "absolute",
            insetInlineStart: 0,
            insetInlineEnd: 0,
            top: 32,
            zIndex: 20,
            margin: 0,
            padding: 4,
            listStyle: "none",
            background: "var(--bg-1)",
            border: "1px solid var(--line-soft)",
            borderRadius: 8,
            boxShadow: "var(--shadow-lg)",
            maxHeight: 320,
            overflowY: "auto",
          }}
        >
          {!items.length && <li className="muted" style={{ padding: 8, fontSize: 12 }}>{res.loading ? tx("Searching…", "جارٍ البحث…") : tx("No bookings found.", "لا توجد حجوزات.")}</li>}
          {items.map((it) => (
            <li key={it.id} role="option" aria-selected={false}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setOpen(false);
                  openRecord("booking", it.id);
                }}
                style={{ width: "100%", textAlign: "start", background: "transparent", border: 0, padding: 8, borderRadius: 6, cursor: "pointer", color: "inherit", display: "grid", gap: 2 }}
              >
                <bdi style={{ fontWeight: 500, fontSize: 13 }}>{it.contactName ?? "—"}</bdi>
                <span className="muted" style={{ fontSize: 11 }}>
                  <bdi>{lang === "ar" ? it.serviceAr || it.service : it.service}</bdi> · <bdi className="mono">{wallClock(new Date(it.startAt), tz).dateISO} {timeInTz(it.startAt, tz)}</bdi> ·{" "}
                  {tx(...STATUS_WORDS[it.status])}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
