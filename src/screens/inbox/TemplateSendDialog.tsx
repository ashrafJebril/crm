import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { AuthorizedImage } from "@/components/AuthorizedImage";
import { MediaPicker } from "@/components/media/MediaPicker";
import { mediaKeyText } from "@/components/media/mediaErrors";
import { headerKind } from "@/components/media/mediaKinds";
import { API_BASE, ApiError, tokenStore } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import { useTweaks } from "@/tweaks/context";
import { makeTx, type Tx } from "@/lib/tx";
import type { Media } from "@/lib/types";

// SP-13: the header kinds and the picker moved to src/components/media; re-exported for existing imports.
export { headerKind, mediaMatchesHeader } from "@/components/media/mediaKinds";

export interface ApprovedTemplate {
  id: string;
  name: string;
  lang: string;
  category: string;
  status: string;
  body?: string | null;
  footer?: string | null;
  /** "text" | "image" | "video" | "document" (lower case, from the local row). */
  headerType?: string | null;
  headerContent?: string | null;
}

/** What the send endpoints accept as `header`. */
export interface TemplateHeaderValue {
  mediaId?: string;
  params?: string[];
}

/** Highest {{n}} placeholder in a string. */
export function placeholderCount(s: string | null | undefined): number {
  let max = 0;
  for (const m of (s ?? "").matchAll(/\{\{(\d+)\}\}/g)) max = Math.max(max, parseInt(m[1]!, 10));
  return max;
}

const fill = (s: string, vals: string[]): string =>
  s.replace(/\{\{(\d+)\}\}/g, (_, idx: string) => vals[parseInt(idx, 10) - 1]?.trim() || `{{${idx}}}`);

function sendErrorText(e: unknown, tx: Tx): string {
  const msg = e instanceof Error ? e.message : "";
  // templates.header_media_mismatch / _too_large / Media not found (SP-13 keyed copy).
  const keyed = mediaKeyText(msg, e instanceof ApiError ? e.body : undefined, tx);
  if (keyed) return keyed;
  return msg || tx("Send failed", "فشل الإرسال");
}

const CAPTION: React.CSSProperties = {
  fontSize: 10,
  fontFamily: "var(--font-mono)",
  color: "var(--ink-3)",
  textTransform: "uppercase",
  letterSpacing: 0.06,
};

const INPUT: React.CSSProperties = {
  height: 30,
  padding: "0 10px",
  background: "var(--bg-1)",
  border: "1px solid var(--line)",
  borderRadius: 6,
  color: "var(--ink)",
  fontSize: 13,
  outline: "none",
  fontFamily: "inherit",
};

/**
 * Modal that lists APPROVED WhatsApp templates. Step 1 fills the header (media
 * from the library, or {{n}} text parameters) and the body variables; step 2
 * previews what the customer will receive before sending. Only templates with
 * status === "approved" can be delivered, so the list is filtered to those.
 */
