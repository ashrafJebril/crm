import type { Tx } from "@/lib/tx";
import type { CampaignPreviewV2, SenderOption, VarMap } from "@/lib/types";
import { campaignKeyText } from "./campaignErrors";
import { missingValueLabel } from "./failureCodes";
import { splitRows } from "./senderModel";
import { Notice, fmtNum } from "./ui";
import { renderWithLabels, sampleSegments, type CustomLabels } from "./varMap";

/**
 * SP-13 review: up to three real-contact samples in phone bubbles (fallback
 * values underlined; a skipped sample shows why), the template-on-number and
 * transport warnings, and the per-number split, largest first. Without
 * contacts.view the backend sends no samples (ruling 18): the template is
 * shown with field labels instead.
 */
export function ReviewSamples({
  tx,
  preview,
  body,
  lang,
  varMap,
  customLabels,
  senders,
  headerOverride,
}: {
  tx: Tx;
  preview: CampaignPreviewV2;
  body: string;
  /** The template language, for the bubble direction. */
  lang: string;
  varMap: VarMap;
  customLabels: CustomLabels;
  senders: readonly SenderOption[];
  headerOverride: boolean;
}) {
  const dir = lang.startsWith("ar") ? "rtl" : "ltr";
  const ctx = { senders };
  const rows = splitRows(preview.split);
  const t = preview.transport;

  const bubble = (key: string, title: string, content: React.ReactNode, note?: React.ReactNode) => (
    <div key={key} style={{ display: "grid", gap: 4 }}>
      <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{title}</div>
      <div
        dir={dir}
        style={{
          background: "var(--bg-2)",
          border: "1px solid var(--line-soft)",
          borderRadius: "12px 12px 12px 4px",
          padding: "8px 12px",
          fontSize: 13,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          maxWidth: 420,
        }}
      >
        {content}
      </div>
      {note}
    </div>
  );

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {!preview.connected && <Notice tone="warn">{campaignKeyText("campaigns.whatsapp_not_connected", {}, tx)}</Notice>}
      {preview.templateMissing.length > 0 && (
        <Notice tone="warn">
          {campaignKeyText("campaigns.template_missing_on_number", { channelIds: preview.templateMissing }, tx, ctx)}
        </Notice>
      )}
      {(preview.templateCheckFailed ?? []).length > 0 && (
        <Notice tone="warn">
          {campaignKeyText("campaigns.template_check_failed", { channelIds: preview.templateCheckFailed }, tx, ctx)}
        </Notice>
      )}
      {t.kind === "too_varied" && (
        <Notice tone="warn">
          {headerOverride
            ? campaignKeyText("campaigns.header_direct_too_large", { limit: t.directLimit, reachable: preview.reachable }, tx)
            : campaignKeyText("campaigns.var_map_too_varied", { partitions: t.partitions, limit: t.limit, directLimit: t.directLimit }, tx)}
        </Notice>
      )}
      {t.kind === "direct" && (
        <Notice>
          {headerOverride
            ? tx(
                `Because it has its own header file, each message is sent individually (up to ${fmtNum(t.directLimit)} recipients). Sending takes longer.`,
                `لأن للحملة ملف ترويسة خاصًا، تُرسل كل رسالة على حدة (حتى ${fmtNum(t.directLimit)} مستلم). يستغرق الإرسال وقتًا أطول.`,
              )
            : tx(
                `The variables make ${fmtNum(t.partitions)} different messages, so each one is sent individually (up to ${fmtNum(t.directLimit)} recipients). Sending takes longer.`,
                `تُنتج المتغيرات ${fmtNum(t.partitions)} رسالة مختلفة، لذا تُرسل كل رسالة على حدة (حتى ${fmtNum(t.directLimit)} مستلم). يستغرق الإرسال وقتًا أطول.`,
              )}
        </Notice>
      )}

      {preview.samples.length > 0 ? (
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ fontSize: 12, color: "var(--ink-2)", fontWeight: 500 }}>{tx("Examples from your audience", "أمثلة من جمهورك")}</div>
          {preview.samples.map((s) => {
            const name = s.name?.trim() || tx("A contact", "جهة اتصال");
            const content = sampleSegments(body, s.values, s.usedFallback).map((seg, i) =>
              seg.fallback ? (
                <span
                  key={i}
                  title={tx("Fallback", "بديل")}
                  style={{ textDecoration: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 3 }}
                >
                  {seg.text}
                </span>
              ) : seg.missing ? (
                <span key={i} className="mono" style={{ color: "var(--warn)" }}>
                  <bdi dir="ltr">{seg.text}</bdi>
                </span>
              ) : (
                <span key={i}>{seg.text}</span>
              ),
            );
            const note = s.skippedFor ? (
              <div style={{ fontSize: 11.5, color: "var(--warn)" }}>
                {tx("Skipped", "مُستبعد")}: {missingValueLabel(s.skippedFor.source, s.skippedFor.key, tx, customLabels)}
              </div>
            ) : s.usedFallback.length > 0 ? (
              <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{tx("Underlined: fallback value", "المسطّر: قيمة بديلة")}</div>
            ) : undefined;
            return bubble(s.contactId, name, content, note);
          })}
        </div>
      ) : (
        bubble(
          "labels",
          tx(
            "Message with field names (examples need permission to view contacts)",
            "الرسالة بأسماء الحقول (تتطلب الأمثلة صلاحية عرض جهات الاتصال)",
          ),
          renderWithLabels(body, varMap, tx, customLabels),
        )
      )}

      {rows.length > 1 && (
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ fontSize: 12, color: "var(--ink-2)", fontWeight: 500 }}>{tx("Split across numbers", "التوزيع على الأرقام")}</div>
          <table className="tbl">
            <thead>
              <tr>
                <th>{tx("Number", "الرقم")}</th>
                <th style={{ textAlign: "end" }}>{tx("Recipients", "المستلمون")}</th>
                <th style={{ textAlign: "end" }}>%</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.channelId}>
                  <td>
                    <span dir="auto">{r.displayName}</span>
                    {r.phoneNumber && (
                      <span className="mono" style={{ marginInlineStart: 6, fontSize: 11.5, color: "var(--ink-3)" }}>
                        <bdi dir="ltr">{r.phoneNumber}</bdi>
                      </span>
                    )}
                  </td>
                  <td className="mono" style={{ textAlign: "end" }}>{fmtNum(r.recipients)}</td>
                  <td className="mono" style={{ textAlign: "end" }}>
                    <bdi dir="ltr">{`${r.pct}%`}</bdi>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
