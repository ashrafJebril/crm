import type { Lang } from "@/lib/types";
import type { RecordKind } from "@/lib/recordParam";
import { displayFields, type FieldValue } from "../recordFields";

/** Read-only label/value rows for a record summary. */
export function FieldList({
  kind,
  fields,
  lang,
}: {
  kind: RecordKind;
  fields: { key: string; value: FieldValue }[];
  lang: Lang;
}) {
  const rows = displayFields(kind, fields, lang);
  return (
    <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "minmax(90px, 140px) 1fr", gap: "10px 14px", fontSize: 13 }}>
      {rows.map((r) => (
        <div key={r.key} style={{ display: "contents" }}>
          <dt className="mono" style={{ color: "var(--ink-3)", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.06, paddingTop: 2 }}>
            {r.label}
          </dt>
          <dd dir={r.auto ? "auto" : undefined} style={{ margin: 0, color: "var(--ink)", overflowWrap: "anywhere", textAlign: "start" }}>
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
