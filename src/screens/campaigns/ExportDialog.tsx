import { useState } from "react";
import { api } from "@/api/client";
import { Modal } from "@/components/Modal";
import { useToast } from "@/components/Toast";
import type { Tx } from "@/lib/tx";
import type { Lang } from "@/lib/types";
import { saveBlob } from "@/screens/contacts/import/importApi";
import { campaignErrorText } from "./campaignErrors";
import { exportBody, exportFilename, statusLabel, type ExportLang, type Outcome, type Scope } from "./campaignDetailModel";
import { INPUT_STYLE, fmtNum } from "./ui";

interface Props {
  campaign: { id: string; name: string };
  outcome: Outcome;
  outcomeCount: number;
  total: number;
  ticked: string[];
  /** Scope to start on (the selection bar's "Export ticked" opens on ticked). */
  initialScope?: Scope;
  tx: Tx;
  lang: Lang;
  onClose: () => void;
}

/** CSV export: the whole campaign, the current outcome, or the ticked rows, in English or Arabic. */
export function ExportDialog({ campaign, outcome, outcomeCount, total, ticked, initialScope, tx, lang, onClose }: Props) {
  const { toast } = useToast();
  const [scope, setScope] = useState<Scope>(
    initialScope ?? (ticked.length ? "ticked" : outcome !== "all" ? "outcome" : "all"),
  );
  const [fileLang, setFileLang] = useState<ExportLang>(lang === "ar" ? "ar" : "en");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options: { id: Scope; label: string; disabled: boolean }[] = [
    { id: "all", label: tx(`Everyone (${fmtNum(total)})`, `الجميع (${fmtNum(total)})`), disabled: false },
    {
      id: "outcome",
      label: tx(
        `Current outcome: ${statusLabel(outcome, tx)} (${fmtNum(outcomeCount)})`,
        `النتيجة الحالية: ${statusLabel(outcome, tx)} (${fmtNum(outcomeCount)})`,
      ),
      disabled: outcome === "all",
    },
    {
      id: "ticked",
      label: tx(`Ticked rows (${fmtNum(ticked.length)})`, `الصفوف المحددة (${fmtNum(ticked.length)})`),
      disabled: ticked.length === 0,
    },
  ];

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const { blob, filename } = await api.postBlob(
        `/campaigns/${encodeURIComponent(campaign.id)}/export`,
        exportBody(scope, outcome, ticked, fileLang),
      );
      saveBlob(blob, exportFilename(filename, campaign, scope, outcome, new Date()));
      toast(tx("Export downloaded", "تم تنزيل الملف"), "success");
      onClose();
    } catch (e) {
      const msg = campaignErrorText(e, tx);
      if ((e as { status?: number }).status === 403) {
        toast(msg, "error");
        onClose();
      } else setError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} label={tx("Export recipients", "تصدير المستلمين")} width={460}>
      <div dir={lang === "ar" ? "rtl" : "ltr"} style={{ display: "grid", gap: 14 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>{tx("Export recipients", "تصدير المستلمين")}</h3>
        <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 8 }}>
          <legend style={{ fontSize: 12, color: "var(--ink-2)", marginBottom: 6 }}>{tx("Rows", "الصفوف")}</legend>
          {options.map((o) => (
            <label key={o.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, opacity: o.disabled ? 0.5 : 1 }}>
              <input
                type="radio"
                name="export-scope"
                checked={scope === o.id}
                disabled={o.disabled}
                onChange={() => setScope(o.id)}
                style={{ accentColor: "var(--accent)" }}
              />
              {o.label}
            </label>
          ))}
        </fieldset>
        <label style={{ display: "grid", gap: 6, fontSize: 12, color: "var(--ink-2)" }}>
          {tx("File language", "لغة الملف")}
          <select value={fileLang} onChange={(e) => setFileLang(e.target.value as ExportLang)} style={INPUT_STYLE}>
            <option value="en">English</option>
            <option value="ar">العربية</option>
          </select>
        </label>
        {error && (
          <div role="alert" style={{ fontSize: 12.5, color: "var(--bad)" }}>
            {error}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn" onClick={onClose}>
            {tx("Cancel", "إلغاء")}
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void download()}>
            {busy ? tx("Preparing…", "جارٍ التجهيز…") : tx("Download CSV", "تنزيل CSV")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
