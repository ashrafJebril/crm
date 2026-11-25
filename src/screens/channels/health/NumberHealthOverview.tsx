import type { Tx } from "@/lib/tx";
import type { ChannelDto, HealthFieldName, Lang } from "@/lib/types";
import { IconStar } from "@/icons";
import { FIELD_LABEL, TIER_SHARED_NOTE, hasNumberHealth, overallView, signalView, templatesView } from "./healthModel";
import { SignalValue, ToneChip, fmtWhen } from "./healthUi";

const COLUMNS: HealthFieldName[] = ["quality", "tier", "messaging", "nameStatus", "phoneStatus", "verified", "accountReview"];

/** The WhatsApp numbers the health page lists: Zernio or Meta, not disconnected. */
export function healthRows(list: readonly ChannelDto[]): ChannelDto[] {
  return list.filter((c) => hasNumberHealth(c) && c.status !== "disconnected");
}

/**
 * SP-14 "Number health": every WhatsApp number with its overall state,
 * quality, daily limit, messaging, display name, templates needing review and
 * last check. Data is the channel list (health is in the DTO); a row opens the
 * channel detail.
 */
export function NumberHealthOverview({
  list,
  tx,
  lang,
  onOpen,
}: {
  list: readonly ChannelDto[];
  tx: Tx;
  lang: Lang;
  onOpen: (id: string) => void;
}) {
  const rows = healthRows(list);

  if (rows.length === 0) {
    return (
      <div className="muted" style={{ textAlign: "center", padding: "40px 16px", border: "1px dashed var(--line)", borderRadius: 12, fontSize: 13 }}>
        {tx("No connected WhatsApp numbers to check.", "لا توجد أرقام واتساب متصلة لفحصها.")}
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ overflowX: "auto", border: "1px solid var(--line-soft)", borderRadius: 10, background: "var(--bg-1)" }}>
        <table className="tbl" style={{ fontSize: 12.5, minWidth: 1100 }}>
          <thead>
            <tr>
              <th>{tx("Number", "الرقم")}</th>
              <th>{tx("Overall", "الحالة العامة")}</th>
              {COLUMNS.map((f) => (
                <th key={f} title={f === "tier" ? tx(TIER_SHARED_NOTE.en, TIER_SHARED_NOTE.ar) : undefined} style={{ whiteSpace: "normal", maxWidth: 160 }}>
                  {tx(FIELD_LABEL[f].en, FIELD_LABEL[f].ar)}
                </th>
              ))}
              <th style={{ whiteSpace: "normal", maxWidth: 140 }}>{tx(FIELD_LABEL.templates.en, FIELD_LABEL.templates.ar)}</th>
              <th>{tx("Last checked", "آخر فحص")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const h = c.health ?? null;
              const overall = overallView(h, tx);
              return (
                <tr
                  key={c.id}
                  onClick={() => onOpen(c.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onOpen(c.id);
                    }
                  }}
                  tabIndex={0}
                  style={{ cursor: "pointer" }}
                >
                  <td>
                    <div style={{ display: "flex", gap: 4, alignItems: "center", fontWeight: 600 }}>
                      <span dir="auto">{c.displayName}</span>
                      {c.isDefault && (
                        <span title={tx("Default", "افتراضية")} aria-label={tx("Default", "افتراضية")} style={{ color: "var(--warn)", display: "inline-flex" }}>
                          <IconStar w={12} />
                        </span>
                      )}
                    </div>
                    {c.phoneNumber && (
                      <div className="muted mono" style={{ fontSize: 11 }}>
                        <bdi dir="ltr">{c.phoneNumber}</bdi>
                      </div>
                    )}
                  </td>
                  <td>
                    <ToneChip tone={overall.tone} unknown={!h || h.overall === "unknown"}>
                      {overall.label}
                    </ToneChip>
                  </td>
                  {COLUMNS.map((f) => (
                    <td key={f}>
                      <SignalValue view={signalView(f, h?.[f], tx, h?.lastKnown?.[f])} tx={tx} lang={lang} compact />
                    </td>
                  ))}
                  <td>
                    <SignalValue view={templatesView(h?.templates, tx)} tx={tx} lang={lang} compact />
                  </td>
                  <td className="muted" style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>
                    {fmtWhen(c.healthCheckedAt ?? h?.checkedAt ?? null, lang, tx)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
        {tx(TIER_SHARED_NOTE.en, TIER_SHARED_NOTE.ar)}{" "}
        {tx(
          "Numbers are checked about once a day. Open a number to check it now or see every field.",
          "تُفحص الأرقام مرة يوميًا تقريبًا. افتح رقمًا لفحصه الآن أو لعرض كل الحقول.",
        )}
      </div>
    </div>
  );
}
