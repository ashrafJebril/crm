import { useEffect, useMemo, useReducer, useState } from "react";
import { useFetch } from "@/api/useFetch";
import type { AgentSettings, Lang, TagRow } from "@/lib/types";
import type { Tx } from "@/lib/tx";
import { ErrorRow, Field, inputStyle, SettingsCard } from "@/screens/settings/form";
import { WeeklyScheduleEditor } from "@/screens/calendar/WeeklyScheduleEditor";
import { dayErrors, fromSchedule, reduce, toSchedule } from "@/screens/calendar/scheduleEditor";
import type { Weekday } from "@/screens/calendar/bookingTime";
import type { ScheduleError } from "@/screens/calendar/schedule";
import { patchAgentSettings, resyncAgent, SETTINGS_PATH, type AgentSettingsPatch } from "./agentApi";
import { AGENT_NAME_MAX, AGENT_TONES, EXCLUDED_TAGS_MAX, GREETING_MAX, HOURS_MODE_COPY, HOURS_MODES, TONE_COPY } from "./agentConstants";
import { agentErrorText, errorExtra, errorKey } from "./agentErrors";
import { agentAvailableAt } from "./agentHours";

/**
 * SP-20 agent settings: identity, working hours, excluded customers, the
 * emergency stop (read-only here: the switch lives in Settings › AI), publish
 * state and Re-sync. Every card saves on its own with the row's `version`.
 */
export function AgentSettingsTab({ tx, lang, canEdit }: { tx: Tx; lang: Lang; canEdit: boolean }) {
  // While the live agent is being updated in the background, re-read every 3 s.
  const q = useFetch<AgentSettings>(SETTINGS_PATH, { pollMs: (d) => (d?.publishState === "pending" ? 3000 : null) });
  const s = q.data;
  const [msg, setMsg] = useState<string | null>(null);

  async function save(patch: Omit<AgentSettingsPatch, "version">): Promise<AgentSettings | null> {
    if (!s) return null;
    setMsg(null);
    const next = await patchAgentSettings({ ...patch, version: s.version });
    q.setData(next);
    setMsg(tx("Saved", "تم الحفظ"));
    return next;
  }

  if (!s) {
    return <ErrorRow message={q.error ? agentErrorText(null, tx) : null} />;
  }
  return (
    <div style={{ maxWidth: 760, display: "flex", flexDirection: "column" }}>
      {s.stopped && (
        <div role="status" style={{ border: "1px solid var(--bad)", borderRadius: 10, padding: "10px 14px", marginBottom: 14, fontSize: 13 }}>
          <strong>{tx("The agent is stopped.", "الوكيل متوقف.")}</strong>{" "}
          {tx("It sends no automatic replies on any channel.", "لا يرسل أي ردود تلقائية على أي قناة.")}
          {s.stopped.reason && (
            <div dir="auto" className="muted" style={{ marginTop: 4 }}>
              {tx("Reason", "السبب")}: {s.stopped.reason}
              {s.stopped.by ? ` (${s.stopped.by.name})` : ""}
            </div>
          )}
          <div style={{ marginTop: 6 }}>
            <a href="#/settings?tab=aiKnowledge">{tx("Turn it back on in Settings › AI", "أعد تشغيله من الإعدادات › الذكاء الاصطناعي")}</a>
          </div>
        </div>
      )}
      <IdentityCard s={s} tx={tx} canEdit={canEdit} save={save} />
      <HoursCard s={s} tx={tx} lang={lang} canEdit={canEdit} save={save} />
      <AudienceCard s={s} tx={tx} canEdit={canEdit} save={save} />
      <PublishCard s={s} tx={tx} canEdit={canEdit} onDone={() => q.refetch?.()} />
      {msg && <div className="muted" style={{ fontSize: 12 }}>{msg}</div>}
    </div>
  );
}

type SaveFn = (p: Omit<AgentSettingsPatch, "version">) => Promise<AgentSettings | null>;

