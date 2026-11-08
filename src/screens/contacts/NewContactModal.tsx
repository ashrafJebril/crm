import { useState, type CSSProperties, type FormEvent } from "react";
import type { Tx } from "@/lib/tx";
import type { Contact, TagRow, TeamMember } from "@/lib/types";
import { api } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import { Modal } from "@/components/Modal";
import { IconPlus } from "@/icons";
import { LIFECYCLES, lifecycleLabel } from "./lifecycle";

const INPUT: CSSProperties = {
  width: "100%",
  background: "var(--bg-2)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r)",
  padding: "8px 12px",
  color: "var(--ink)",
  fontSize: 13,
  marginTop: 6,
  outline: "none",
  fontFamily: "inherit",
};
const LABEL: CSSProperties = { fontSize: 11, textTransform: "uppercase", color: "var(--ink-3)", marginTop: 12, display: "block" };

interface Props {
  tx: Tx;
  onClose: () => void;
  onCreated: () => void;
}

/** Create a contact: first/last name, phone, email, owner, lifecycle and tags.
 *  Empty email is omitted (the API rejects ""). */
export function NewContactModal({ tx, onClose, onCreated }: Props) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [lifecycle, setLifecycle] = useState("lead");
  const [tags, setTags] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const teamQ = useFetch<TeamMember[]>("/team");
  const tagsQ = useFetch<TagRow[]>("/tags");
  const catalog = tagsQ.data ?? [];

  const addTag = (name: string) => {
    const n = name.trim();
    if (n && !tags.includes(n)) setTags([...tags, n]);
  };
  const commitDraft = () => {
    draft.split(",").forEach(addTag);
    setDraft("");
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!firstName.trim() || !phone.trim()) {
      setError(tx("First name and phone are required.", "الاسم الأول والهاتف مطلوبان."));
      return;
    }
    const finalTags = [...tags];
    draft.split(",").map((s) => s.trim()).filter(Boolean).forEach((n) => {
      if (!finalTags.includes(n)) finalTags.push(n);
    });
    const body: Record<string, unknown> = {
      firstName: firstName.trim(),
      phone: phone.trim(),
      lifecycle,
      industry: "—",
      source: "Manual",
      tags: finalTags,
    };
    if (lastName.trim()) body.lastName = lastName.trim();
    if (email.trim()) body.email = email.trim();
    if (ownerId) body.ownerId = ownerId;
    setSubmitting(true);
    setError(null);
    api
      .post<Contact>("/contacts", body)
      .then(() => {
        onCreated();
        onClose();
      })
      .catch((err) => setError(err instanceof Error ? err.message : tx("Request failed", "فشل الطلب")))
      .finally(() => setSubmitting(false));
  };

  return (
    <Modal onClose={onClose} width={480} label="New contact">
      <form onSubmit={onSubmit}>
        <h3 style={{ margin: 0, fontSize: 16 }}>{tx("New contact", "جهة جديدة")}</h3>
        <p style={{ margin: "4px 0 8px", color: "var(--ink-2)", fontSize: 13 }}>
          {tx("Add a contact to your workspace.", "أضف جهة اتصال إلى مساحة العمل.")}
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label className="mono" style={LABEL}>{tx("First name", "الاسم الأول")}</label>
            <input className="input" dir="auto" style={INPUT} value={firstName} onChange={(e) => setFirstName(e.target.value)} />
          </div>
          <div>
            <label className="mono" style={LABEL}>{tx("Last name", "اسم العائلة")}</label>
            <input className="input" dir="auto" style={INPUT} value={lastName} onChange={(e) => setLastName(e.target.value)} />
          </div>
        </div>
        <label className="mono" style={LABEL}>{tx("Phone", "الهاتف")}</label>
        <input className="input" dir="ltr" style={INPUT} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+966 50 000 0000" />
        <label className="mono" style={LABEL}>{tx("Email", "البريد الإلكتروني")}</label>
        <input className="input" dir="ltr" type="email" style={INPUT} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label className="mono" style={LABEL}>{tx("Owner", "المالك")}</label>
            <select style={INPUT} value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
              <option value="">{tx("Unassigned", "غير مسند")}</option>
              {(teamQ.data ?? []).map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mono" style={LABEL}>{tx("Lifecycle", "المرحلة")}</label>
            <select style={INPUT} value={lifecycle} onChange={(e) => setLifecycle(e.target.value)}>
              {LIFECYCLES.map((l) => (
                <option key={l} value={l}>{lifecycleLabel(tx, l)}</option>
              ))}
            </select>
          </div>
        </div>
        <label className="mono" style={LABEL}>{tx("Tags", "الوسوم")}</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
          {tags.map((n) => (
            <button
              key={n}
              type="button"
              dir="auto"
              className="btn sm primary"
              aria-label={tx(`Remove tag ${n}`, `إزالة الوسم ${n}`)}
              onClick={() => setTags(tags.filter((x) => x !== n))}
            >
              {n} ×
            </button>
          ))}
          {catalog.filter((t) => !tags.includes(t.name)).slice(0, 12).map((t) => (
            <button key={t.id} type="button" dir="auto" className="btn sm ghost" onClick={() => addTag(t.name)}>
              + {t.name}
            </button>
          ))}
        </div>
        <input
          className="input"
          dir="auto"
          style={INPUT}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitDraft();
            }
          }}
          placeholder={tx("Type a tag and press Enter…", "اكتب وسمًا واضغط Enter…")}
        />
        {error && <div role="alert" style={{ marginTop: 12, color: "var(--bad)", fontSize: 12 }}>{error}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20 }}>
          <button type="button" className="btn ghost" onClick={onClose} disabled={submitting}>{tx("Cancel", "إلغاء")}</button>
          <button type="submit" className="btn primary" disabled={submitting}>
            <IconPlus w={13} />
            {submitting ? tx("Saving…", "جارٍ الحفظ…") : tx("Create", "إنشاء")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
