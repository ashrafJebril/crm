import { memo, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx, type Tx } from "@/lib/tx";
import { useAuth } from "@/auth/context";
import { usePermissions } from "@/auth/usePermissions";
import { useFetch } from "@/api/useFetch";
import { PageHeader } from "@/components/PageHeader";
import type { LearnApplyResult, OnboardingState } from "@/lib/types";
import { ErrorRow, inputStyle } from "@/screens/settings/form";
import { BUSINESS_NAME_MAX } from "@/screens/agent/agentConstants";
import { ONBOARDING_PATH, onboardingLearn, onboardingWebsite, patchOnboarding, type OnboardingAction } from "@/screens/agent/agentApi";
import { agentErrorText, errorKey } from "@/screens/agent/agentErrors";
import { progress, setupView, STEP_COPY, websiteReading } from "@/screens/agent/onboardingSteps";
import { TryAgentPanel } from "@/screens/agent/TryAgentPanel";
import { knowledgeErrorText } from "@/screens/knowledge/knowledgeErrors";
import { LearnCard } from "./LearnCard";

/**
 * SP-20 guided setup (`#/setup`): business name → website → "What I learned"
 * → try the agent → live. The assistant lines are fixed bilingual copy (never
 * model text). Skippable and resumable; only a member with settings.update
 * drives it, and only its starter while it is in progress.
 */
function SetupPageImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { activeWorkspace } = useAuth();
  const { can } = usePermissions();
  const q = useFetch<OnboardingState>(ONBOARDING_PATH, { pollMs: (d) => (websiteReading(d) ? 3000 : null) });
  const s = q.data;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [applied, setApplied] = useState<LearnApplyResult | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  async function run<T>(fn: () => Promise<T>, onOk?: (v: T) => void, errText: (e: unknown) => string = (e) => agentErrorText(e, tx)) {
    setBusy(true);
    setError(null);
    try {
      const v = await fn();
      onOk?.(v);
      await q.refetch();
    } catch (e) {
      setError(errText(e));
      // Review M2: the state changed under us (someone else drives it now, or it is no longer stuck): show the error and reload.
      if (["onboarding.not_stuck", "onboarding.not_owner"].includes(errorKey(e))) void q.refetch();
    } finally {
      setBusy(false);
    }
  }
  const act = (action: OnboardingAction, extra: { step?: string; businessName?: string } = {}) => run(() => patchOnboarding({ action, ...extra }));

  const view = setupView(s);
  const lineBox = (text: string) => (
    <div dir="auto" style={{ alignSelf: "flex-start", maxWidth: 620, background: "var(--bg-2)", borderRadius: 12, padding: "10px 14px", fontSize: 14 }}>
      {text}
    </div>
  );

  // Review M3: a non-starter sees who drives the setup; Take over / Start over only when it is stuck.
  const rescue =
    s && s.stuck && !s.isStarter && can("settings.manage") ? (
      <div role="status" style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 10, fontSize: 13 }}>
        {tx(
          "This setup hasn't moved for a day, or the person who started it left. You can take it over or start over.",
          "لم يتقدم هذا الإعداد منذ يوم، أو غادر من بدأه. يمكنك تولّيه أو البدء من جديد.",
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button type="button" className="btn" disabled={busy} onClick={() => void act("takeover")}>
            {tx("Take over", "تولَّ الإعداد")}
          </button>
          {confirmReset ? (
            <>
              <span>
                {tx(
                  "Start over? This clears the business name, the website and what was learned.",
                  "البدء من جديد؟ سيُمسح اسم النشاط والموقع وما تعلّمه الوكيل.",
                )}
              </span>
              <button
                type="button"
                className="btn danger"
                disabled={busy}
                onClick={() => {
                  setConfirmReset(false);
                  void act("reset");
                }}
              >
                {tx("Yes, start over", "نعم، ابدأ من جديد")}
              </button>
              <button type="button" className="btn ghost" disabled={busy} onClick={() => setConfirmReset(false)}>
                {tx("Cancel", "إلغاء")}
              </button>
            </>
          ) : (
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setConfirmReset(true)}>
              {tx("Start over", "ابدأ من جديد")}
            </button>
          )}
        </div>
      </div>
    ) : null;

  let body: React.ReactNode = null;
  if (!s) {
    body = <ErrorRow message={q.error ? agentErrorText(null, tx) : null} />;
  } else if (view === "no_access") {
    body = lineBox(tx("Ask an owner or admin to set up the agent.", "اطلب من المالك أو المسؤول إعداد الوكيل."));
  } else if (view === "done") {
    body = (
      <>
        {lineBox(tx("Setup is finished. You can change everything later on the agent page.", "اكتمل الإعداد. يمكنك تغيير كل شيء لاحقًا من صفحة الوكيل."))}
        <a className="btn" href="#/agent">{tx("Go to the agent page", "انتقل إلى صفحة الوكيل")}</a>
      </>
    );
  } else if (view === "skipped") {
    body = (
      <>
        {lineBox(tx("You skipped setup. Continue where you left off?", "تخطيت الإعداد. هل تريد المتابعة من حيث توقفت؟"))}
        <div>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void act("resume")}>
            {tx("Continue setup", "أكمل الإعداد")}
          </button>
        </div>
      </>
    );
  } else if (view === "watching") {
    const p = progress(s.step);
    const who = s.startedByName ?? tx("Another team member", "عضو آخر في الفريق");
    body = (
      <>
        {lineBox(tx(`${who} is setting this up.`, `${who} يقوم بإعداد هذا.`))}
        <div className="muted mono" style={{ fontSize: 12 }}>
          <bdi>{`${p.current}/${p.total}`}</bdi> · {tx(...STEP_COPY[s.step].label)}
        </div>
        {rescue}
      </>
    );
  } else if (view === "start") {
    body = (
      <>
        {lineBox(tx(...STEP_COPY.business.line))}
        <NameForm tx={tx} name={name} setName={setName} busy={busy} onSubmit={() => void act("start", { businessName: name })} />
      </>
    );
  } else {
    const p = progress(s.step);
    body = (
      <>
        <div className="muted mono" style={{ fontSize: 12 }}>
          <bdi>{`${p.current}/${p.total}`}</bdi> · {tx(...STEP_COPY[s.step].label)}
        </div>
        {lineBox(tx(...STEP_COPY[s.step].line))}
        {s.step === "business" && (
          <NameForm tx={tx} name={name || s.businessName || ""} setName={setName} busy={busy} onSubmit={() => void act("step", { step: "website", businessName: name || s.businessName || "" })} />
        )}
        {s.step === "website" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => onboardingWebsite(url.trim()), undefined, (err) => knowledgeErrorText(err, tx, agentErrorText(err, tx)));
            }}
            style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
          >
            <input
              dir="ltr"
              type="url"
              inputMode="url"
              aria-label={tx("Website address", "عنوان الموقع")}
              placeholder="https://"
              value={url || s.websiteUrl || ""}
              onChange={(e) => setUrl(e.target.value)}
              style={{ ...inputStyle, flex: 1, minWidth: 240 }}
            />
            <button type="submit" className="btn primary" disabled={busy || !(url || "").trim()}>
              {tx("Read my website", "اقرأ موقعي")}
            </button>
          </form>
        )}
        {s.step === "learn" && (
          <LearnStep s={s} tx={tx} lang={t.lang} tz={activeWorkspace?.timezone ?? "Asia/Riyadh"} busy={busy} onLearn={() => void run(onboardingLearn)} onApplied={(r) => { setApplied(r); void act("step", { step: "try" }); }} />
        )}
        {s.step === "try" && (
          <>
            {applied && (
              <div className="muted" style={{ fontSize: 12 }}>
                {tx(
                  `Saved: ${applied.applied.faqsAdded} FAQ(s)${applied.applied.faqsSkipped ? `, ${applied.applied.faqsSkipped} already there` : ""}${applied.applied.hours ? ", working hours" : ""}.`,
                  `حُفظ: ${applied.applied.faqsAdded} سؤال${applied.applied.faqsSkipped ? `، و${applied.applied.faqsSkipped} موجودة مسبقًا` : ""}${applied.applied.hours ? "، وساعات العمل" : ""}.`,
                )}
              </div>
            )}
            <TryAgentPanel tx={tx} canUse={can("agent.update")} />
            <div>
              <button type="button" className="btn primary" disabled={busy} onClick={() => void act("step", { step: "live" })}>
                {tx("Continue", "متابعة")}
              </button>
            </div>
          </>
        )}
        {s.step === "live" && (
          <div>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void act("finish")}>
              {tx("Finish", "إنهاء")}
            </button>
          </div>
        )}
        <div>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => void act("skip")}>
            {tx("Skip for now", "تخطَّ الآن")}
          </button>
        </div>
      </>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <PageHeader title={tx("Set up your agent", "إعداد وكيلك")} subtitle={tx("A few steps to get your assistant answering customers.", "بضع خطوات ليبدأ مساعدك بالرد على العملاء.")} />
      <div style={{ padding: "0 24px 24px", display: "flex", flexDirection: "column", gap: 12, maxWidth: 820, overflowY: "auto" }}>
        {body}
        <ErrorRow message={error} />
      </div>
    </div>
  );
}

