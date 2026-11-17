import { useState } from "react";
import type { Lang, LearnApplyResult, LearnCard as Card } from "@/lib/types";
import type { Tx } from "@/lib/tx";
import { ErrorRow } from "@/screens/settings/form";
import { scheduleSummary } from "@/screens/calendar/schedule";
import { CatalogImportWizard } from "@/screens/calendar/CatalogImportWizard";
import { applyLearned } from "@/screens/agent/agentApi";
import { agentErrorText } from "@/screens/agent/agentErrors";

/**
 * SP-20 "What I learned": the card built from the owner's website. Every
 * section is a suggestion the owner keeps or drops; nothing is written until
 * Apply. Services are never created here: "Import these services" opens the
 * SP-10 catalog import wizard (its own review step) on the website URL.
 */
export function LearnCard({
  card,
  tx,
  lang,
  tz,
  websiteUrl,
  hoursEnableWorkingHours,
  onApplied,
}: {
  card: Card;
  tx: Tx;
  lang: Lang;
  tz: string;
  websiteUrl: string | null;
  hoursEnableWorkingHours: boolean;
  onApplied: (r: LearnApplyResult) => void;
}) {
  const hasDescription = !!(card.business.descriptionEn || card.business.descriptionAr);
  const [description, setDescription] = useState<"replace" | "append" | "skip">(hasDescription ? "append" : "skip");
  const [kept, setKept] = useState<boolean[]>(() => card.faqs.map(() => true));
  const [hours, setHours] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      const faqs = kept.map((k, i) => (k ? i : -1)).filter((i) => i >= 0);
      onApplied(await applyLearned({ description, faqs, hours: hours && !!card.hours }));
    } catch (e) {
      setError(agentErrorText(e, tx));
    } finally {
      setBusy(false);
    }
  }

  const section = { border: "1px solid var(--line-soft)", borderRadius: 10, padding: 12, background: "var(--bg-1)" } as const;
  return (
    <div dir={lang === "ar" ? "rtl" : "ltr"} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{tx("What I learned", "ما تعلّمته")}</div>
      <div style={section}>
        <div className="muted" style={{ fontSize: 12 }}>{tx("Business", "النشاط")}</div>
        <div dir="auto" style={{ fontWeight: 600 }}>{card.business.name}</div>
        {hasDescription && (
          <>
            {card.business.descriptionEn && <p dir="ltr" style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{card.business.descriptionEn}</p>}
            {card.business.descriptionAr && <p dir="rtl" style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{card.business.descriptionAr}</p>}
            <div role="radiogroup" aria-label={tx("Description", "الوصف")} style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13 }}>
              {(
                [
                  ["append", tx("Add to my content", "أضف إلى المحتوى")],
                  ["replace", tx("Replace my content", "استبدل المحتوى")],
                  ["skip", tx("Don't use it", "لا تستخدمه")],
                ] as const
              ).map(([v, label]) => (
                <label key={v} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input type="radio" name="learn-description" checked={description === v} onChange={() => setDescription(v)} />
                  {label}
                </label>
              ))}
            </div>
          </>
        )}
      </div>

      {card.faqs.length > 0 && (
        <div style={section}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{tx("Questions customers ask", "أسئلة يطرحها العملاء")}</div>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {card.faqs.map((f, i) => (
              <li key={i}>
                <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
                  <input type="checkbox" checked={kept[i]} onChange={(e) => setKept((k) => k.map((x, j) => (j === i ? e.target.checked : x)))} />
                  <span>
                    <span dir="auto" style={{ fontWeight: 600, display: "block" }}>{f.question}</span>
                    <span dir="auto" className="muted" style={{ whiteSpace: "pre-wrap" }}>{f.answer}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}

      {card.services.length > 0 && (
        <div style={section}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{tx("Services on your website", "الخدمات على موقعك")}</div>
          <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 13 }}>
            {card.services.map((s, i) => (
              <li key={i} dir="auto">
                {lang === "ar" && s.nameAr ? s.nameAr : s.name}
                {s.price !== undefined && (
                  <bdi className="mono" style={{ marginInlineStart: 6 }}>
                    {`${s.price.toLocaleString("en-US")} ${s.currency ?? ""}`.trim()}
                  </bdi>
                )}
              </li>
            ))}
          </ul>
          <button type="button" className="btn" style={{ marginTop: 8 }} onClick={() => setImporting(true)}>
            {tx("Import these services", "استورد هذه الخدمات")}
          </button>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            {tx("Services are added only after you review them in the import.", "لا تُضاف الخدمات إلا بعد مراجعتها في الاستيراد.")}
          </div>
        </div>
      )}

      {card.hours && (
        <div style={section}>
          <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
            <input type="checkbox" checked={hours} onChange={(e) => setHours(e.target.checked)} />
            <span>
              <span style={{ fontWeight: 600, display: "block" }}>{tx("Opening hours", "ساعات العمل")}</span>
              <bdi>{scheduleSummary(card.hours, lang)}</bdi>
              {hoursEnableWorkingHours && (
                <span role="note" style={{ display: "block", marginTop: 4 }}>
                  {tx(
                    "Applying these hours turns on working-hours mode: your agent will reply to customers only during these hours.",
                    "تطبيق هذه الساعات يفعّل وضع ساعات العمل: سيرد وكيلك على العملاء خلال هذه الساعات فقط.",
                  )}
                </span>
              )}
            </span>
          </label>
        </div>
      )}

      <div className="muted" style={{ fontSize: 12 }}>
        {tx("Nothing is saved until you press Apply.", "لن يُحفظ شيء حتى تضغط تطبيق.")}
        {card.sourcePages.length > 0 && ` ${tx("Read from", "قُرئ من")} ${card.sourcePages.length} ${tx("page(s).", "صفحة.")}`}
      </div>
      <div>
        <button type="button" className="btn primary" onClick={() => void apply()} disabled={busy}>
          {busy ? tx("Applying…", "جارٍ التطبيق…") : tx("Apply", "تطبيق")}
        </button>
      </div>
      <ErrorRow message={error} />
      {importing && (
        <CatalogImportWizard tx={tx} lang={lang} tz={tz} initialKind="services" initialUrl={websiteUrl ?? undefined} onClose={() => setImporting(false)} onFinished={() => undefined} />
      )}
    </div>
  );
}
