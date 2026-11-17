import { useState } from "react";
import { api } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import { useAuth } from "@/auth/context";
import { usePermissions } from "@/auth/usePermissions";
import { useTeam } from "@/components/activities/activityApi";
import { useToast } from "@/components/Toast";
import { WhatsAppGate } from "@/components/WhatsAppGate";
import type { Permission } from "@/lib/permissions";
import type { LifecycleKey, LifecycleList, LifecycleRecipientKind, LifecycleRow } from "@/lib/types";
import { makeTx, type Tx } from "@/lib/tx";
import { useTweaks } from "@/tweaks/context";
import { EditLifecycleMessage } from "./lifecycle/EditLifecycleMessage";
import { AUDIENCE_COPY, GROUPS, LIFECYCLE_CATALOG, RECIPIENT_COPY, customAutomationHref, skipReasonLabel } from "./lifecycle/lifecycleCatalog";
import { lifecycleErrorText } from "./lifecycle/lifecycleErrors";
import { PILL_COPY, offsetChoices, offsetLabel, rowView, skippedTotal, syncedText, type Pill } from "./lifecycle/lifecycleRows";

const PILL_TONE: Record<Pill, string> = {
  not_set_up: "",
  not_submitted: "warn",
  paused: "warn",
  in_review: "",
  rejected: "bad",
  approved: "ok",
};

/** SP-24 Settings → Automatic messages (workflows.view). */
export function LifecycleTab() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { can } = usePermissions();
  const { toast } = useToast();
  const { activeWorkspace } = useAuth();
  const q = useFetch<LifecycleList>("/lifecycle");
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ row: LifecycleRow; lang: "ar" | "en" } | null>(null);
  const data = q.data;

  const run = async (id: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(id);
    try {
      await fn();
      if (ok) toast(ok, "success");
    } catch (e) {
      toast(lifecycleErrorText(e, tx), "error");
    } finally {
      setBusy(null);
    }
  };

  const replaceRow = (next: LifecycleRow) =>
    q.setData((prev) => (prev ? { ...prev, rows: prev.rows.map((r) => (r.key === next.key ? next : r)) } : prev));

  const setup = (key: LifecycleKey) =>
    run(key, async () => replaceRow(await api.post<LifecycleRow>(`/lifecycle/${key}/setup`)), tx("Set up. WhatsApp is reviewing the messages.", "تم الإعداد. يراجع واتساب الرسائل الآن."));
  const patch = (key: LifecycleKey, body: Record<string, unknown>, ok?: string) =>
    run(key, async () => replaceRow(await api.patch<LifecycleRow>(`/lifecycle/${key}`, body)), ok);
  const sync = () =>
    run("sync", async () => {
      const res = await api.post<{ rows: LifecycleRow[]; lastSyncedAt: string | null }>("/lifecycle/sync");
      q.setData((prev) => (prev ? { ...prev, rows: res.rows, lastSyncedAt: res.lastSyncedAt } : prev));
    }, tx("Statuses updated from WhatsApp", "تم تحديث الحالات من واتساب"));

  const canSync = can("templates.view");

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minInlineSize: 220 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{tx("Automatic messages", "الرسائل التلقائية")}</h2>
          <div className="muted" style={{ fontSize: 12.5 }}>
            {tx(
              "WhatsApp messages sent for bookings and tickets, and in-app alerts for your team.",
              "رسائل واتساب تُرسل عند الحجوزات والتذاكر، وتنبيهات داخل التطبيق لفريقك.",
            )}
          </div>
        </div>
        {data && (
          <span className="muted" style={{ fontSize: 12 }}>
            {tx(...syncedText(data.lastSyncedAt, activeWorkspace?.timezone, t.lang))}
          </span>
        )}
        {canSync && (
          <button type="button" className="btn" disabled={busy === "sync" || !data} onClick={() => void sync()}>
            {busy === "sync" ? tx("Syncing…", "جارٍ المزامنة…") : tx("Sync", "مزامنة")}
          </button>
        )}
      </div>

      {data && <WhatsAppGate connected={data.whatsappConnected} tx={tx} />}

      {q.error && !data && (
        <div role="alert" style={{ color: "var(--bad)", fontSize: 13 }}>
          {tx("Couldn't load automatic messages.", "تعذّر تحميل الرسائل التلقائية.")}
        </div>
      )}
      {!data && !q.error && <div className="muted">{tx("Loading…", "جارٍ التحميل…")}</div>}

      {data &&
        GROUPS.map((g) => {
          const rows = data.rows.filter((r) => LIFECYCLE_CATALOG[r.key]?.group === g.id);
          if (!rows.length) return null;
          return (
            <section key={g.id} style={{ display: "grid", gap: 10 }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>{tx(g.title[0], g.title[1])}</h3>
              {rows.map((r) => (
                <LifecycleRowCard
                  key={r.key}
                  row={r}
                  tx={tx}
                  lang={t.lang}
                  can={can}
                  busy={busy === r.key}
                  onSetup={() => void setup(r.key)}
                  onToggle={(on) => void patch(r.key, { enabled: on }, on ? tx("Turned on", "تم التفعيل") : tx("Turned off", "تم الإيقاف"))}
                  onRecipient={(kind, userIds) => void patch(r.key, { recipient: { kind, userIds } })}
                  onOffset={(m) => void patch(r.key, { offsetMinutes: m })}
                  onEdit={(lang) => setEditing({ row: r, lang })}
                />
              ))}
            </section>
          );
        })}

      {editing && (
        <EditLifecycleMessage
          row={editing.row}
          initialLang={editing.lang}
          tx={tx}
          onClose={() => setEditing(null)}
          onSaved={() => void q.refetch()}
        />
      )}
    </div>
  );
}

