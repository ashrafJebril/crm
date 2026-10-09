import { useState } from "react";
import { Modal } from "@/components/Modal";
import { useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import type { Tx } from "@/lib/tx";

export function TestWorkflowModal({
  workflowId,
  onClose,
  tx,
}: {
  workflowId: string;
  onClose: () => void;
  tx: Tx;
}) {
  const [payloadText, setPayloadText] = useState('{\n  "contact": { "id": "", "name": "" }\n}');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ runId: string } | null>(null);

  const testMut = useMutation<{ payload: Record<string, unknown> }, { runId: string }>((input) =>
    api.post(`/workflows/${workflowId}/test`, input),
  );

  async function onRun() {
    setError(null);
    setResult(null);
    try {
      const payload = JSON.parse(payloadText);
      setResult(await testMut.mutate({ payload }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Modal onClose={onClose} label={tx("Test workflow", "اختبار الأتمتة")} width={520}>
      <h3 style={{ marginTop: 0 }}>{tx("Test workflow", "اختبار الأتمتة")}</h3>
      <p className="muted" style={{ fontSize: 12 }}>
        {tx(
          "Paste a JSON trigger payload — this runs the workflow for real (e.g. a real WhatsApp message may be sent).",
          "الصق بيانات JSON للمُشغّل — سيتم تشغيل الأتمتة فعليًا (قد يتم إرسال رسالة واتساب حقيقية).",
        )}
      </p>
      <textarea
        rows={10}
        value={payloadText}
        onChange={(e) => setPayloadText(e.target.value)}
        style={{ width: "100%", fontFamily: "var(--font-mono)", fontSize: 12 }}
      />
      {error && <div style={{ color: "var(--bad)", marginTop: 8 }}>{error}</div>}
      {result && (
        <div style={{ color: "var(--ok)", marginTop: 8 }}>
          {tx("Run started: ", "بدأ التشغيل: ")}
          {result.runId}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
        <button type="button" onClick={onClose}>
          {tx("Close", "إغلاق")}
        </button>
        <button type="button" onClick={onRun}>
          {tx("Run test", "تشغيل الاختبار")}
        </button>
      </div>
    </Modal>
  );
}
