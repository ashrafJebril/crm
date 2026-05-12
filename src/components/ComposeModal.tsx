import { useEffect, useRef, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { useAuth } from "@/auth/context";
import { useFetch, useMutation } from "@/api/useFetch";
import { api, tokenStore } from "@/api/client";
import { Avatar } from "@/components/Avatar";
import { IconBolt, IconCheck, IconPlus, IconX } from "@/icons";
import type { Media } from "@/lib/types";

interface FbStatus {
  connected: boolean;
  pageId?: string;
  pageName?: string;
}

interface ComposeModalProps {
  open: boolean;
  onClose: () => void;
  onPosted?: () => void;
}

const CHAR_LIMIT_FB = 63206;

export function ComposeModal({ open, onClose, onPosted }: ComposeModalProps) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { activeWorkspace } = useAuth();

  const fbStatusQ = useFetch<FbStatus>(open ? "/integrations/facebook/status" : null);
  const mediaQ = useFetch<Media[]>(open ? "/media" : null);

  const [content, setContent] = useState("");
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const publishMut = useMutation<
    { content: string; mediaIds?: string[] },
    { id: string; kind: "feed" | "photo" }
  >((input) => api.post("/integrations/facebook/posts", input));

  // Reset state when modal closes (so reopening starts fresh).
  useEffect(() => {
    if (!open) {
      setContent("");
      setSelectedMediaId(null);
      setPickerOpen(false);
    }
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const connected = fbStatusQ.data?.connected === true;
  const selectedMedia = mediaQ.data?.find((m) => m.id === selectedMediaId) ?? null;
  const canPost = content.trim().length > 0 && connected && !publishMut.loading;

  const onPost = async () => {
    if (!canPost) return;
    await publishMut.mutate({
      content: content.trim(),
      mediaIds: selectedMediaId ? [selectedMediaId] : undefined,
    });
    onPosted?.();
    onClose();
  };

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "var(--scrim, rgba(0,0,0,0.55))",
          zIndex: 80,
        }}
      />
      <div
        role="dialog"
        aria-label={tx("Compose new post", "إنشاء منشور")}
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: "min(960px, 96vw)",
          height: "min(700px, 92vh)",
          background: "var(--bg-elev)",
          border: "1px solid var(--line-soft)",
          borderRadius: 14,
          boxShadow: "var(--shadow-lg)",
          zIndex: 81,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "12px 16px",
            borderBottom: "1px solid var(--line-soft)",
          }}
        >
          <span style={{ fontWeight: 600, fontSize: 14 }}>
            {tx("New social post", "منشور جديد")}
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="btn ghost icon sm"
            onClick={onClose}
            aria-label={tx("Close", "إغلاق")}
          >
            <IconX w={14} />
          </button>
        </div>

        {/* Body: composer on the left, preview on the right */}
        <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 360px", minHeight: 0 }}>
          {/* Composer */}
          <div
            style={{
              padding: 18,
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 14,
              borderInlineEnd: "1px solid var(--line-soft)",
            }}
          >
            <div>
              <div
                className="mono"
                style={{
                  fontSize: 10,
                  color: "var(--ink-3)",
                  textTransform: "uppercase",
                  letterSpacing: 0.06,
                  marginBottom: 6,
                }}
              >
                {tx("Post to", "نشر إلى")}
              </div>
              <ChannelChips connected={connected} pageName={fbStatusQ.data?.pageName} />
            </div>

            <div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginBottom: 6,
                }}
              >
                <span
                  className="mono"
                  style={{
                    fontSize: 10,
                    color: "var(--ink-3)",
                    textTransform: "uppercase",
                    letterSpacing: 0.06,
                  }}
                >
                  {tx("Content", "المحتوى")}
                </span>
                <span
                  className="mono"
                  style={{
                    fontSize: 10,
                    color:
                      content.length > CHAR_LIMIT_FB
                        ? "var(--bad)"
                        : "var(--ink-3)",
                  }}
                >
                  {content.length} / {CHAR_LIMIT_FB}
                </span>
              </div>
              <textarea
                autoFocus
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={8}
                placeholder={tx(
                  "Write your post… text and one image are supported in this phase.",
                  "اكتب منشورك… النص وصورة واحدة مدعومة في هذه المرحلة.",
                )}
                style={{
                  width: "100%",
                  minHeight: 160,
                  resize: "vertical",
                  padding: "10px 12px",
                  background: "var(--bg-2)",
                  border: "1px solid var(--line)",
                  borderRadius: 10,
                  color: "var(--ink)",
                  fontSize: 14,
                  fontFamily: "inherit",
                  lineHeight: 1.5,
                  outline: "none",
                }}
              />
            </div>

            {/* Media */}
            <MediaPicker
              media={mediaQ.data ?? []}
              loading={mediaQ.loading}
              selectedId={selectedMediaId}
              onSelect={setSelectedMediaId}
              pickerOpen={pickerOpen}
              setPickerOpen={setPickerOpen}
              onUploaded={() => mediaQ.refetch()}
              tx={tx}
            />

            {publishMut.error && (
              <div
                style={{
                  padding: "10px 12px",
                  borderRadius: 8,
                  background: "oklch(0.7 0.22 24 / 0.12)",
                  color: "var(--bad)",
                  fontSize: 12,
                  border: "1px solid oklch(0.7 0.22 24 / 0.35)",
                }}
              >
                {publishMut.error}
              </div>
            )}
          </div>

          {/* Preview pane */}
          <div
            style={{
              background: "var(--bg-1)",
              padding: 18,
              overflowY: "auto",
            }}
          >
            <div
              className="mono"
              style={{
                fontSize: 10,
                color: "var(--ink-3)",
                textTransform: "uppercase",
                letterSpacing: 0.06,
                marginBottom: 10,
              }}
            >
              {tx("Post preview", "معاينة المنشور")}
            </div>
            <FbPreviewCard
              pageName={fbStatusQ.data?.pageName ?? activeWorkspace?.name ?? "Page"}
              content={content}
              media={selectedMedia}
            />
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "12px 16px",
            borderTop: "1px solid var(--line-soft)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{ flex: 1, fontSize: 11, color: "var(--ink-3)" }}>
            {!connected &&
              tx(
                "Facebook is not connected — connect from Settings → Integrations.",
                "فيسبوك غير متصل — اربطه من الإعدادات.",
              )}
          </span>
          <button type="button" className="btn ghost" onClick={onClose}>
            {tx("Cancel", "إلغاء")}
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={onPost}
            disabled={!canPost}
          >
            <IconBolt w={13} />
            {publishMut.loading
              ? tx("Posting…", "جارٍ النشر…")
              : tx("Post now", "نشر الآن")}
          </button>
        </div>
      </div>
    </>
  );
}

