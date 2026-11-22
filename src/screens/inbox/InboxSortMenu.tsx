import type { Tx } from "@/lib/tx";
import type { InboxSort } from "./inboxFilters";
import { Popover } from "./Popover";

export function InboxSortMenu({
  sort,
  onChange,
  tx,
}: {
  sort: InboxSort;
  onChange: (s: InboxSort) => void;
  tx: Tx;
}) {
  const opts: { id: InboxSort; label: string }[] = [
    { id: "recent", label: tx("Newest", "الأحدث") },
    { id: "oldest", label: tx("Oldest waiting", "الأقدم انتظارًا") },
    { id: "unread", label: tx("Unread first", "غير المقروءة أولاً") },
  ];
  const current = opts.find((o) => o.id === sort) ?? opts[0]!;
  return (
    <Popover
      trigger={`${current.label} ▾`}
      triggerClassName="btn ghost sm ix-sort-btn"
      title={tx("Sort", "ترتيب")}
      ariaLabel={tx(`Sort: ${current.label}`, `الترتيب: ${current.label}`)}
      role="menu"
      sheetOnPhone
    >
      {(close) =>
        opts.map((o) => (
          <button
            key={o.id}
            role="menuitemradio"
            aria-checked={sort === o.id}
            className="btn ghost"
            onClick={() => {
              onChange(o.id);
              close();
            }}
            style={{
              display: "flex",
              width: "100%",
              justifyContent: "flex-start",
              textAlign: "start",
              fontWeight: sort === o.id ? 700 : 400,
            }}
          >
            {o.label}
          </button>
        ))
      }
    </Popover>
  );
}
