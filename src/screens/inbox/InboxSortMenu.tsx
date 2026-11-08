import { IconMore } from "@/icons";
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
    { id: "recent", label: tx("Recent", "الأحدث") },
    { id: "oldest", label: tx("Oldest", "الأقدم") },
    { id: "unread", label: tx("Unread first", "غير المقروءة أولاً") },
  ];
  return (
    <Popover
      trigger={<IconMore w={14} />}
      title={tx("Sort", "ترتيب")}
      ariaLabel={tx("Sort", "ترتيب")}
      role="menu"
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
