import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queryKeys";
import type { Lang, Ticket, TicketsListPage } from "@/lib/types";

interface Props {
  conversationId: string;
  lang: Lang;
  onClick?: (ticket: Ticket) => void;
}

export function ConversationTicketsPill({ conversationId, lang, onClick }: Props) {
  const q = useQuery<TicketsListPage>({
    queryKey: qk.conversationTickets(conversationId),
    queryFn: ({ signal }) =>
      api.get<TicketsListPage>(
        `/tickets?conversationId=${encodeURIComponent(conversationId)}&limit=20`,
        signal,
      ),
    staleTime: 30_000,
  });

  const tickets = q.data?.items ?? [];
  if (tickets.length === 0) return null;

  const open = tickets.filter((t) => !t.closedAt).length;
  const closed = tickets.length - open;

  return (
    <button
      type="button"
      onClick={() => onClick?.(tickets[0])}
      style={{
        padding: "4px 10px",
        background: "var(--bg-2)",
        border: "1px solid var(--line)",
        borderRadius: 999,
        fontSize: 11,
        color: "var(--ink-2)",
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {lang === "ar"
        ? `${open} مفتوحة · ${closed} مغلقة`
        : `${open} open · ${closed} closed`}
    </button>
  );
}