/* ── Channel chips (FB enabled; IG/TikTok placeholders) ───────────────── */

function ChannelChips({
  connected,
  pageName,
}: {
  connected: boolean;
  pageName: string | undefined;
}) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 12px",
          borderRadius: 999,
          background: connected ? "#1877F2" : "var(--bg-2)",
          color: connected ? "#fff" : "var(--ink-3)",
          fontSize: 12,
          fontWeight: 500,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: connected ? "#fff" : "var(--ink-3)",
          }}
        />
        Facebook {connected && pageName ? `· ${pageName}` : ""}
      </span>
      <span
        style={{
          padding: "6px 12px",
          borderRadius: 999,
          background: "var(--bg-2)",
          color: "var(--ink-3)",
          fontSize: 12,
        }}
      >
        Instagram · {tx("coming soon", "قريباً")}
      </span>
    </div>
  );
}

/* ── Media picker ─────────────────────────────────────────────────────── */

interface MediaPickerProps {
  media: Media[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  pickerOpen: boolean;
  setPickerOpen: (v: boolean) => void;
  onUploaded: () => void;
  tx: (en: string, ar: string) => string;
}

function MediaPicker({
  media,
  loading,
  selectedId,
  onSelect,
  pickerOpen,
  setPickerOpen,
  onUploaded,
  tx,
}: MediaPickerProps) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const onPick = () => fileRef.current?.click();

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    setUploading(true);
    setUploadError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const base =
        (import.meta.env.VITE_API_URL as string | undefined) ??
        "http://localhost:3001/api";
      const tok = tokenStore.get();
      const resp = await fetch(`${base}/media/upload`, {
        method: "POST",
        headers: tok ? { Authorization: `Bearer ${tok}` } : {},
        body: form,
      });
      if (!resp.ok) {
        const txt = await resp.text();
        let msg = `Upload failed (${resp.status})`;
        try {
          const j = JSON.parse(txt) as { id?: string; message?: string | string[] };
          msg = Array.isArray(j.message)
            ? j.message.join(", ")
            : j.message ?? msg;
        } catch {
          /* keep generic */
        }
        throw new Error(msg);
      }
      const created = (await resp.json()) as Media;
      onUploaded();
      onSelect(created.id);
      setPickerOpen(false);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      <div
        className="mono"
        style={{
          fontSize: 10,
          color: "var(--ink-3)",
          textTransform: "uppercase",
          letterSpacing: 0.06,
          marginBottom: 6,
        }}
      >
        {tx("Media", "وسائط")}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        onChange={onFile}
        style={{ display: "none" }}
      />
      {selectedId ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 10px",
            border: "1px solid var(--line-soft)",
            borderRadius: 10,
            background: "var(--bg-2)",
          }}
        >
          <PreviewThumb mediaId={selectedId} />
          <span style={{ flex: 1, fontSize: 12, color: "var(--ink-2)" }}>
            {media.find((m) => m.id === selectedId)?.fileName ?? "selected"}
          </span>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => onSelect(null)}
          >
            {tx("Remove", "حذف")}
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn"
            onClick={() => setPickerOpen(!pickerOpen)}
          >
            {tx("Pick from library", "اختر من المكتبة")}
          </button>
          <button
            type="button"
            className="btn"
            onClick={onPick}
            disabled={uploading}
          >
            <IconPlus w={12} />
            {uploading ? tx("Uploading…", "جارٍ الرفع…") : tx("Upload new", "ارفع جديدة")}
          </button>
        </div>
      )}
      {pickerOpen && (
        <div
          style={{
            marginTop: 10,
            border: "1px solid var(--line-soft)",
            borderRadius: 10,
            padding: 10,
            maxHeight: 200,
            overflowY: "auto",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(90px, 1fr))",
            gap: 8,
            background: "var(--bg-2)",
          }}
        >
          {loading && (
            <div className="mono muted pulse" style={{ fontSize: 11 }}>
              {tx("loading…", "جارٍ التحميل…")}
            </div>
          )}
          {!loading && media.length === 0 && (
            <div className="mono muted" style={{ fontSize: 11, gridColumn: "1 / -1" }}>
              {tx("No media yet. Upload one.", "لا توجد وسائط بعد.")}
            </div>
          )}
          {media.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                onSelect(m.id);
                setPickerOpen(false);
              }}
              style={{
                padding: 0,
                background: "var(--bg-1)",
                border: "1px solid var(--line-soft)",
                borderRadius: 8,
                aspectRatio: "1 / 1",
                overflow: "hidden",
                cursor: "pointer",
                position: "relative",
              }}
              title={m.fileName}
            >
              <PreviewThumb mediaId={m.id} />
              {m.id === selectedId && (
                <span
                  style={{
                    position: "absolute",
                    top: 4,
                    insetInlineEnd: 4,
                    background: "var(--accent)",
                    borderRadius: "50%",
                    width: 16,
                    height: 16,
                    display: "grid",
                    placeItems: "center",
                    color: "#fff",
                  }}
                >
                  <IconCheck w={10} />
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {uploadError && (
        <div
          style={{
            marginTop: 8,
            color: "var(--bad)",
            fontSize: 11,
          }}
        >
          {uploadError}
        </div>
      )}
    </div>
  );
}