function NameForm({ tx, name, setName, busy, onSubmit }: { tx: Tx; name: string; setName: (v: string) => void; busy: boolean; onSubmit: () => void }) {
  const len = name.trim().length;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
    >
      <input
        dir="auto"
        aria-label={tx("Business name", "اسم النشاط التجاري")}
        value={name}
        maxLength={BUSINESS_NAME_MAX}
        onChange={(e) => setName(e.target.value)}
        style={{ ...inputStyle, flex: 1, minWidth: 220 }}
      />
      <button type="submit" className="btn primary" disabled={busy || len === 0 || len > BUSINESS_NAME_MAX}>
        {tx("Next", "التالي")}
      </button>
    </form>
  );
}

function LearnStep({
  s,
  tx,
  lang,
  tz,
  busy,
  onLearn,
  onApplied,
}: {
  s: OnboardingState;
  tx: Tx;
  lang: "en" | "ar";
  tz: string;
  busy: boolean;
  onLearn: () => void;
  onApplied: (r: LearnApplyResult) => void;
}) {
  const reading = websiteReading(s);
  const pages = s.website?.pagesSynced ?? 0;
  if (s.learned) {
    return <LearnCard card={s.learned} tx={tx} lang={lang} tz={tz} websiteUrl={s.websiteUrl} hoursEnableWorkingHours={s.hoursApplyEnablesWorkingHours} onApplied={onApplied} />;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="muted" style={{ fontSize: 13 }} role="status">
        {reading
          ? tx(`Reading your website… ${pages} page(s) so far.`, `جارٍ قراءة موقعك… ${pages} صفحة حتى الآن.`)
          : tx(`Read ${pages} page(s) of your website.`, `قُرئت ${pages} صفحة من موقعك.`)}
      </div>
      <div>
        <button type="button" className="btn primary" disabled={busy || pages === 0} onClick={onLearn}>
          {busy ? tx("Summarising…", "جارٍ التلخيص…") : tx("Show what you learned", "اعرض ما تعلّمته")}
        </button>
      </div>
    </div>
  );
}

const SetupPage = memo(SetupPageImpl);
export default SetupPage;
