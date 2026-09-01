import { useMemo, useRef, type RefObject } from "react";
import { TEMPLATE_VARIABLES } from "@/api/aiWorkflows";
import { Field, inputStyle } from "../form";

const SAMPLE: Record<string, string> = {
  "customer.name": "Sara", "customer.email": "sara@example.com", "customer.phone": "+962 79 000 0000",
  "booking.id": "BK-1042", "booking.status": "BOOKED", "booking.date": "3 September 2026",
  "booking.time": "10:30", "booking.previousDate": "2 September 2026", "booking.previousTime": "09:00",
  "branch.name": "Amman", "branch.timezone": "Asia/Amman", "services.names": "Hair colour, Blow dry", "services.count": "2",
};

export function invalidTemplateVariables(text: string): string[] {
  const allowed = new Set<string>(TEMPLATE_VARIABLES);
  return [...text.matchAll(/{{\s*([^{}]+?)\s*}}/g)]
    .map((m) => m[1].trim())
    .filter((name, index, all) => !allowed.has(name) && all.indexOf(name) === index);
}

function renderSample(text: string) {
  return text.replace(/{{\s*([^{}]+?)\s*}}/g, (_, name: string) => SAMPLE[name.trim()] ?? `{{${name}}}`);
}

export function TemplateEditor({
  label,
  subject,
  body,
  onChange,
}: {
  label: string;
  subject: string;
  body: string;
  onChange: (next: { subject: string; body: string }) => void;
}) {
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const invalid = useMemo(() => invalidTemplateVariables(`${subject}\n${body}`), [subject, body]);

  const insert = (variable: string, target: "subject" | "body") => {
    const token = `{{${variable}}}`;
    const el = (target === "subject" ? subjectRef : bodyRef) as RefObject<HTMLInputElement | HTMLTextAreaElement>;
    const value = target === "subject" ? subject : body;
    const start = el.current?.selectionStart ?? value.length;
    const end = el.current?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    onChange(target === "subject" ? { subject: next, body } : { subject, body: next });
  };

  return (
    <div style={{ border: "1px solid var(--line-soft)", borderRadius: 10, padding: 14, display: "grid", gap: 12 }}>
      <strong style={{ fontSize: 13 }}>{label}</strong>
      <Field label="Subject">
        <input ref={subjectRef} style={inputStyle} value={subject} maxLength={200} onChange={(e) => onChange({ subject: e.target.value, body })} />
      </Field>
      <Field label="Message body">
        <textarea ref={bodyRef} style={{ ...inputStyle, height: 120, padding: 12, resize: "vertical" }} value={body} maxLength={20000} onChange={(e) => onChange({ subject, body: e.target.value })} />
      </Field>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <span className="muted" style={{ fontSize: 11 }}>Insert:</span>
        {TEMPLATE_VARIABLES.map((v) => (
          <span key={v} style={{ display: "inline-flex", gap: 2 }}>
            <button type="button" className="btn ghost" style={{ padding: "3px 6px", fontSize: 10 }} onClick={() => insert(v, "body")}>{v}</button>
          </span>
        ))}
      </div>
      {invalid.length > 0 && <div style={{ color: "var(--bad)", fontSize: 12 }}>Unknown variables: {invalid.join(", ")}</div>}
      <div style={{ background: "var(--bg-2)", borderRadius: 8, padding: 12 }}>
        <div className="mono muted" style={{ fontSize: 10, marginBottom: 6 }}>SAFE SAMPLE PREVIEW</div>
        <strong style={{ display: "block", fontSize: 13 }}>{renderSample(subject) || "—"}</strong>
        <div style={{ whiteSpace: "pre-wrap", fontSize: 12, marginTop: 6 }}>{renderSample(body) || "—"}</div>
      </div>
    </div>
  );
}
