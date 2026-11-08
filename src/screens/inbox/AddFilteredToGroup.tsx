import { useState } from "react";
import { api, ApiError } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import { useToast } from "@/components/Toast";
import type { Conversation, Lang, Segment } from "@/lib/types";
import type { Tx } from "@/lib/tx";
import { groupContactIds } from "./boardLogic";
import { isLiveThreadId } from "./ConversationActions";
import { Popover } from "./Popover";

/** Adds the contacts of the filtered stored conversations to a manual group. */
export function AddFilteredToGroup({ convs, tx, lang }: { convs: Conversation[]; tx: Tx; lang: Lang }) {
  const { toast } = useToast();
  const [opened, setOpened] = useState(false);
  const segQ = useFetch<Segment[]>("/segments", { enabled: opened });
  const [busy, setBusy] = useState(false);
  const ids = groupContactIds(convs, (c) => isLiveThreadId(c.id));
  const groups = (segQ.data ?? []).filter((s) => s.origin === "manual");

  async function add(seg: Segment, close: () => void) {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.post<{ added: number }>(`/segments/${seg.id}/members`, { contactIds: ids });
      close();
      const n = r.added ?? 0;
      toast(tx(`Added ${n} contacts`, `تمت إضافة ${n} جهة اتصال`), "success");
    } catch (e) {
      toast(
        e instanceof ApiError && e.message
          ? e.message
          : tx("Couldn't add contacts to the group", "تعذّرت إضافة جهات الاتصال إلى المجموعة"),
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <span onClickCapture={() => setOpened(true)}>
      <Popover
        trigger={tx("Add to group ▾", "إضافة إلى مجموعة ▾")}
        triggerClassName="btn sm"
        disabled={ids.length === 0}
        title={
          ids.length === 0
            ? tx("No stored contacts in this view", "لا توجد جهات اتصال محفوظة في هذا العرض")
            : undefined
        }
        panelStyle={{ minWidth: 220, maxHeight: 320, padding: 4 }}
      >
        {(close) => (
          <>
            <div style={{ padding: "6px 8px", fontSize: 12, color: "var(--ink-3)" }}>
              {tx(`${ids.length} contacts in this view`, `${ids.length} جهة اتصال في هذا العرض`)}
            </div>
            {segQ.loading && (
              <div style={{ padding: "6px 8px", fontSize: 12 }}>{tx("Loading…", "جارٍ التحميل…")}</div>
            )}
            {segQ.error && (
              <div role="alert" style={{ padding: "6px 8px", fontSize: 12, color: "var(--bad)" }}>
                {segQ.error}
              </div>
            )}
            {!segQ.loading && !segQ.error && groups.length === 0 && (
              <div style={{ padding: "6px 8px", fontSize: 12 }}>
                {tx("No manual groups yet.", "لا توجد مجموعات يدوية بعد.")}
              </div>
            )}
            {groups.map((s) => (
              <button
                key={s.id}
                className="btn ghost"
                disabled={busy}
                onClick={() => void add(s, close)}
                style={{ display: "flex", width: "100%", justifyContent: "flex-start", textAlign: "start" }}
              >
                <span dir="auto">{lang === "ar" && s.nameAr ? s.nameAr : s.name}</span>
              </button>
            ))}
          </>
        )}
      </Popover>
    </span>
  );
}
