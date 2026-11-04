import { useState } from "react";
import { Modal } from "@/components/Modal";
import { useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import type { Tx } from "@/lib/tx";
import type { WorkflowTriggerType } from "@/lib/types";

/** Starter payloads shaped like what each trigger delivers as `trigger.*`. */
const SAMPLE_PAYLOAD: Record<WorkflowTriggerType, Record<string, unknown>> = {
  contact_created: { contact: { id: "", name: "Lina", phone: "", lifecycle: "lead" } },
  message_received: {
    contact: { id: "", name: "Lina" },
    message: { body: "Hi, is this still available?" },
    conversation: { id: "", channel: "whatsapp" },
  },
  ticket_created: { ticket: { id: "", title: "Order not delivered", number: 1 } },
  ticket_stage_changed: { ticket: { id: "", title: "Order not delivered", stageId: "" } },
  schedule: {},
  webhook: {},
  appointment_completed: {
    appointment: { id: "", contactId: "", service: "Haircut", serviceAr: "قص شعر", startAt: "", durationMin: 30 },
    contact: { id: "", name: "Lina", phone: "" },
  },
  sale_completed: {
    contact: { id: "", name: "Lina", phone: "" },
    sale: {
      id: "test-sale",
      receiptNumber: "SAL-1042",
      total: "25.00",
      paid: "25.00",
      currency: "JOD",
      date: "",
      branch: "Abdoun",
      itemCount: 2,
      itemsText: "Haircut ×1 (15.00) · Beard trim ×1 (10.00)",
    },
  },
};

export function TestWorkflowModal({
  workflowId,
  triggerType,
  onClose,
  tx,
}: {
  workflowId: string;
  triggerType: WorkflowTriggerType;
  onClose: () => void;
  tx: Tx;
}) {
  const [payloadText, setPayloadText] = useState(() => JSON.stringify(SAMPLE_PAYLOAD[triggerType], null, 2));
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
        className="wf-input mono"
        dir="ltr"
        rows={10}
        value={payloadText}
        onChange={(e) => setPayloadText(e.target.value)}
        aria-label={tx("Trigger payload (JSON)", "بيانات المُشغّل (JSON)")}
        style={{ fontSize: 12 }}
      />
      {error && <div style={{ color: "var(--bad)", marginTop: 8 }}>{error}</div>}
      {result && (
        <div style={{ color: "var(--ok)", marginTop: 8 }}>
          {tx("Run started: ", "بدأ التشغيل: ")}
          {result.runId}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
        <button type="button" className="btn" onClick={onClose}>
          {tx("Close", "إغلاق")}
        </button>
        <button type="button" className="btn primary" onClick={onRun} disabled={testMut.loading}>
          {tx("Run test", "تشغيل الاختبار")}
        </button>
      </div>
    </Modal>
  );
}
