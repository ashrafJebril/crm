import { useId, useState } from "react";
import { api } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import type { Tx } from "@/lib/tx";
import type { Contact, TeamMember } from "@/lib/types";
import { CARD, FIELD_INPUT, FIELD_LABEL, STATUS_ERROR } from "./drawerStyles";
import { lifecycleLabel, lifecycleOptions, normalizeLifecycle } from "./lifecycle";

interface Props {
  tx: Tx;
  contact: Contact;
  /** Called with the server's updated contact after a successful save. */
  onSaved: (c: Contact) => void;
}

interface Draft {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  ownerId: string;
  lifecycle: string;
  marketingOptOut: boolean;
  notALead: boolean;
}

function draftOf(c: Contact): Draft {
  return {
    firstName: c.firstName ?? c.name,
    lastName: c.lastName ?? "",
    phone: c.phone,
    email: c.email ?? "",
    ownerId: c.ownerId ?? "",
    lifecycle: normalizeLifecycle(c.lifecycle),
    marketingOptOut: c.marketingOptOut ?? false,
    notALead: c.notALead ?? false,
  };
}

/** Details card: read-only summary with an Edit mode that PATCHes only changed fields. */
export function ContactDetailsForm({ tx, contact, onSaved }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftOf(contact));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uid = useId();

  // The team list is needed for the owner name (read-only) and the owner picker.
  const teamQ = useFetch<TeamMember[]>(contact.ownerId || editing ? "/team" : null);
  const team = teamQ.data ?? [];
  const owner = team.find((m) => m.id === contact.ownerId);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]): void =>
    setDraft((d) => ({ ...d, [k]: v }));

  const start = (): void => {
    setDraft(draftOf(contact));
    setError(null);
    setEditing(true);
  };

  const save = async (): Promise<void> => {
    const base = draftOf(contact);
    const body: Record<string, unknown> = {};
    if (draft.firstName.trim() !== base.firstName) body.firstName = draft.firstName.trim();
    if (draft.lastName.trim() !== base.lastName) body.lastName = draft.lastName.trim();
    if (draft.phone.trim() !== base.phone) body.phone = draft.phone.trim();
    if (draft.email.trim() !== base.email) {
      // The server rejects "" — clearing an email is an explicit null.
      body.email = draft.email.trim() === "" ? null : draft.email.trim();
    }
    if (draft.ownerId !== base.ownerId) body.ownerId = draft.ownerId === "" ? null : draft.ownerId;
    if (draft.lifecycle !== base.lifecycle) body.lifecycle = draft.lifecycle;
    if (draft.marketingOptOut !== base.marketingOptOut) body.marketingOptOut = draft.marketingOptOut;
    if (draft.notALead !== base.notALead) body.notALead = draft.notALead;

    if (Object.keys(body).length === 0) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await api.patch<Contact>(`/contacts/${contact.id}`, body);
      onSaved(updated);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : tx("Could not save", "تعذّر الحفظ"));
    } finally {
      setBusy(false);
    }
  };

  const lifecycleOpts = lifecycleOptions(draft.lifecycle);
  const lifecycleText = (l: string): string => lifecycleLabel(tx, l);

  if (!editing) {
    return (
      <div style={CARD}>
        <dl
          style={{
            margin: 0,
            display: "grid",
            gridTemplateColumns: "auto 1fr",
            gap: "6px 12px",
            fontSize: 12.5,
          }}
        >
          <dt className="muted">{tx("Email", "البريد الإلكتروني")}</dt>
          <dd style={{ margin: 0, minWidth: 0, overflowWrap: "anywhere" }} dir="auto">
            {contact.email || "—"}
          </dd>
          <dt className="muted">{tx("Owner", "المسؤول")}</dt>
          <dd style={{ margin: 0 }} dir="auto">
            {contact.ownerId ? (owner?.name ?? "…") : tx("Unassigned", "غير معيّن")}
          </dd>
        </dl>
        <button type="button" className="btn sm" style={{ marginTop: 10 }} onClick={start}>
          {tx("Edit details", "تعديل البيانات")}
        </button>
      </div>
    );
  }

  const id = (n: string): string => `${uid}-${n}`;
  return (
    <form
      style={CARD}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div>
          <label htmlFor={id("fn")} className="mono" style={FIELD_LABEL}>
            {tx("First name", "الاسم الأول")}
          </label>
          <input
            id={id("fn")}
            dir="auto"
            style={FIELD_INPUT}
            value={draft.firstName}
            onChange={(e) => set("firstName", e.target.value)}
          />
        </div>
        <div>
          <label htmlFor={id("ln")} className="mono" style={FIELD_LABEL}>
            {tx("Last name", "اسم العائلة")}
          </label>
          <input
            id={id("ln")}
            dir="auto"
            style={FIELD_INPUT}
            value={draft.lastName}
            onChange={(e) => set("lastName", e.target.value)}
          />
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        <label htmlFor={id("ph")} className="mono" style={FIELD_LABEL}>
          {tx("Phone", "الهاتف")}
        </label>
        <input
          id={id("ph")}
          dir="ltr"
          inputMode="tel"
          style={{ ...FIELD_INPUT, textAlign: "start" }}
          value={draft.phone}
          onChange={(e) => set("phone", e.target.value)}
        />
      </div>
      <div style={{ marginTop: 10 }}>
        <label htmlFor={id("em")} className="mono" style={FIELD_LABEL}>
          {tx("Email", "البريد الإلكتروني")}
        </label>
        <input
          id={id("em")}
          dir="auto"
          type="email"
          style={FIELD_INPUT}
          value={draft.email}
          onChange={(e) => set("email", e.target.value)}
        />
      </div>
      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div>
          <label htmlFor={id("ow")} className="mono" style={FIELD_LABEL}>
            {tx("Owner", "المسؤول")}
          </label>
          <select
            id={id("ow")}
            style={FIELD_INPUT}
            value={draft.ownerId}
            onChange={(e) => set("ownerId", e.target.value)}
          >
            <option value="">{tx("Unassigned", "غير معيّن")}</option>
            {team.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
            {/* Keep the current owner selectable while the team list loads. */}
            {draft.ownerId && !team.some((m) => m.id === draft.ownerId) && (
              <option value={draft.ownerId}>…</option>
            )}
          </select>
        </div>
        <div>
          <label htmlFor={id("lc")} className="mono" style={FIELD_LABEL}>
            {tx("Lifecycle", "المرحلة")}
          </label>
          <select
            id={id("lc")}
            style={FIELD_INPUT}
            value={draft.lifecycle}
            onChange={(e) => set("lifecycle", e.target.value)}
          >
            {!draft.lifecycle && <option value="">—</option>}
            {lifecycleOpts.map((l) => (
              <option key={l} value={l} dir="auto">
                {lifecycleText(l)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, fontSize: 12.5 }}>
        <input
          type="checkbox"
          checked={draft.marketingOptOut}
          onChange={(e) => set("marketingOptOut", e.target.checked)}
        />
        {tx("Opted out of marketing", "ألغى الاشتراك في التسويق")}
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 12.5 }}>
        <input
          type="checkbox"
          checked={draft.notALead}
          onChange={(e) => set("notALead", e.target.checked)}
        />
        {tx("Not a lead", "ليس عميلًا محتملًا")}
      </label>
      {error && (
        <div role="alert" style={STATUS_ERROR} dir="auto">
          {error}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button type="submit" className="btn sm primary" disabled={busy}>
          {busy ? tx("Saving…", "جارٍ الحفظ…") : tx("Save", "حفظ")}
        </button>
        <button
          type="button"
          className="btn sm ghost"
          disabled={busy}
          onClick={() => setEditing(false)}
        >
          {tx("Cancel", "إلغاء")}
        </button>
      </div>
    </form>
  );
}