function Switch({ on, disabled, label, title, onChange }: { on: boolean; disabled: boolean; label: string; title?: string; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!on)}
      style={{ background: "transparent", border: 0, padding: 0, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }}
    >
      <span style={{ display: "block", position: "relative", inlineSize: 34, blockSize: 20, borderRadius: 999, background: on ? "var(--accent)" : "var(--bg-3)", border: "1px solid var(--line)" }}>
        <span style={{ position: "absolute", insetBlockStart: 2, insetInlineStart: on ? 16 : 2, inlineSize: 14, blockSize: 14, borderRadius: "50%", background: on ? "var(--accent-ink)" : "var(--ink-2)" }} />
      </span>
    </button>
  );
}

function LifecycleRowCard({
  row,
  tx,
  lang,
  can,
  busy,
  onSetup,
  onToggle,
  onRecipient,
  onOffset,
  onEdit,
}: {
  row: LifecycleRow;
  tx: Tx;
  lang: "en" | "ar";
  can: (p: Permission) => boolean;
  busy: boolean;
  onSetup: () => void;
  onToggle: (on: boolean) => void;
  onRecipient: (kind: LifecycleRecipientKind, userIds: string[]) => void;
  onOffset: (minutes: number) => void;
  onEdit: (lang: "ar" | "en") => void;
}) {
  const v = rowView(row, can);
  const audience = AUDIENCE_COPY[row.audience];
  const skipped = skippedTotal(row);
  const reasons = Object.entries(row.skipped30d ?? {})
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => `${skipReasonLabel(reason, lang)} ${n}`)
    .join(lang === "ar" ? "، " : ", ");
  const rejectedLang = v.variants.find((x) => x.pill === "rejected" || x.pill === "not_submitted")?.lang ?? "ar";
  const title = tx(v.title[0], v.title[1]);

  return (
    <div className="card" style={{ padding: 14, display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minInlineSize: 220 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <strong style={{ fontSize: 14 }}>{title}</strong>
            <span className="chip" style={{ fontSize: 11 }}>{tx(audience[0], audience[1])}</span>
            {v.statusPill && <span className={`badge ${PILL_TONE[v.statusPill]}`.trim()}>{tx(PILL_COPY[v.statusPill][0], PILL_COPY[v.statusPill][1])}</span>}
          </div>
          <div className="muted" style={{ fontSize: 12.5, marginBlockStart: 2 }}>{tx(v.description[0], v.description[1])}</div>
        </div>
        {v.switch.shown && (
          <div style={{ display: "grid", justifyItems: "end", gap: 4, maxInlineSize: 260 }}>
            <Switch
              on={v.switch.on}
              disabled={busy || v.switch.disabled}
              label={tx(`${title}: on or off`, `${title}: تشغيل أو إيقاف`)}
              title={v.switch.reason ? tx(v.switch.reason[0], v.switch.reason[1]) : undefined}
              onChange={onToggle}
            />
            {v.switch.reason && <span style={{ fontSize: 11.5, color: "var(--ink-3)", textAlign: "end" }}>{tx(v.switch.reason[0], v.switch.reason[1])}</span>}
          </div>
        )}
      </div>

      {v.variants.length > 0 && (
        <div style={{ display: "grid", gap: 4 }}>
          {v.variants.map((x) => (
            <div key={x.lang} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, flexWrap: "wrap" }}>
              <span style={{ minInlineSize: 70 }}>{x.lang === "ar" ? tx("Arabic", "العربية") : tx("English", "الإنجليزية")}</span>
              <span className={`badge ${PILL_TONE[x.pill]}`.trim()}>{tx(PILL_COPY[x.pill][0], PILL_COPY[x.pill][1])}</span>
              {x.name && <bdi className="mono muted" style={{ fontSize: 11 }}>{x.name}</bdi>}
              {x.reason && <span style={{ color: x.pill === "rejected" ? "var(--bad)" : "var(--ink-3)" }}>{tx(x.reason[0], x.reason[1])}</span>}
            </div>
          ))}
        </div>
      )}

      {v.actions.includes("recipient") && <RecipientPicker row={row} tx={tx} disabled={busy} onChange={onRecipient} />}

      {v.actions.includes("offset") && (
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
          <span>{tx("Send the reminder", "أرسل التذكير")}</span>
          <select value={row.offsetMinutes ?? 1440} disabled={busy} onChange={(e) => onOffset(Number(e.target.value))}>
            {offsetChoices(row.offsetMinutes).map((m) => {
              const l = offsetLabel(m);
              return (
                <option key={m} value={m}>
                  {tx(l[0], l[1])}
                </option>
              );
            })}
          </select>
        </label>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {v.actions.includes("setup") && (
          <button type="button" className="btn primary sm" disabled={busy} onClick={onSetup}>
            {tx("Set up", "إعداد")}
          </button>
        )}
        {v.actions.includes("resubmit") && (
          <button type="button" className="btn sm" disabled={busy} onClick={() => onEdit(rejectedLang)}>
            {tx("Fix and resubmit", "تصحيح وإعادة الإرسال")}
          </button>
        )}
        {v.actions.includes("edit") && (
          <button type="button" className="btn ghost sm" disabled={busy} onClick={() => onEdit("ar")}>
            {tx("Edit message", "تعديل الرسالة")}
          </button>
        )}
        {can("workflows.create") && (
          <a className="btn ghost sm" href={customAutomationHref(row.key)} style={{ textDecoration: "none" }}>
            {tx("Custom automations", "أتمتة مخصصة")}
          </a>
        )}
        {row.setUp && (
          <span className="muted" style={{ fontSize: 12, marginInlineStart: "auto" }}>
            {tx("Sent in the last 30 days:", "أُرسلت خلال آخر 30 يومًا:")} <bdi>{row.sent30d}</bdi>
            {" · "}
            {tx("Skipped:", "تم تخطيها:")} <bdi>{skipped}</bdi>
            {skipped > 0 && reasons && (
              <>
                {" "}(<bdi>{reasons}</bdi>)
              </>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

function RecipientPicker({
  row,
  tx,
  disabled,
  onChange,
}: {
  row: LifecycleRow;
  tx: Tx;
  disabled: boolean;
  onChange: (kind: LifecycleRecipientKind, userIds: string[]) => void;
}) {
  const team = useTeam();
  const saved = row.recipient.kind === "customer" ? "permitted" : row.recipient.kind;
  const [mode, setMode] = useState<LifecycleRecipientKind>(saved);
  const [picked, setPicked] = useState<string[]>(row.recipient.userIds);
  return (
    <div style={{ display: "grid", gap: 6, fontSize: 12.5 }}>
      <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span>{tx("Notify", "أبلغ")}</span>
        <select
          value={mode}
          disabled={disabled}
          onChange={(e) => {
            const k = e.target.value as LifecycleRecipientKind;
            setMode(k);
            // Specific members needs a selection first; it is saved from the list below.
            if (k !== "members") onChange(k, []);
            else if (picked.length) onChange("members", picked);
          }}
        >
          {(["assignee", "permitted", "members"] as const).map((k) => (
            <option key={k} value={k}>
              {tx(RECIPIENT_COPY[k][0], RECIPIENT_COPY[k][1])}
            </option>
          ))}
        </select>
      </label>
      {mode === "members" && (
        <fieldset style={{ border: "1px solid var(--line-soft)", borderRadius: 8, padding: 8, margin: 0, display: "flex", flexWrap: "wrap", gap: 10 }}>
          <legend style={{ fontSize: 12, paddingInline: 4 }}>{tx("Specific members", "أعضاء محددون")}</legend>
          {team.map((m) => (
            <label key={m.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input
                type="checkbox"
                checked={picked.includes(m.id)}
                disabled={disabled}
                onChange={(e) => setPicked((p) => (e.target.checked ? [...p, m.id] : p.filter((x) => x !== m.id)))}
              />
              <bdi>{m.name}</bdi>
            </label>
          ))}
          <button
            type="button"
            className="btn sm"
            disabled={disabled || picked.length === 0}
            onClick={() => onChange("members", picked)}
            style={{ marginInlineStart: "auto" }}
          >
            {tx("Save members", "حفظ الأعضاء")}
          </button>
        </fieldset>
      )}
    </div>
  );
}