/* ── Thumbnail (fetches binary with bearer, renders as blob URL) ────── */

function PreviewThumb({ mediaId }: { mediaId: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tok = tokenStore.get();
    const base =
      (import.meta.env.VITE_API_URL as string | undefined) ??
      "http://localhost:3001/api";
    fetch(`${base}/media/${mediaId}/file`, {
      headers: tok ? { Authorization: `Bearer ${tok}` } : {},
    })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (cancelled || !b) return;
        setSrc(URL.createObjectURL(b));
      })
      .catch(() => {
        /* leave src null */
      });
    return () => {
      cancelled = true;
    };
  }, [mediaId]);

  useEffect(() => {
    return () => {
      if (src) URL.revokeObjectURL(src);
    };
  }, [src]);

  if (!src) {
    return (
      <div
        className="mono muted"
        style={{
          width: "100%",
          height: "100%",
          display: "grid",
          placeItems: "center",
          fontSize: 10,
        }}
      >
        …
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      style={{
        width: "100%",
        height: "100%",
        objectFit: "cover",
        display: "block",
      }}
    />
  );
}

/* ── FB-style preview card ─────────────────────────────────────────── */

function FbPreviewCard({
  pageName,
  content,
  media,
}: {
  pageName: string;
  content: string;
  media: Media | null;
}) {
  return (
    <div
      style={{
        background: "var(--bg-elev)",
        border: "1px solid var(--line-soft)",
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      <div style={{ padding: 12, display: "flex", gap: 10, alignItems: "center" }}>
        <Avatar name={pageName} color="240" size="lg" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{pageName}</div>
          <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
            JUST NOW · 🌐
          </div>
        </div>
      </div>
      {content && (
        <div
          style={{
            padding: "0 12px 12px",
            fontSize: 13,
            color: "var(--ink-1)",
            whiteSpace: "pre-wrap",
            lineHeight: 1.45,
          }}
        >
          {content}
        </div>
      )}
      {media && <PreviewThumb mediaId={media.id} />}
      <div
        style={{
          padding: "10px 12px",
          borderTop: "1px solid var(--line-soft)",
          display: "flex",
          gap: 16,
          fontSize: 12,
          color: "var(--ink-3)",
        }}
      >
        <span>👍 Like</span>
        <span>💬 Comment</span>
        <span>↗ Share</span>
      </div>
    </div>
  );
}
