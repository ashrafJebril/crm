import { useState } from "react";
import { api } from "@/api/client";
import type { Day1Step, Day1StepKey } from "@/lib/homeTypes";
import type { Tx } from "@/lib/tx";
import { day1Progress } from "./homeModel";

const STEP_COPY: Record<Day1StepKey, [string, string]> = {
  connect_channel: ["Connect a channel", "اربط قناة"],
  add_knowledge: ["Teach the AI about your business", "علّم الذكاء الاصطناعي عن نشاطك"],
  invite_team: ["Invite your team", "ادعُ فريقك"],
  set_pipeline: ["Set up your pipeline", "جهّز مسار المبيعات"],
  add_services: ["Add your services", "أضف خدماتك"],
  first_reply: ["Send your first reply", "أرسل أول رد"],
};

interface Props {
  steps: Day1Step[];
  tx: Tx;
  /** Called after the member dismissed the Day-1 home. */
  onDismissed: () => void;
  /** False for super-admin / impersonation sessions: no Dismiss button. */
  canDismiss?: boolean;
}

/** SP-11 Day-1 home: setup steps computed from data, until set up or dismissed. */
export function Day1Home({ steps, tx, onDismissed, canDismiss = true }: Props) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const p = day1Progress(steps);
  const dismiss = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await api.post("/home/day1/dismiss");
      onDismissed();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };
  return (
    <section className="card" style={{ padding: 16 }} aria-label={tx("Get set up", "ابدأ الإعداد")}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBlockEnd: 10 }}>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>{tx("Get set up", "ابدأ الإعداد")}</h2>
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
            <bdi>
              {p.done}/{p.total}
            </bdi>{" "}
            {tx("steps done", "خطوات مكتملة")}
          </div>
        </div>
        {canDismiss && (
          <button type="button" className="btn" onClick={() => void dismiss()} disabled={busy}>
            {tx("Dismiss", "إخفاء")}
          </button>
        )}
      </div>
      {failed && (
        <div role="alert" style={{ fontSize: 12, color: "var(--bad)", marginBlockEnd: 8 }}>
          {tx("Couldn't hide the setup steps. Try again.", "تعذّر إخفاء خطوات الإعداد. حاول مرة أخرى.")}
        </div>
      )}
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={p.pct}
        style={{ height: 6, borderRadius: 3, background: "var(--line)", overflow: "hidden", marginBlockEnd: 12 }}
      >
        <div style={{ height: "100%", inlineSize: `${p.pct}%`, background: "var(--accent)" }} />
      </div>
      <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
        {steps.map((s) => {
          const [en, ar] = STEP_COPY[s.key];
          return (
            <li key={s.key} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span
                aria-hidden
                style={{
                  inlineSize: 18,
                  blockSize: 18,
                  borderRadius: "50%",
                  border: "1.5px solid var(--accent)",
                  background: s.done ? "var(--accent)" : "transparent",
                  flexShrink: 0,
                }}
              />
              {s.done ? (
                <span style={{ color: "var(--ink-3)", textDecoration: "line-through" }}>{tx(en, ar)}</span>
              ) : (
                <a href={s.href}>{tx(en, ar)}</a>
              )}
              <span style={{ position: "absolute", inlineSize: 1, blockSize: 1, overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap" }}>
                {s.done ? tx("Done", "مكتملة") : tx("Not done", "غير مكتملة")}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
