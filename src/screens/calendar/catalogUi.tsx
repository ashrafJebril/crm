/**
 * SP-10 shared bits for the Services and Staff tabs: field styles, colour
 * dot and picker, money in `<bdi>`, the error box, the "someone else changed
 * this" banner and the delete-preview dialog.
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Modal } from "@/components/Modal";
import type { Tx } from "@/lib/tx";
import type { CatalogDeleteResult, Lang, StageColor } from "@/lib/types";
import { stageColor } from "@/screens/pipeline/stageColors";
import { formatAdMoney } from "@/screens/ads/adsModel";
import { BOOKING_COLORS } from "./bookingConstants";
import { bookingErrorText } from "./bookingErrors";

export { FIELD, LABEL, ERROR_BOX } from "@/screens/contacts/import/styles";
import { ERROR_BOX } from "@/screens/contacts/import/styles";

export const TH: CSSProperties = {
  textAlign: "start",
  fontSize: 11,
  fontWeight: 500,
  color: "var(--ink-3)",
  padding: "8px 12px",
  borderBlockEnd: "1px solid var(--line-soft)",
  whiteSpace: "nowrap",
};
export const TD: CSSProperties = { padding: "10px 12px", borderBlockEnd: "1px solid var(--line-soft)", fontSize: 13, verticalAlign: "middle" };

export function ColorDot({ color, size = 10 }: { color: StageColor | string; size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: 999,
        flex: "none",
        background: stageColor[color as StageColor] ?? "var(--ink-3)",
      }}
    />
  );
}

export function ColorPicker({ value, onChange, tx }: { value: string; onChange: (c: StageColor) => void; tx: Tx }) {
  return (
    <div role="radiogroup" aria-label={tx("Colour", "اللون")} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {BOOKING_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          onClick={() => onChange(c)}
          style={{
            width: 24,
            height: 24,
            borderRadius: 999,
            border: value === c ? "2px solid var(--ink)" : "1px solid var(--line)",
            background: "var(--bg-1)",
            display: "grid",
            placeItems: "center",
            cursor: "pointer",
          }}
        >
          <ColorDot color={c} size={12} />
        </button>
      ))}
    </div>
  );
}

/** A price as "SAR 120.50" with Latin digits, inside `<bdi>`. */
export function Money({ price, currency, lang }: { price: string | null; currency: string; lang: Lang }) {
  if (price === null) return <span className="muted">—</span>;
  return <bdi>{formatAdMoney(Number(price), currency, lang)}</bdi>;
}

export function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <div role="alert" style={ERROR_BOX}>
      {children}
    </div>
  );
}

/** A 409 version conflict: reload the other edit, or save mine on top of it. */
export function ConflictBanner({ tx, onLoadTheirs, onKeepMine }: { tx: Tx; onLoadTheirs: () => void; onKeepMine: () => void }) {
  return (
    <div role="alert" style={{ ...ERROR_BOX, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <span style={{ flex: 1, minWidth: 160 }}>
        {tx("Someone else changed this while you were editing.", "عدّل شخص آخر هذا العنصر أثناء تعديلك.")}
      </span>
      <button type="button" className="btn sm" onClick={onLoadTheirs}>
        {tx("Load theirs", "تحميل نسختهم")}
      </button>
      <button type="button" className="btn sm primary" onClick={onKeepMine}>
        {tx("Keep mine", "الإبقاء على تعديلي")}
      </button>
    </div>
  );
}

interface DeleteDialogProps<P> {
  tx: Tx;
  lang: Lang;
  title: string;
  name: string;
  load: () => Promise<P>;
  /** The preview's booking count (any status) and upcoming count. */
  counts: (p: P) => { bookingCount: number; upcomingCount: number; links: number };
  linksLabel: [string, string];
  remove: () => Promise<CatalogDeleteResult>;
  onClose: () => void;
  onDone: (r: CatalogDeleteResult) => void;
}

/**
 * Delete with references (Review Focus 2): the preview says whether bookings
 * use the row; if so the action is "Archive" and explains that bookings keep
 * their name; otherwise it is a delete.
 */
export function DeleteDialog<P>({ tx, title, name, load, counts, linksLabel, remove, onClose, onDone }: DeleteDialogProps<P>) {
  const [preview, setPreview] = useState<P | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    load().then(
      (p) => live && setPreview(p),
      (e) => live && setError(bookingErrorText(e, tx)),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const c = preview ? counts(preview) : null;
  const archive = !!c && c.bookingCount > 0;
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await remove());
    } catch (e) {
      setError(bookingErrorText(e, tx));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label={title} width={460}>
      <div style={{ display: "grid", gap: 12 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>{title}</h3>
        <div style={{ fontSize: 13 }}>
          <bdi style={{ fontWeight: 600 }}>{name}</bdi>
        </div>
        {!c && !error && <div className="muted">{tx("Checking bookings…", "جارٍ التحقق من الحجوزات…")}</div>}
        {c && (
          <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 13, display: "grid", gap: 4 }}>
            <li>
              {tx("Bookings", "الحجوزات")}: <bdi>{c.bookingCount}</bdi>
            </li>
            <li>
              {tx("Upcoming", "القادمة")}: <bdi>{c.upcomingCount}</bdi>
            </li>
            <li>
              {tx(linksLabel[0], linksLabel[1])}: <bdi>{c.links}</bdi>
            </li>
          </ul>
        )}
        {c && (
          <p style={{ margin: 0, fontSize: 13, color: "var(--ink-2)" }}>
            {archive
              ? tx(
                  "Bookings use this, so it will be archived instead of deleted: it stops taking new bookings, and existing bookings keep its name. You can restore it later.",
                  "تستخدمه حجوزات، لذا سيُؤرشف بدلًا من الحذف: لن يقبل حجوزات جديدة، وتحتفظ الحجوزات الحالية باسمه. يمكنك استعادته لاحقًا.",
                )
              : tx("No bookings use this. It will be deleted permanently.", "لا تستخدمه أي حجوزات. سيُحذف نهائيًا.")}
          </p>
        )}
        {error && <ErrorBox>{error}</ErrorBox>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            {tx("Cancel", "إلغاء")}
          </button>
          <button type="button" className="btn primary" disabled={!c || busy} onClick={go} style={archive ? undefined : { background: "var(--bad)" }}>
            {archive ? tx("Archive", "أرشفة") : tx("Delete", "حذف")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
