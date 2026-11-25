import { useFetch } from "@/api/useFetch";
import { Modal } from "@/components/Modal";
import { IconStar, IconX } from "@/icons";
import { makeTx } from "@/lib/tx";
import type { TemplateHealthResponse } from "@/lib/types";
import { useTweaks } from "@/tweaks/context";
import { MISSING_VS_UNKNOWN, templateQualityView, templateStatusView } from "@/screens/channels/health/healthModel";
import { ToneChip, fmtWhen } from "@/screens/channels/health/healthUi";
import { templateErrorText } from "./templateErrors";

/**
 * SP-14: one template's status on every WhatsApp number of the workspace
 * (GET /templates/:id/health, read from each number's snapshot; no provider
 * call). "Not on this number" (the list was read and lacks it) and "Unknown"
 * (no list, or the last read failed) are kept apart.
 */
export function TemplateHealthSheet({ templateId, templateName, onClose }: { templateId: string; templateName: string; onClose: () => void }) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const lang = t.lang;
  const q = useFetch<TemplateHealthResponse>(`/templates/${encodeURIComponent(templateId)}/health`);
  const d = q.data;
  const title = tx(`Template health: ${templateName}`, `صحة القالب: ${templateName}`);

  return (
    <Modal onClose={onClose} label={title} width={720}>
      <div dir={lang === "ar" ? "rtl" : "ltr"} style={{ display: "grid", gap: 14 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{tx("Template health", "صحة القالب")}</div>
            <div className="mono muted" style={{ fontSize: 12 }}>
              <bdi dir="ltr">{d?.template.name ?? templateName}</bdi>
              {d?.template.lang && (
                <>
                  {" · "}
                  <bdi dir="ltr">{d.template.lang}</bdi>
                </>
              )}
            </div>
          </div>
          {d && (
            <>
              {(() => {
                const st = templateStatusView(d.template.status, tx);
                return (
                  <ToneChip tone={st.tone} unknown={st.unknown}>
                    {st.label}
                  </ToneChip>
                );
              })()}
              {(() => {
                const ql = templateQualityView(d.template.quality, tx);
                return (
                  <ToneChip tone={ql.tone} unknown={ql.unknown}>
                    {tx("Quality", "الجودة")}: {ql.label}
                  </ToneChip>
                );
              })()}
            </>
          )}
          <button type="button" className="btn ghost icon sm" aria-label={tx("Close", "إغلاق")} onClick={onClose}>
            <IconX w={14} />
          </button>
        </div>

        {q.loading && !d && <div className="muted pulse" style={{ fontSize: 12 }}>{tx("Loading…", "جارٍ التحميل…")}</div>}
        {q.error && !d && (
          <div role="alert" style={{ color: "var(--bad)", fontSize: 12 }}>
            {templateErrorText(q.error, tx)}
          </div>
        )}

        {d && d.numbers.length === 0 && (
          <div className="muted" style={{ fontSize: 12.5 }}>{tx("No connected WhatsApp numbers.", "لا توجد أرقام واتساب متصلة.")}</div>
        )}

        {d && d.numbers.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table className="tbl" style={{ fontSize: 12.5 }}>
              <thead>
                <tr>
                  <th>{tx("Number", "الرقم")}</th>
                  <th>{tx("Status", "الحالة")}</th>
                  <th>{tx("Quality", "الجودة")}</th>
                  <th>{tx("Checked", "آخر فحص")}</th>
                </tr>
              </thead>
              <tbody>
                {d.numbers.map((n) => {
                  const st = templateStatusView(n.status, tx);
                  const ql = templateQualityView(n.quality, tx);
                  return (
                    <tr key={n.channelId}>
                      <td>
                        <div style={{ display: "flex", gap: 4, alignItems: "center", fontWeight: 500 }}>
                          <span dir="auto">{n.displayName}</span>
                          {n.isDefault && (
                            <span title={tx("Default", "افتراضي")} aria-label={tx("Default", "افتراضي")} style={{ color: "var(--warn)", display: "inline-flex" }}>
                              <IconStar w={12} />
                            </span>
                          )}
                        </div>
                        {n.phoneNumber && (
                          <div className="mono muted" style={{ fontSize: 11 }}>
                            <bdi dir="ltr">{n.phoneNumber}</bdi>
                          </div>
                        )}
                      </td>
                      <td>
                        <ToneChip
                          tone={st.tone}
                          unknown={st.unknown}
                          title={st.unknown ? tx("This number's template list hasn't been read, or the last read failed.", "لم تُقرأ قائمة قوالب هذا الرقم، أو فشلت آخر قراءة.") : undefined}
                        >
                          {st.label}
                        </ToneChip>
                      </td>
                      <td>
                        <ToneChip tone={ql.tone} unknown={ql.unknown}>
                          {ql.label}
                        </ToneChip>
                      </td>
                      <td className="muted" style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>
                        {fmtWhen(n.checkedAt, lang, tx)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
          {tx(MISSING_VS_UNKNOWN.en, MISSING_VS_UNKNOWN.ar)}
        </div>
      </div>
    </Modal>
  );
}
