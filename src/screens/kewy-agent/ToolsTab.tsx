import type { Tx } from "@/lib/tx";

export function ToolsTab({ tx, canEdit }: { tx: Tx; canEdit: boolean }) {
  void canEdit; // unused until Task 12 fills in this tab
  return <div className="muted">{tx("Coming soon.", "قريبًا.")}</div>;
}
