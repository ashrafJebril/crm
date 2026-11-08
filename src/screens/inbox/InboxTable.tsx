import { useEffect, useState } from "react";
import { Avatar } from "@/components/Avatar";
import {
  CHANNEL_LABEL,
  type Contact,
  type Conversation,
  type ConversationLabel,
  type Lang,
  type TeamMember,
} from "@/lib/types";
import type { Tx } from "@/lib/tx";
import { Pager } from "../contacts/Pager";
import { statusLabels } from "./boardLogic";
import { LabelChips } from "./LabelChips";

/** Table over the already filtered + sorted inbox list; client-side paging. */
export function InboxTable({
  convs,
  contactById,
  teamById,
  labelById,
  activeId,
  onOpen,
  lang,
  tx,
  noConversations,
}: {
  convs: Conversation[];
  contactById: Map<string, Contact>;
  teamById: Map<string, TeamMember>;
  labelById: Map<string, ConversationLabel>;
  activeId: string | null;
  onOpen: (id: string) => void;
  lang: Lang;
  tx: Tx;
  /** No conversations at all (not just none matching the filters). */
  noConversations?: boolean;
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const pageCount = Math.max(1, Math.ceil(convs.length / pageSize));
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);
  const cur = Math.min(page, pageCount);
  const rows = convs.slice((cur - 1) * pageSize, cur * pageSize);
  const sl = statusLabels(tx);
  const fmt = (iso?: string | null) => {
    if (!iso) return "—";
    const t = Date.parse(iso);
    return Number.isNaN(t)
      ? "—"
      : new Date(t).toLocaleString(lang === "ar" ? "ar" : undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0, flex: 1 }}>
      <div style={{ flex: 1, overflow: "auto", padding: "0 16px" }}>
        <table className="tbl" style={{ width: "100%" }}>
          <thead>
            <tr>
              <th>{tx("Contact", "جهة الاتصال")}</th>
              <th>{tx("Channel", "القناة")}</th>
              <th>{tx("Status", "الحالة")}</th>
              <th>{tx("Assignee", "المسؤول")}</th>
              <th>{tx("Labels", "التصنيفات")}</th>
              <th>{tx("Last message", "آخر رسالة")}</th>
              <th>{tx("Updated", "آخر تحديث")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} style={{ color: "var(--ink-3)", padding: 24, textAlign: "center" }}>
                  {noConversations
                    ? tx("No conversations yet", "لا توجد محادثات بعد")
                    : tx("No conversations match these filters.", "لا توجد محادثات تطابق عوامل التصفية.")}
                </td>
              </tr>
            )}
            {rows.map((c) => {
              const contact = contactById.get(c.contactId);
              const member = c.assigneeId ? teamById.get(c.assigneeId) : undefined;
              return (
                <tr
                  key={c.id}
                  className={activeId === c.id ? "selected" : undefined}
                  tabIndex={0}
                  style={{ cursor: "pointer" }}
                  onClick={() => onOpen(c.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onOpen(c.id);
                  }}
                >
                  <td>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <Avatar name={contact?.name} color="200" size="sm" />
                      <span dir="auto" style={{ fontWeight: c.unread > 0 ? 700 : 500 }}>
                        {contact?.name ?? "—"}
                      </span>
                    </span>
                  </td>
                  <td>{CHANNEL_LABEL[c.channel] ?? c.channel}</td>
                  <td>
                    {sl[c.status] ?? c.status}
                    {c.escalated && (
                      <span
                        title={c.escalateReason || undefined}
                        style={{ color: "var(--bad)", marginInlineStart: 6 }}
                      >
                        · {tx("Escalated", "مُصعّدة")}
                      </span>
                    )}
                  </td>
                  <td>
                    {member ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <Avatar name={member.name} color={member.color} size="sm" />
                        <span dir="auto">{member.name}</span>
                      </span>
                    ) : (
                      <span style={{ color: "var(--ink-3)" }}>{tx("Unassigned", "غير معيّنة")}</span>
                    )}
                  </td>
                  <td>
                    <LabelChips labelIds={c.labelIds ?? []} labelById={labelById} />
                  </td>
                  <td
                    dir="auto"
                    style={{ maxWidth: 260, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                  >
                    {c.preview}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>{fmt(c.updatedAt ?? c.lastAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ padding: "0 16px" }}>
        <Pager
          tx={tx}
          page={cur}
          pageCount={pageCount}
          pageSize={pageSize}
          total={convs.length}
          onPage={setPage}
          onPageSize={(n) => {
            setPageSize(n);
            setPage(1);
          }}
        />
      </div>
    </div>
  );
}
