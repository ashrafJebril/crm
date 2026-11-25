import type { Tx } from "@/lib/tx";
import { MEDIA_QUERY_MAX } from "./mediaKinds";

/** SP-17 approval filter: all files, approved for the agent, or not approved. */
export type ApprovalFilter = "all" | "approved" | "not";

export const APPROVAL_FILTERS: { id: ApprovalFilter; en: string; ar: string }[] = [
  { id: "all", en: "All", ar: "الكل" },
  { id: "approved", en: "Approved for agent", ar: "معتمدة للوكيل" },
  { id: "not", en: "Not approved", ar: "غير معتمدة" },
];

/** The `approved` query value for a filter (undefined = no filter). */
export const approvedParam = (f: ApprovalFilter): boolean | undefined =>
  f === "approved" ? true : f === "not" ? false : undefined;

/** Search box and approval filter shared by the Gallery and the agent's Photos tab. */
export function MediaSearchBar({
  tx,
  query,
  onQuery,
  approval,
  onApproval,
}: {
  tx: Tx;
  query: string;
  onQuery: (q: string) => void;
  approval: ApprovalFilter;
  onApproval: (f: ApprovalFilter) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <input
        className="input"
        type="search"
        dir="auto"
        value={query}
        maxLength={MEDIA_QUERY_MAX}
        onChange={(e) => onQuery(e.target.value)}
        placeholder={tx("Search title, alt text, tags or file name", "ابحث في العنوان أو النص البديل أو الوسوم أو اسم الملف")}
        aria-label={tx("Search files", "البحث في الملفات")}
        style={{ flex: "1 1 220px", minWidth: 0, maxWidth: 360 }}
      />
      <select
        className="input"
        value={approval}
        onChange={(e) => onApproval(e.target.value as ApprovalFilter)}
        aria-label={tx("Agent approval", "اعتماد الوكيل")}
        style={{ flex: "none" }}
      >
        {APPROVAL_FILTERS.map((f) => (
          <option key={f.id} value={f.id}>
            {tx(f.en, f.ar)}
          </option>
        ))}
      </select>
    </div>
  );
}
