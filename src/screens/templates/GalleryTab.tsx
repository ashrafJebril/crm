import { useRef, useState } from "react";
import { API_BASE, api, tokenStore } from "@/api/client";
import { uploadMedia } from "@/api/uploadMedia";
import { usePermissions } from "@/auth/usePermissions";
import { AuthorizedImage } from "@/components/AuthorizedImage";
import { Modal } from "@/components/Modal";
import { useMediaPages } from "@/components/media/mediaApi";
import { mediaErrorText, mediaLibraryBlocked, mediaNoAccessText } from "@/components/media/mediaErrors";
import { LIBRARY_MIMES, MEDIA_CATEGORIES, formatBytes, kindOfMime, type MediaCategory } from "@/components/media/mediaKinds";
import { useToast } from "@/components/Toast";
import { IconPlus, IconTrash } from "@/icons";
import type { Tx } from "@/lib/tx";
import type { Media } from "@/lib/types";

const ACCEPT = [...LIBRARY_MIMES.image, ...LIBRARY_MIMES.video, ...LIBRARY_MIMES.document].join(",");

/** Saves a library file through the authenticated proxy (PDFs are served as attachments, never inline). */
async function downloadMedia(m: Media): Promise<void> {
  const tok = tokenStore.get();
  const res = await fetch(`${API_BASE}/media/${m.id}/file`, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = m.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * SP-13 Templates → Gallery: the media library (images, videos and PDFs) with
 * category chips, paged by the `X-Media-Next-Before` cursor. Upload needs
 * conversations.create and delete conversations.update (the backend route
 * map); hidden actions are not rendered. Listing needs conversations.view:
 * without it (or on a 403) the tab shows a no-access line, never an error,
 * and fetches nothing (SP-13 final review).
 */
export function GalleryTab({ tx }: { tx: Tx }) {
  const { can } = usePermissions();
  const { toast } = useToast();
  const canUpload = can("conversations.create");
  const canDelete = can("conversations.update");
  const canView = can("conversations.view");
  const [category, setCategory] = useState<MediaCategory>("all");
  const pages = useMediaPages(category, canView);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Media | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const upload = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      await uploadMedia(file);
      await pages.invalidate();
      toast(tx("File uploaded", "تم رفع الملف"), "success");
    } catch (e) {
      setError(mediaErrorText(e, tx, tx("Upload failed", "فشل الرفع")));
    } finally {
      setUploading(false);
    }
  };

  const remove = async () => {
    if (!confirm) return;
    setDeleting(true);
    setConfirmError(null);
    try {
      await api.delete(`/media/${confirm.id}`);
      setConfirm(null);
      await pages.invalidate();
      toast(tx("File deleted", "تم حذف الملف"), "success");
    } catch (e) {
      setConfirmError(mediaErrorText(e, tx, tx("Delete failed.", "فشل الحذف.")));
    } finally {
      setDeleting(false);
    }
  };

  const token = tokenStore.get();

  if (mediaLibraryBlocked(canView, pages.error)) {
    return (
      <div style={{ padding: 20, flex: 1, minHeight: 0 }}>
        <div
          role="status"
          className="muted"
          style={{ fontSize: 13, padding: "32px 16px", textAlign: "center", border: "1px dashed var(--line-soft)", borderRadius: 12 }}
        >
          {mediaNoAccessText(tx)}
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 20, display: "grid", gap: 14, alignContent: "start", overflowY: "auto", flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {MEDIA_CATEGORIES.map((c) => {
          const on = category === c.id;
          return (
            <button
              key={c.id}
              type="button"
              className="chip"
              aria-pressed={on}
              onClick={() => setCategory(c.id)}
              style={{
                background: on ? "var(--accent-soft)" : "var(--bg-2)",
                color: on ? "var(--accent)" : "var(--ink-1)",
                border: `1px solid ${on ? "var(--accent-ring)" : "var(--line-soft)"}`,
                fontSize: 12,
                padding: "4px 12px",
                borderRadius: 999,
                cursor: "pointer",
              }}
            >
              {tx(c.en, c.ar)}
            </button>
          );
        })}
        <span style={{ flex: 1 }} />
        {canUpload && (
          <>
            <button type="button" className="btn primary sm" disabled={uploading} onClick={() => fileRef.current?.click()}>
              <IconPlus w={12} />
              {uploading ? tx("Uploading…", "جارٍ الرفع…") : tx("Upload", "رفع")}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT}
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
      <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
        {tx(
          "Images up to 20 MB, videos up to 300 MB and PDFs up to 100 MB. WhatsApp template headers take JPG/PNG up to 5 MB, MP4 up to 16 MB and PDF up to 100 MB.",
          "صور حتى 20 MB، وفيديو حتى 300 MB، وملفات PDF حتى 100 MB. ترويسات قوالب واتساب تقبل JPG/PNG حتى 5 MB، وMP4 حتى 16 MB، وPDF حتى 100 MB.",
        )}
      </div>

      {error && (
        <div role="alert" style={{ fontSize: 12.5, color: "var(--bad)" }}>
          {error}
        </div>
      )}
      {pages.error && (
        <div role="alert" style={{ fontSize: 12.5, color: "var(--bad)" }}>
          {mediaErrorText(pages.error, tx)}
        </div>
      )}

      {pages.loading && pages.items.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>{tx("loading…", "جارٍ التحميل…")}</div>
      ) : pages.items.length === 0 && !pages.hasMore ? (
        <div
          className="muted"
          style={{ fontSize: 13, padding: "32px 16px", textAlign: "center", border: "1px dashed var(--line-soft)", borderRadius: 12 }}
        >
          {tx("No files here yet.", "لا توجد ملفات هنا بعد.")}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 12 }}>
          {pages.items.map((m) => {
            const kind = kindOfMime(m.mimeType);
            return (
              <div key={m.id} className="card" style={{ padding: 10, display: "grid", gap: 8, alignContent: "start" }}>
                <div
                  style={{
                    height: 120,
                    borderRadius: 8,
                    overflow: "hidden",
                    background: "var(--bg-2)",
                    display: "grid",
                    placeItems: "center",
                    fontSize: 34,
                  }}
                >
                  {kind === "image" ? (
                    <AuthorizedImage url={`${API_BASE}/media/${m.id}/file`} alt={m.fileName} token={token} retryable={false} />
                  ) : (
                    <span aria-hidden>{kind === "video" ? "🎬" : "📄"}</span>
                  )}
                </div>
                <div dir="auto" title={m.fileName} style={{ fontSize: 12, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {m.fileName}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)", flex: 1 }}>
                    <bdi dir="ltr">{formatBytes(m.sizeBytes)}</bdi>
                  </span>
                  {kind === "document" && (
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() =>
                        void downloadMedia(m).catch(() => toast(tx("Download failed", "فشل التنزيل"), "error"))
                      }
                    >
                      {tx("Download", "تنزيل")}
                    </button>
                  )}
                  {canDelete && (
                    <button
                      type="button"
                      className="btn ghost icon sm"
                      aria-label={tx("Delete", "حذف")}
                      title={tx("Delete", "حذف")}
                      onClick={() => {
                        setConfirmError(null);
                        setConfirm(m);
                      }}
                    >
                      <IconTrash w={13} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {pages.hasMore && (
        <div>
          <button type="button" className="btn" disabled={pages.loadingMore} onClick={pages.loadMore}>
            {pages.loadingMore ? tx("Loading…", "جارٍ التحميل…") : tx("Load more", "تحميل المزيد")}
          </button>
        </div>
      )}

      {confirm && (
        <Modal onClose={deleting ? () => {} : () => setConfirm(null)} width={420} label={tx("Delete file", "حذف الملف")}>
          <div style={{ display: "grid", gap: 12 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>{tx("Delete this file?", "حذف هذا الملف؟")}</h3>
            <p dir="auto" style={{ margin: 0, fontSize: 13, color: "var(--ink-2)" }}>
              {confirm.fileName}
            </p>
            {confirmError && (
              <div role="alert" style={{ fontSize: 12.5, color: "var(--bad)" }}>
                {confirmError}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" className="btn" disabled={deleting} onClick={() => setConfirm(null)}>
                {tx("Cancel", "إلغاء")}
              </button>
              <button type="button" className="btn danger" disabled={deleting} onClick={() => void remove()}>
                {deleting ? tx("Deleting…", "جارٍ الحذف…") : tx("Delete", "حذف")}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
