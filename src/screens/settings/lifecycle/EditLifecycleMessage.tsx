import { useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import { Modal } from "@/components/Modal";
import { useToast } from "@/components/Toast";
import type { LifecycleRow, Template } from "@/lib/types";
import type { Tx } from "@/lib/tx";
import { LIFECYCLE_CATALOG } from "./lifecycleCatalog";
import { lifecycleErrorText } from "./lifecycleErrors";
import { BODY_MAX, EDIT_ISSUE_COPY, bodyParts, placeholdersOf, validateEdit, variantPill, PILL_COPY } from "./lifecycleRows";

type Lang = "ar" | "en";

interface Props {
  row: LifecycleRow;
  /** Open on this language (the rejected one for "Fix and resubmit"). */
  initialLang: Lang;
  tx: Tx;
  onClose: () => void;
  /** After a successful save (the row's statuses changed). */
  onSaved: () => void;
}

const LANG_COPY: Record<Lang, [string, string]> = { ar: ["Arabic", "العربية"], en: ["English", "الإنجليزية"] };

/**
 * SP-24 edit drawer for a lifecycle message's AR and EN templates. Saving
 * goes through the template editor's PATCH /templates/:id (templates.update),
 * which resubmits the template to WhatsApp. Placeholders stay as they are.
 */
export function EditLifecycleMessage({ row, initialLang, tx, onClose, onSaved }: Props) {
  const { toast } = useToast();
  const def = LIFECYCLE_CATALOG[row.key];
  const langs = (["ar", "en"] as const).filter((l) => row.variants?.[l]);
  const [lang, setLang] = useState<Lang>(langs.includes(initialLang) ? initialLang : (langs[0] ?? "ar"));
  const variant = row.variants?.[lang] ?? null;
  const tplQ = useFetch<Template>(variant ? `/templates/${variant.templateId}` : null);
  const original = tplQ.data?.id === variant?.templateId ? (tplQ.data?.body ?? "") : "";
  const [drafts, setDrafts] = useState<Partial<Record<Lang, string>>>({});
  const body = drafts[lang] ?? original;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setError(null), [lang]);

  const issue = original ? validateEdit(original, body) : null;
  const unchanged = body.trim() === original.trim();
  const names = useMemo(
    () => placeholdersOf(original).map((n) => ({ n, label: def.variables[n - 1] ?? null })),
    [original, def.variables],
  );

  const save = async () => {
    if (!variant || issue || unchanged) return;
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/templates/${variant.templateId}`, { body: body.trim() });
      toast(tx("Sent to WhatsApp for review", "أُرسلت إلى واتساب للمراجعة"), "success");
      onSaved();
      onClose();
    } catch (e) {
      setError(lifecycleErrorText(e, tx));
    } finally {
      setSaving(false);
    }
  };

  const pill = variantPill(variant);
  return (
    <Modal onClose={onClose} width={640} label={tx("Edit message", "تعديل الرسالة")}>
      <div style={{ display: "grid", gap: 12 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 16 }}>{tx(def.title[0], def.title[1])}</h3>
          <div className="muted" style={{ fontSize: 12.5 }}>{tx(def.description[0], def.description[1])}</div>
        </div>

        <div className="tabs" role="tablist" style={{ padding: 0, background: "transparent" }}>
          {langs.map((l) => (
            <button key={l} type="button" role="tab" aria-selected={lang === l} className={`tab ${lang === l ? "active" : ""}`.trim()} onClick={() => setLang(l)}>
              {tx(LANG_COPY[l][0], LANG_COPY[l][1])}
            </button>
          ))}
        </div>

        <div role="note" style={{ fontSize: 12.5, padding: "8px 12px", borderRadius: 8, background: "color-mix(in oklch, var(--warn) 10%, var(--bg-1))", border: "1px solid color-mix(in oklch, var(--warn) 40%, transparent)" }}>
          {tx(
            "Saving sends the message to WhatsApp for review again. It stays paused until it is approved.",
            "عند الحفظ تُرسل الرسالة إلى واتساب لمراجعتها من جديد، وتبقى متوقفة حتى تُعتمد.",
          )}
        </div>

        {variant && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
            <span className="chip">{tx(PILL_COPY[pill][0], PILL_COPY[pill][1])}</span>
            <bdi className="mono muted">{variant.name}</bdi>
            {variant.rejectionReason && (
              <span style={{ color: "var(--bad)" }}>
                {tx("Reason:", "السبب:")} <bdi>{variant.rejectionReason}</bdi>
              </span>
            )}
          </div>
        )}

        {tplQ.loading && !original ? (
          <div className="muted" style={{ fontSize: 12.5 }}>{tx("Loading…", "جارٍ التحميل…")}</div>
        ) : tplQ.error ? (
          <div role="alert" style={{ color: "var(--bad)", fontSize: 12.5 }}>{tx("Couldn't load this message.", "تعذّر تحميل هذه الرسالة.")}</div>
        ) : (
          <>
            <label style={{ display: "grid", gap: 6 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>{tx("Message", "الرسالة")}</span>
              <textarea
                dir={lang === "ar" ? "rtl" : "ltr"}
                lang={lang}
                rows={6}
                maxLength={BODY_MAX + 200}
                value={body}
                onChange={(e) => setDrafts((d) => ({ ...d, [lang]: e.target.value }))}
                style={{ inlineSize: "100%", resize: "vertical", fontSize: 14, lineHeight: 1.6 }}
              />
              <span className="mono muted" style={{ fontSize: 11, textAlign: "end" }}>
                <bdi>
                  {body.trim().length}/{BODY_MAX}
                </bdi>
              </span>
            </label>

            <div dir={lang === "ar" ? "rtl" : "ltr"} style={{ fontSize: 13.5, lineHeight: 1.8, padding: 10, borderRadius: 8, background: "var(--bg-1)", border: "1px solid var(--line-soft)" }}>
              {bodyParts(body).map((p, i) =>
                "text" in p ? (
                  <span key={i}>{p.text}</span>
                ) : (
                  <mark key={i} dir="ltr" style={{ background: "var(--accent-soft)", color: "var(--ink)", borderRadius: 4, paddingInline: 3 }}>
                    {`{{${p.placeholder}}}`}
                  </mark>
                ),
              )}
            </div>

            {names.length > 0 && (
              <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 12.5, display: "grid", gap: 2 }}>
                {names.map(({ n, label }) => (
                  <li key={n}>
                    <bdi className="mono">{`{{${n}}}`}</bdi> = {label ? tx(label[0], label[1]) : tx("Value", "قيمة")}
                  </li>
                ))}
              </ul>
            )}

            {issue && !unchanged && (
              <div role="alert" style={{ color: "var(--bad)", fontSize: 12.5 }}>
                {tx(EDIT_ISSUE_COPY[issue][0], EDIT_ISSUE_COPY[issue][1])}
              </div>
            )}
          </>
        )}

        {error && (
          <div role="alert" style={{ color: "var(--bad)", fontSize: 12.5 }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn" onClick={onClose}>
            {tx("Cancel", "إلغاء")}
          </button>
          <button type="button" className="btn primary" disabled={saving || !variant || !!issue || unchanged || !original} onClick={() => void save()}>
            {saving ? tx("Saving…", "جارٍ الحفظ…") : tx("Save and resubmit", "حفظ وإعادة الإرسال")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
