/**
 * The pipeline complaint / escalation tickets go to. Separate from the sales
 * pipeline on purpose: nearly every conversation already has an open sales
 * ticket (PipelineAutomationService.onInboundMessage), and a complaint is not
 * a deal. Its groupKeys deliberately avoid "new"/"contacted", which is how the
 * sales automation picks its pipeline — it must never adopt this one.
 */
export const SUPPORT_PIPELINE = { key: "support", name: "Support", nameAr: "الدعم" } as const;

export const SUPPORT_STAGES = [
  { key: "open",        label: "New",         labelAr: "جديدة",           color: "bad",  order: 0, groupKey: "support_open",        slaMinutes: 60 * 2,  isTerminal: false, isWon: false },
  { key: "in_progress", label: "In progress", labelAr: "قيد المعالجة",    color: "warn", order: 1, groupKey: "support_in_progress", slaMinutes: 60 * 24, isTerminal: false, isWon: false },
  { key: "resolved",    label: "Resolved",    labelAr: "تم الحل",         color: "ok",   order: 2, groupKey: "support_resolved",    slaMinutes: null,    isTerminal: true,  isWon: true  },
  { key: "dismissed",   label: "Dismissed",   labelAr: "مغلقة دون إجراء", color: "ink",  order: 3, groupKey: "support_dismissed",   slaMinutes: null,    isTerminal: true,  isWon: false },
] as const;
