import type { Tx } from "@/lib/tx";

export function KnowledgeTab({ tx, canEdit }: { tx: Tx; canEdit: boolean }) {
  void canEdit; // unused until Task 11 fills in this tab
  return <div className="muted">{tx("Coming soon.", "قريبًا.")}</div>;
}