function IdentityCard({ s, tx, canEdit, save }: { s: AgentSettings; tx: Tx; canEdit: boolean; save: SaveFn }) {
  const [nameEn, setNameEn] = useState(s.nameEn ?? "");
  const [nameAr, setNameAr] = useState(s.nameAr ?? "");
  const [greeting, setGreeting] = useState(s.greeting ?? "");
  const [greetingAr, setGreetingAr] = useState(s.greetingAr ?? "");
  const [tone, setTone] = useState<string[]>(s.tone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noName = !nameEn.trim() && !nameAr.trim();

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await save({ identity: { nameEn, nameAr, greeting, greetingAr, tone } });
    } catch (e) {
      setError(agentErrorText(e, tx));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsCard
      title={tx("Identity", "الهوية")}
      description={tx("How your agent introduces itself and writes. Used in every channel connected here.", "كيف يعرّف وكيلك بنفسه وكيف يكتب. يُستخدم في كل القنوات المتصلة هنا.")}
      footer={
        canEdit ? (
          <button type="button" className="btn primary" onClick={() => void submit()} disabled={busy || noName}>
            {busy ? tx("Saving…", "جارٍ الحفظ…") : tx("Save identity", "حفظ الهوية")}
          </button>
        ) : undefined
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        <Field label={tx("Name (English)", "الاسم (بالإنجليزية)")}>
          <input dir="ltr" value={nameEn} maxLength={AGENT_NAME_MAX} readOnly={!canEdit} onChange={(e) => setNameEn(e.target.value)} style={inputStyle} />
        </Field>
        <Field label={tx("Name (Arabic)", "الاسم (بالعربية)")}>
          <input dir="rtl" value={nameAr} maxLength={AGENT_NAME_MAX} readOnly={!canEdit} onChange={(e) => setNameAr(e.target.value)} style={inputStyle} />
        </Field>
        <Field label={tx("Greeting (English)", "التحية (بالإنجليزية)")}>
          <textarea dir="ltr" value={greeting} maxLength={GREETING_MAX} readOnly={!canEdit} onChange={(e) => setGreeting(e.target.value)} style={{ ...inputStyle, height: 64, padding: 8 }} />
        </Field>
        <Field label={tx("Greeting (Arabic)", "التحية (بالعربية)")}>
          <textarea dir="rtl" value={greetingAr} maxLength={GREETING_MAX} readOnly={!canEdit} onChange={(e) => setGreetingAr(e.target.value)} style={{ ...inputStyle, height: 64, padding: 8 }} />
        </Field>
      </div>
      <div style={{ marginTop: 12 }}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{tx("Tone", "الأسلوب")}</div>
        <div role="group" aria-label={tx("Tone", "الأسلوب")} style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {AGENT_TONES.map((t) => {
            const on = tone.includes(t);
            return (
              <button
                key={t}
                type="button"
                aria-pressed={on}
                disabled={!canEdit}
                className={`btn ${on ? "primary" : "ghost"}`}
                onClick={() => setTone((cur) => (on ? cur.filter((x) => x !== t) : [...cur, t]))}
              >
                {tx(TONE_COPY[t][0], TONE_COPY[t][1])}
              </button>
            );
          })}
        </div>
      </div>
      {noName && canEdit && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>{tx("Give your agent a name in English or Arabic.", "أعطِ وكيلك اسمًا بالإنجليزية أو العربية.")}</div>}
      <ErrorRow message={error} />
    </SettingsCard>
  );
}

function HoursCard({ s, tx, lang, canEdit, save }: { s: AgentSettings; tx: Tx; lang: Lang; canEdit: boolean; save: SaveFn }) {
  const [mode, setMode] = useState(s.hoursMode);
  const [model, dispatch] = useReducer(reduce, s.schedule ?? {}, fromSchedule);
  const [serverErrors, setServerErrors] = useState<Partial<Record<Weekday, ScheduleError>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  const errors = { ...dayErrors(model), ...serverErrors };
  const schedule = toSchedule(model);
  const replyingNow = agentAvailableAt({ hoursMode: mode, schedule }, now, s.timezone);

  async function submit() {
    setBusy(true);
    setError(null);
    setServerErrors({});
    try {
      await save({ hours: { mode, schedule } });
    } catch (e) {
      if (errorKey(e) === "agent.hours_invalid") {
        const x = errorExtra(e);
        if (typeof x.day === "string") setServerErrors({ [x.day as Weekday]: { day: x.day, index: null, reason: x.reason as ScheduleError["reason"] } });
      }
      setError(agentErrorText(e, tx));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsCard
      title={tx("Working hours", "ساعات العمل")}
      description={tx(
        "When your agent answers on WhatsApp and the social channels connected here. Chats on the Kewy widget are answered by Kewy.",
        "متى يرد وكيلك على واتساب وقنوات التواصل المتصلة هنا. محادثات أداة كيوي يرد عليها كيوي.",
      )}
      footer={
        canEdit ? (
          <button type="button" className="btn primary" onClick={() => void submit()} disabled={busy || (mode !== "always" && Object.keys(dayErrors(model)).length > 0)}>
            {busy ? tx("Saving…", "جارٍ الحفظ…") : tx("Save hours", "حفظ الساعات")}
          </button>
        ) : undefined
      }
    >
      <div role="radiogroup" aria-label={tx("Working hours", "ساعات العمل")} style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
        {HOURS_MODES.map((m) => (
          <label key={m} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
            <input type="radio" name="agent-hours-mode" checked={mode === m} disabled={!canEdit} onChange={() => setMode(m)} />
            {tx(HOURS_MODE_COPY[m][0], HOURS_MODE_COPY[m][1])}
          </label>
        ))}
      </div>
      {mode !== "always" && (
        <WeeklyScheduleEditor model={model} dispatch={dispatch} errors={errors} tx={tx} lang={lang} tz={s.timezone} disabled={!canEdit || busy} />
      )}
      <div style={{ fontSize: 12, marginTop: 10 }} className="muted">
        {tx("Time zone", "المنطقة الزمنية")}: <bdi>{s.timezone}</bdi> ·{" "}
        {replyingNow ? tx("The agent is replying now.", "الوكيل يرد الآن.") : tx("The agent is off now.", "الوكيل لا يرد الآن.")}
      </div>
      <ErrorRow message={error} />
    </SettingsCard>
  );
}

function AudienceCard({ s, tx, canEdit, save }: { s: AgentSettings; tx: Tx; canEdit: boolean; save: SaveFn }) {
  const tagsQ = useFetch<TagRow[]>("/tags");
  const [ids, setIds] = useState<string[]>(s.excludedTags.map((t) => t.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tags = useMemo(() => tagsQ.data ?? [], [tagsQ.data]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const next = await save({ audience: { excludedTagIds: ids } });
      if (next) setIds(next.excludedTags.map((t) => t.id));
    } catch (e) {
      setError(agentErrorText(e, tx));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsCard
      title={tx("Customers excluded from automatic replies", "عملاء مستثنون من الردود التلقائية")}
      description={tx(
        "Customers with any of these tags never get an automatic reply. Your team can still message them.",
        "العملاء الذين يحملون أيًا من هذه الوسوم لا يتلقون ردًا تلقائيًا أبدًا. يمكن لفريقك مراسلتهم.",
      )}
      footer={
        canEdit ? (
          <button type="button" className="btn primary" onClick={() => void submit()} disabled={busy || ids.length > EXCLUDED_TAGS_MAX}>
            {busy ? tx("Saving…", "جارٍ الحفظ…") : tx("Save", "حفظ")}
          </button>
        ) : undefined
      }
    >
      {s.droppedTagIds.length > 0 && (
        <div role="status" className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          {tx(
            `${s.droppedTagIds.length} excluded tag(s) were deleted and removed from this list.`,
            `حُذف ${s.droppedTagIds.length} من الوسوم المستثناة وأُزيلت من هذه القائمة.`,
          )}
        </div>
      )}
      <div role="group" aria-label={tx("Tags", "الوسوم")} style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {tags.length === 0 && <span className="muted" style={{ fontSize: 12 }}>{tx("No tags yet. Create tags on the Contacts page.", "لا توجد وسوم بعد. أنشئ وسومًا من صفحة جهات الاتصال.")}</span>}
        {tags.map((t) => {
          const on = ids.includes(t.id);
          return (
            <button
              key={t.id}
              type="button"
              aria-pressed={on}
              disabled={!canEdit}
              className={`btn ${on ? "primary" : "ghost"}`}
              onClick={() => setIds((cur) => (on ? cur.filter((x) => x !== t.id) : [...cur, t.id]))}
            >
              <span dir="auto">{t.name}</span>
            </button>
          );
        })}
      </div>
      <ErrorRow message={error} />
    </SettingsCard>
  );
}

const PUBLISH_COPY: Record<AgentSettings["publishState"], [string, string]> = {
  none: ["Not published yet.", "لم يُنشر بعد."],
  pending: ["Updating the live agent…", "جارٍ تحديث الوكيل الفعلي…"],
  published: ["The live agent is up to date.", "الوكيل الفعلي محدّث."],
  failed: ["The live agent could not be updated. Re-sync to try again.", "تعذّر تحديث الوكيل الفعلي. أعد المزامنة للمحاولة مجددًا."],
};

function PublishCard({ s, tx, canEdit, onDone }: { s: AgentSettings; tx: Tx; canEdit: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function resync() {
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await resyncAgent();
      setDone(true);
      onDone();
    } catch (e) {
      setError(agentErrorText(e, tx));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsCard title={tx("Live agent", "الوكيل الفعلي")} description={s.linked ? tx(...PUBLISH_COPY[s.publishState]) : tx("This workspace is not linked to a Kewy agent.", "مساحة العمل هذه غير مرتبطة بوكيل كيوي.")}>
      {canEdit && s.linked && (
        <button type="button" className="btn" onClick={() => void resync()} disabled={busy}>
          {busy ? tx("Re-syncing…", "جارٍ إعادة المزامنة…") : tx("Re-sync agent", "إعادة مزامنة الوكيل")}
        </button>
      )}
      {done && <span className="muted" style={{ fontSize: 12, marginInlineStart: 8 }}>{tx("Re-synced.", "تمت إعادة المزامنة.")}</span>}
      <ErrorRow message={error} />
    </SettingsCard>
  );
}
