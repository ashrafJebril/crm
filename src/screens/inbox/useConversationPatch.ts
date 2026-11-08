import { useState } from "react";
import { api, ApiError } from "@/api/client";
import type { Tx } from "@/lib/tx";

export type PatchResult = "ok" | "conflict" | "error";

/**
 * Shared PATCH /conversations/:id logic: always sends `version`; a 409 refetches
 * (awaited) and reports the conflict note. `busy` stays set until the refetch
 * lands, so the next action always carries the fresh version.
 */
export function useConversationPatch(
  tx: Tx,
  onChanged: () => Promise<unknown> | void,
) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [escalateError, setEscalateError] = useState<string | null>(null);

  async function patch(
    conv: { id: string; version?: number },
    body: Record<string, unknown>,
  ): Promise<PatchResult> {
    const isEscalate = body.escalated === true;
    if (busy) return "error";
    setBusy(true);
    setNote(null);
    setEscalateError(null);
    try {
      await api.patch(`/conversations/${conv.id}`, { ...body, version: conv.version ?? 0 });
      await onChanged();
      return "ok";
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        await Promise.resolve(onChanged()).catch(() => undefined);
        const conflictMsg = tx(
          "Someone else just changed this conversation — showing the latest.",
          "قام شخص آخر بتعديل هذه المحادثة للتو — نعرض أحدث نسخة.",
        );
        setNote(conflictMsg);
        // Keep the escalate dialog (and the typed reason) open with the message inside it.
        if (isEscalate) setEscalateError(conflictMsg);
        return "conflict";
      }
      const msg =
        e instanceof ApiError && e.message
          ? e.message
          : tx("Couldn't update the conversation", "تعذّر تحديث المحادثة");
      setNote(msg);
      if (isEscalate) setEscalateError(msg);
      return "error";
    } finally {
      setBusy(false);
    }
  }

  return { patch, busy, note, setNote, escalateError, setEscalateError };
}