export function TemplateSendDialog({
  open,
  onClose,
  onSend,
}: {
  open: boolean;
  onClose: () => void;
  onSend: (
    name: string,
    language: string,
    variables: string[],
    header?: TemplateHeaderValue,
  ) => Promise<void>;
}) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const listQ = useFetch<ApprovedTemplate[]>(open ? "/templates" : null);
  const items = (listQ.data ?? []).filter((tpl) => tpl.status === "approved");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [vars, setVars] = useState<string[]>([]);
  const [headerVars, setHeaderVars] = useState<string[]>([]);
  const [headerMedia, setHeaderMedia] = useState<Media | null>(null);
  const [step, setStep] = useState<"edit" | "review">("edit");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = items.find((tpl) => tpl.id === selectedId) ?? null;
  const hKind = headerKind(selected);
  const variableCount = useMemo(() => placeholderCount(selected?.body), [selected]);
  const headerVarCount = useMemo(
    () => (hKind === "text" ? placeholderCount(selected?.headerContent) : 0),
    [selected, hKind],
  );

  useEffect(() => {
    // Reset inputs when a different template is picked.
    setVars(Array.from({ length: variableCount }, () => ""));
    setHeaderVars(Array.from({ length: headerVarCount }, () => ""));
    setHeaderMedia(null);
    setStep("edit");
    setError(null);
  }, [selectedId, variableCount, headerVarCount]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !sending) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, sending, onClose]);

  // Keep ABOVE the `if (!open)` return: hook order must not depend on `open`.
  const preview = useMemo(() => (selected?.body ? fill(selected.body, vars) : ""), [selected, vars]);
  const headerPreview = useMemo(
    () => (hKind === "text" && selected?.headerContent ? fill(selected.headerContent, headerVars) : ""),
    [selected, hKind, headerVars],
  );

  if (!open) return null;

  const varsOk = vars.slice(0, variableCount).every((v) => v.trim().length > 0);
  const headerOk =
    hKind === null ||
    (hKind === "text"
      ? headerVars.slice(0, headerVarCount).every((v) => v.trim().length > 0)
      : headerMedia !== null);
  const canContinue = selected !== null && varsOk && headerOk;

  const handleSend = async () => {
    if (!selected) return;
    setSending(true);
    setError(null);
    const header: TemplateHeaderValue | undefined =
      hKind === "text"
        ? headerVarCount > 0
          ? { params: headerVars.slice(0, headerVarCount).map((v) => v.trim()) }
          : undefined
        : hKind && headerMedia
          ? { mediaId: headerMedia.id }
          : undefined;
    try {
      await onSend(selected.name, selected.lang, vars.slice(0, variableCount).map((v) => v.trim()), header);
    } catch (e) {
      setError(sendErrorText(e, tx));
    } finally {
      setSending(false);
    }
  };

  const previewBubble = (
    <div
      style={{
        marginTop: 6,
        padding: 10,
        background: "var(--bg-2)",
        border: "1px solid var(--line-soft)",
        borderRadius: 8,
        fontSize: 13,
        lineHeight: 1.5,
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      }}
    >
      {hKind === "text" && headerPreview && (
        <div dir="auto" style={{ fontWeight: 700, marginBottom: 6 }}>{headerPreview}</div>
      )}
      {hKind && hKind !== "text" && (
        <div
          style={{
            marginBottom: 8,
            borderRadius: 6,
            overflow: "hidden",
            background: "var(--bg-1)",
            border: "1px solid var(--line-soft)",
            maxHeight: 180,
          }}
        >
          {headerMedia ? (
            hKind === "image" ? (
              <div style={{ height: 160 }}>
                <AuthorizedImage
                  url={`${API_BASE}/media/${headerMedia.id}/file`}
                  alt={headerMedia.fileName}
                  token={tokenStore.get()}
                  retryable={false}
                />
              </div>
            ) : (
              <div dir="auto" style={{ padding: 10, fontSize: 12 }}>
                {hKind === "video" ? "🎬 " : "📄 "}
                {headerMedia.fileName}
              </div>
            )
          ) : (
            <div className="muted" style={{ padding: 10, fontSize: 12 }}>
              {tx("(no header file selected)", "(لم يُختر ملف للترويسة)")}
            </div>
          )}
        </div>
      )}
      <div dir="auto">
        {preview || <span className="muted">{tx("(empty body)", "(بدون نص)")}</span>}
      </div>
      {selected?.footer && (
        <div dir="auto" style={{ marginTop: 6, fontSize: 11.5, color: "var(--ink-3)" }}>{selected.footer}</div>
      )}
    </div>
  );

  return (
    <Modal
      onClose={sending ? () => {} : onClose}
      width={640}
      label={tx("Send a WhatsApp template", "أرسل قالب واتساب")}
      panelStyle={{
        padding: 0,
        maxHeight: "min(680px, 90vh)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--line-soft)" }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>{tx("Send a WhatsApp template", "أرسل قالب واتساب")}</h3>
        <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>
          {tx(
            "Templates must be APPROVED by Meta. Submit new ones from the Templates screen.",
            "يجب أن تكون القوالب معتمدة من Meta. أضف قوالب جديدة من شاشة القوالب.",
          )}
        </div>
      </div>

      <div
        style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: "minmax(180px, 220px) 1fr",
          minHeight: 0,
        }}
      >
        <div style={{ borderInlineEnd: "1px solid var(--line-soft)", overflowY: "auto", padding: 8 }}>
          {listQ.loading && items.length === 0 ? (
            <div className="mono muted" style={{ fontSize: 11, padding: 8 }}>
              {tx("loading…", "جارٍ التحميل…")}
            </div>
          ) : items.length === 0 ? (
            <div className="mono muted" style={{ fontSize: 11, padding: 8 }}>
              {tx(
                "No Meta-approved templates yet. Create one on the Templates screen — Meta has to approve it before it can be sent.",
                "لا توجد قوالب معتمدة من Meta بعد. أنشئ قالبًا من شاشة القوالب — يجب أن تعتمده Meta قبل الإرسال.",
              )}
            </div>
          ) : (
            items.map((tpl) => {
              const isActive = selectedId === tpl.id;
              return (
                <button
                  key={tpl.id}
                  type="button"
                  disabled={sending}
                  onClick={() => setSelectedId(tpl.id)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "start",
                    padding: "8px 10px",
                    borderRadius: 8,
                    background: isActive ? "var(--accent-soft)" : "transparent",
                    border: isActive ? "1px solid var(--accent-ring)" : "1px solid transparent",
                    cursor: "pointer",
                    marginBottom: 2,
                    fontFamily: "inherit",
                    color: "var(--ink)",
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 500 }}>{tpl.name}</div>
                  <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)", marginTop: 2 }}>
                    {tpl.lang.toUpperCase()} · {tpl.category.toLowerCase()}
                    {headerKind(tpl) && headerKind(tpl) !== "text" ? ` · ${headerKind(tpl)}` : ""}
                  </div>
                </button>
              );
            })
          )}
        </div>

        <div style={{ overflowY: "auto", padding: 16 }}>
          {!selected ? (
            <div className="mono muted" style={{ fontSize: 12, opacity: 0.7 }}>
              {tx("Pick a template on the left.", "اختر قالبًا من القائمة.")}
            </div>
          ) : step === "review" ? (
            <>
              <div style={CAPTION}>{tx("Review before sending", "مراجعة قبل الإرسال")}</div>
              {previewBubble}
            </>
          ) : (
            <>
              {hKind === "text" && headerVarCount > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div style={CAPTION}>{tx("Header variables", "متغيرات الترويسة")}</div>
                  <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
                    {Array.from({ length: headerVarCount }, (_, i) => (
                      <label key={i} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>{`{{${i + 1}}}`}</span>
                        <input
                          dir="auto"
                          value={headerVars[i] ?? ""}
                          onChange={(e) => {
                            const next = [...headerVars];
                            next[i] = e.target.value;
                            setHeaderVars(next);
                          }}
                          placeholder={tx(`Value for {{${i + 1}}}`, `قيمة {{${i + 1}}}`)}
                          style={INPUT}
                        />
                      </label>
                    ))}
                  </div>
                </div>
              )}
              {hKind && hKind !== "text" && (
                <div style={{ marginBottom: 16 }}>
                  <MediaPicker kind={hKind} value={headerMedia?.id ?? null} onChange={setHeaderMedia} tx={tx} />
                </div>
              )}

              <div style={CAPTION}>{tx("Preview", "معاينة")}</div>
              {previewBubble}

              {variableCount > 0 && (
                <>
                  <div style={{ ...CAPTION, marginTop: 16 }}>{tx("Variables", "المتغيرات")}</div>
                  <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
                    {Array.from({ length: variableCount }, (_, i) => (
                      <label key={i} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>{`{{${i + 1}}}`}</span>
                        <input
                          dir="auto"
                          value={vars[i] ?? ""}
                          onChange={(e) => {
                            const next = [...vars];
                            next[i] = e.target.value;
                            setVars(next);
                          }}
                          placeholder={tx(`Value for {{${i + 1}}}`, `قيمة {{${i + 1}}}`)}
                          style={INPUT}
                        />
                      </label>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
          {error && (
            <div
              role="alert"
              style={{
                marginTop: 12,
                padding: "8px 10px",
                borderRadius: 6,
                background: "color-mix(in oklch, var(--bad) 10%, transparent)",
                color: "var(--bad)",
                fontSize: 12,
                border: "1px solid color-mix(in oklch, var(--bad) 30%, transparent)",
              }}
            >
              {error}
            </div>
          )}
        </div>
      </div>

      <div
        style={{
          padding: "10px 14px",
          borderTop: "1px solid var(--line-soft)",
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
        }}
      >
        <button type="button" className="btn ghost" onClick={onClose} disabled={sending}>
          {tx("Cancel", "إلغاء")}
        </button>
        {step === "review" ? (
          <>
            <button type="button" className="btn" onClick={() => setStep("edit")} disabled={sending}>
              {tx("Back", "رجوع")}
            </button>
            <button type="button" className="btn primary" onClick={() => void handleSend()} disabled={sending}>
              {sending ? tx("Sending…", "جارٍ الإرسال…") : tx("Send template", "إرسال القالب")}
            </button>
          </>
        ) : (
          <button type="button" className="btn primary" onClick={() => setStep("review")} disabled={!canContinue}>
            {tx("Review", "مراجعة")}
          </button>
        )}
      </div>
    </Modal>
  );
}
