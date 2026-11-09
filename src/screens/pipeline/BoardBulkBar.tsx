import { useState } from "react";
import { usePermissions } from "@/auth/usePermissions";
import { useToast } from "@/components/Toast";
import { ApiError } from "@/api/client";
import type { Tx } from "@/lib/tx";
import type { Lang, TeamMember } from "@/lib/types";
import { LostReasonModal } from "./LostReasonModal";
import { useBulkTickets, type BulkVars } from "./hooks/useBoardData";
import { bulkResultText, ticketActionError } from "./boardQuery";

interface Props {
  tx: Tx;
  lang: Lang;
  pipelineId: string;
  /** Leads pipelines only: shows "Not a lead". */
  isLeads: boolean;
  ids: string[];
  team: TeamMember[];
  onClear: () => void;
}

const btn = {
  background: "var(--bg-2)",
  border: "1px solid var(--line)",
  borderRadius: 8,
  padding: "6px 12px",
  color: "var(--ink)",
  fontSize: 12.5,
  cursor: "pointer",
  height: 32,
} as const;

/** Floating action bar for the selected cards/rows: assign, mark lost, not a lead. */
export function BoardBulkBar({ tx, lang, pipelineId, isLeads, ids, team, onClear }: Props) {
  const { can } = usePermissions();
  const { toast } = useToast();
  const bulk = useBulkTickets(pipelineId);
  const [lostOpen, setLostOpen] = useState(false);
  const canUpdate = can("tickets.update");
  const canNotLead = isLeads && canUpdate && can("contacts.update");
  const noPerm = tx("You don't have permission", "ليس لديك صلاحية");

  if (ids.length === 0) return null;

  const run = (v: BulkVars) => {
    bulk.mutate(v, {
      onSuccess: (r) => {
        toast(bulkResultText(tx, r), r.affected > 0 ? "success" : "info");
        onClear();
      },
      onError: (e) => toast(ticketActionError(tx, e instanceof ApiError ? e.message : e instanceof Error ? e.message : ""), "error"),
    });
  };

  return (
    <>
      <div
        role="toolbar"
        aria-label={tx("Bulk actions", "إجراءات جماعية")}
        style={{
          position: "fixed",
          insetInlineStart: "50%",
          transform: "translateX(-50%)",
          bottom: 20,
          zIndex: 50,
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          padding: "8px 12px",
          background: "var(--bg-1)",
          border: "1px solid var(--line)",
          borderRadius: 12,
          boxShadow: "0 8px 30px rgba(0,0,0,0.3)",
          maxWidth: "calc(100vw - 32px)",
        }}
      >
        <strong style={{ fontSize: 12.5 }}>{tx(`${ids.length} selected`, `${ids.length} محددة`)}</strong>
        <select
          aria-label={tx("Assign to", "إسناد إلى")}
          value=""
          disabled={!canUpdate || bulk.isPending}
          title={canUpdate ? undefined : noPerm}
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return;
            run({ ids, op: "assign", ownerId: v === "none" ? null : v });
          }}
          style={btn}
        >
          <option value="">{tx("Assign…", "إسناد…")}</option>
          <option value="none">{tx("Unassign", "إلغاء الإسناد")}</option>
          {team.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <button type="button" disabled={!canUpdate || bulk.isPending} title={canUpdate ? undefined : noPerm} onClick={() => setLostOpen(true)} style={btn}>
          {tx("Mark lost", "تحديد كخاسرة")}
        </button>
        {isLeads ? (
          <button
            type="button"
            disabled={!canNotLead || bulk.isPending}
            title={canNotLead ? undefined : noPerm}
            onClick={() => run({ ids, op: "notALead" })}
            style={btn}
          >
            {tx("Not a lead", "ليس عميلاً محتملاً")}
          </button>
        ) : null}
        <button type="button" onClick={onClear} style={{ ...btn, background: "transparent", color: "var(--ink-2)" }}>
          {tx("Clear", "مسح")}
        </button>
      </div>
      {lostOpen ? (
        <LostReasonModal
          lang={lang}
          pipelineId={pipelineId}
          heading={tx(`Lost reason for ${ids.length} cards`, `سبب الخسارة لـ ${ids.length} بطاقة`)}
          onCancel={() => setLostOpen(false)}
          onConfirm={(reason) => {
            setLostOpen(false);
            run({ ids, op: "lost", lostReasonId: reason.id });
          }}
        />
      ) : null}
    </>
  );
}
