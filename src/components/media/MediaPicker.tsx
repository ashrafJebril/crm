import { useRef, useState, type CSSProperties } from "react";
import { API_BASE, tokenStore } from "@/api/client";
import { uploadMedia } from "@/api/uploadMedia";
import { usePermissions } from "@/auth/usePermissions";
import { AuthorizedImage } from "@/components/AuthorizedImage";
import type { Tx } from "@/lib/tx";
import type { Media } from "@/lib/types";
import { useMediaPages } from "./mediaApi";
import { mediaErrorText } from "./mediaErrors";
import { HEADER_MIMES, formatBytes, headerIneligibleReason, type HeaderMediaKind } from "./mediaKinds";

const CAPTION: CSSProperties = {
  fontSize: 10,
  fontFamily: "var(--font-mono)",
  color: "var(--ink-3)",
  textTransform: "uppercase",
  letterSpacing: 0.06,
};

export const headerKindName = (kind: HeaderMediaKind, tx: Tx): string =>
  ({
    image: tx("image (JPG or PNG, up to 5 MB)", "صورة (JPG أو PNG، حتى 5 MB)"),
    video: tx("video (MP4, up to 16 MB)", "فيديو (MP4، حتى 16 MB)"),
    document: tx("document (PDF, up to 100 MB)", "مستند (PDF، حتى 100 MB)"),
  })[kind];

/**
 * Media-library picker for an IMAGE / VIDEO / DOCUMENT template header
 * (extracted from the inbox TemplateSendDialog, SP-31). Lists the library
 * files of that kind page by page ("Load more" follows the cursor header),
 * greys out files WhatsApp won't take as a header (type or size) with the
 * reason, and uploads a new file when the role may (conversations.create).
 */
export function MediaPicker({
  kind,
  value,
  onChange,
  tx,
  caption,
}: {
  kind: HeaderMediaKind;
  /** The chosen file's id. */
  value: string | null;
  onChange: (m: Media | null) => void;
  tx: Tx;
  /** Replaces the "Header: <kind>" caption. */
  caption?: string;
}) {
  const { can } = usePermissions();
  const canUpload = can("conversations.create");
  const pages = useMediaPages(kind);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const token = tokenStore.get();
  const items = pages.items;

  const upload = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const m = await uploadMedia(file);
      await pages.invalidate();
      const why = headerIneligibleReason(m, kind, tx);
      if (why) {
        setError(`${tx("Uploaded to the library, but it can't be used here", "تم رفعه إلى المكتبة، لكن لا يمكن استخدامه هنا")}: ${why}`);
        return;
      }
      onChange(m);
    } catch (e) {
      setError(mediaErrorText(e, tx, tx("Upload failed", "فشل الرفع")));
    } finally {
      setUploading(false);
    }
  };

  const selectedMissing = value !== null && !items.some((m) => m.id === value);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={CAPTION}>{caption ?? `${tx("Header", "الترويسة")}: ${headerKindName(kind, tx)}`}</span>
        {canUpload && (
          <>
            <button
              type="button"
              className="btn sm"
              style={{ marginInlineStart: "auto" }}
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
            >
              {uploading ? tx("Uploading…", "جارٍ الرفع…") : tx("Upload new", "رفع جديد")}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept={HEADER_MIMES[kind].join(",")}
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void upload(f);
              }}
            />
          </>
        )}
      </div>
      {error && (
        <div role="alert" style={{ marginTop: 6, fontSize: 11.5, color: "var(--bad)" }}>
          {error}
        </div>
      )}
      {pages.error && (
        <div role="alert" style={{ marginTop: 6, fontSize: 11.5, color: "var(--bad)" }}>
          {mediaErrorText(pages.error, tx)}
        </div>
      )}
      {selectedMissing && (
        <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--ink-3)" }}>
          {tx("A file is chosen (not in the list loaded so far).", "تم اختيار ملف (ليس ضمن القائمة المحمّلة حتى الآن).")}
        </div>
      )}
      <div
        style={{
          marginTop: 8,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))",
          gap: 6,
          maxHeight: 220,
          overflowY: "auto",
        }}
      >
        {pages.loading && items.length === 0 ? (
          <span className="muted" style={{ fontSize: 11 }}>{tx("loading…", "جارٍ التحميل…")}</span>
        ) : items.length === 0 && !pages.hasMore ? (
          <span className="muted" style={{ fontSize: 11.5, gridColumn: "1 / -1" }}>
            {canUpload
              ? tx("No matching files in the media library. Upload one.", "لا توجد ملفات مطابقة في مكتبة الوسائط. ارفع ملفًا.")
              : tx("No matching files in the media library.", "لا توجد ملفات مطابقة في مكتبة الوسائط.")}
          </span>
        ) : (
          items.map((m) => {
            const on = value === m.id;
            const why = headerIneligibleReason(m, kind, tx);
            const disabled = !!why && !on;
            return (
              <button
                key={m.id}
                type="button"
                aria-pressed={on}
                disabled={disabled}
                title={why ? `${m.fileName} — ${why}` : `${m.fileName} · ${formatBytes(m.sizeBytes)}`}
                onClick={() => onChange(on ? null : m)}
                style={{
                  position: "relative",
                  aspectRatio: "1",
                  padding: 0,
                  overflow: "hidden",
                  borderRadius: 8,
                  border: on ? "2px solid var(--accent)" : "1px solid var(--line-soft)",
                  background: "var(--bg-2)",
                  cursor: disabled ? "not-allowed" : "pointer",
                  opacity: disabled ? 0.45 : 1,
                  color: "var(--ink-2)",
                  fontSize: 10.5,
                }}
              >
                {kind === "image" ? (
                  <AuthorizedImage url={`${API_BASE}/media/${m.id}/file`} alt={m.fileName} token={token} retryable={false} />
                ) : (
                  <span dir="auto" style={{ display: "block", padding: 6, overflowWrap: "anywhere", textAlign: "start" }}>
                    {kind === "video" ? "🎬 " : "📄 "}
                    {m.fileName}
                    <span className="mono" style={{ display: "block", marginTop: 2, color: "var(--ink-3)" }}>
                      <bdi dir="ltr">{formatBytes(m.sizeBytes)}</bdi>
                    </span>
                  </span>
                )}
                {why && (
                  <span
                    style={{
                      position: "absolute",
                      insetInline: 0,
                      insetBlockEnd: 0,
                      padding: "2px 4px",
                      fontSize: 9.5,
                      background: "color-mix(in oklch, var(--bg-1) 85%, transparent)",
                      color: "var(--ink-2)",
                    }}
                  >
                    {why}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
      {pages.hasMore && (
        <button type="button" className="btn ghost sm" style={{ marginTop: 6 }} disabled={pages.loadingMore} onClick={pages.loadMore}>
          {pages.loadingMore ? tx("Loading…", "جارٍ التحميل…") : tx("Load more", "تحميل المزيد")}
        </button>
      )}
    </div>
  );
}
