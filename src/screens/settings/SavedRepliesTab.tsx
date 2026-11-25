import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { SavedRepliesManager } from "../inbox/SavedRepliesManager";

export function SavedRepliesTab() {
  const { t } = useTweaks();
  return <SavedRepliesManager tx={makeTx(t.lang)} />;
}
