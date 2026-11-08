import { makeTx } from "@/lib/tx";
import { FieldList } from "./FieldList";
import type { RecordBodyProps } from "../RecordSheet";

export function BookingBody({ summary, lang, onClose }: RecordBodyProps) {
  const tx = makeTx(lang);
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 20px 24px" }}>
      <FieldList kind="booking" fields={summary.fields} lang={lang} />
      <button
        type="button"
        className="btn primary"
        style={{ marginTop: 20 }}
        onClick={() => {
          window.location.hash = "#/calendar";
          onClose();
        }}
      >
        {tx("Open calendar", "فتح التقويم")}
      </button>
    </div>
  );
}
