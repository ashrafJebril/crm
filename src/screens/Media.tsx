import { memo, useEffect, useRef, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { PageHeader } from "@/components/PageHeader";
import { useFetch, useMutation } from "@/api/useFetch";
import { API_BASE, api, tokenStore } from "@/api/client";
import { IconPlus, IconTrash } from "@/icons";
import type { Media } from "@/lib/types";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function MediaImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);

  const listQ = useFetch<Media[]>("/media");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const deleteMut = useMutation<{ id: string }, { ok: true }>((input) =>
    api.delete(`/media/${input.id}`),
  );

  // Asks for confirmation before deleting. Backed by a styled in-app dialog
  // instead of the native `window.confirm` (which is unstyleable + jarring).
  const [confirmTarget, setConfirmTarget] = useState<Media | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const onPickFile = () => fileInputRef.current?.click();

  const onFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ""; // reset so the same file can be re-picked

    setUploading(true);
    setUploadError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      // We need a raw fetch here because the `api` helper sends JSON only.
      const base = API_BASE;
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
          const j = JSON.parse(txt) as { message?: string | string[] };
          msg = Array.isArray(j.message)
            ? j.message.join(", ")
            : j.message ?? msg;
        } catch {
          /* keep generic */
        }
        throw new Error(msg);
      }
      listQ.refetch();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const requestDelete = (m: Media) => {
    setConfirmError(null);
    setConfirmTarget(m);
  };

  const confirmDelete = async () => {
    if (!confirmTarget) return;
    try {
      await deleteMut.mutate({ id: confirmTarget.id });
      setConfirmTarget(null);
      listQ.refetch();
    } catch (err) {
      setConfirmError(
        err instanceof Error ? err.message : tx("Delete failed.", "فشل الحذف."),
      );
    }
  };

  const items = listQ.data ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <PageHeader
        title={tx("Media library", "مكتبة الوسائط")}
        subtitle={tx(
          "Images you can attach to posts. Up to 20 MB per file.",
          "صور يمكنك إرفاقها بالمنشورات. الحد الأقصى ٢٠ ميغا بايت.",
        )}
        actions={
          <button
            className="btn primary"
            onClick={onPickFile}
            disabled={uploading}
          >
            <IconPlus w={13} />
            {uploading ? tx("Uploading…", "جارٍ الرفع…") : tx("Upload", "رفع")}
          </button>
        }
      />

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        onChange={onFileChosen}
        style={{ display: "none" }}
      />

      <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px" }}>
        {uploadError && (
          <div
            style={{
              padding: "10px 12px",
              borderRadius: 8,
              background: "oklch(0.7 0.22 24 / 0.12)",
              color: "var(--bad)",
              fontSize: 12,
              border: "1px solid oklch(0.7 0.22 24 / 0.35)",
              marginBottom: 12,
            }}
          >
            {uploadError}
          </div>
        )}

        {listQ.loading && items.length === 0 && (
          <div className="mono muted pulse" style={{ fontSize: 12, padding: 16 }}>
            {tx("loading…", "جارٍ التحميل…")}
          </div>
        )}

        {!listQ.loading && items.length === 0 && (
          <div
            className="mono muted"
            style={{
              fontSize: 13,
              padding: "32px 16px",
              textAlign: "center",
              border: "1px dashed var(--line-soft)",
              borderRadius: 12,
            }}
          >
            {tx(
              "No media yet. Click Upload to add an image.",
              "لا توجد وسائط بعد. اضغط رفع لإضافة صورة.",
            )}
          </div>
        )}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            gap: 12,
          }}
        >
          {items.map((m) => (
            <MediaTile key={m.id} m={m} onDelete={() => requestDelete(m)} />
          ))}
        </div>
      </div>

      {confirmTarget && (
        <DeleteConfirmDialog
          fileName={confirmTarget.fileName}
          busy={deleteMut.loading}
          error={confirmError}
          onCancel={() => setConfirmTarget(null)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}

interface DeleteConfirmDialogProps {
  fileName: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

function DeleteConfirmDialog({
  fileName,
  busy,
  error,
  onCancel,
  onConfirm,
}: DeleteConfirmDialogProps) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);

  // Esc to cancel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={busy ? undefined : onCancel}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "grid",
        placeItems: "center",
        background: "oklch(0 0 0 / 0.5)",
        backdropFilter: "blur(2px)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(420px, 92vw)",
          background: "var(--bg-elev)",
          border: "1px solid var(--line)",
          borderRadius: 14,
          boxShadow: "var(--shadow-lg)",
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            aria-hidden
            style={{
              width: 36,
              height: 36,
              borderRadius: 999,
              background: "color-mix(in oklch, var(--bad) 16%, transparent)",
              color: "var(--bad)",
              display: "grid",
              placeItems: "center",
              flex: "0 0 auto",
            }}
          >
            <IconTrash w={18} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>
              {tx("Delete this file?", "حذف هذا الملف؟")}
            </h3>
            <div
              style={{
                fontSize: 12,
                color: "var(--ink-2)",
                marginTop: 4,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
              title={fileName}
            >
              {fileName}
            </div>
          </div>
        </div>

        <div
          style={{
            fontSize: 12,
            color: "var(--ink-2)",
            lineHeight: 1.5,
          }}
        >
          {tx(
            "The file will be permanently removed from storage. This cannot be undone.",
            "سيتم حذف الملف نهائيًا من التخزين. لا يمكن التراجع عن هذا الإجراء.",
          )}
        </div>

        {error && (
          <div
            style={{
              fontSize: 12,
              color: "var(--bad)",
              padding: "8px 10px",
              borderRadius: 8,
              background: "color-mix(in oklch, var(--bad) 10%, transparent)",
              border: "1px solid color-mix(in oklch, var(--bad) 30%, transparent)",
            }}
          >
            {error}
          </div>
        )}

        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: 4,
          }}
        >
          <button
            type="button"
            className="btn ghost"
            onClick={onCancel}
            disabled={busy}
          >
            {tx("Cancel", "إلغاء")}
          </button>
          <button
            type="button"
            className="btn"
            onClick={onConfirm}
            disabled={busy}
            style={{
              background: "var(--bad)",
              color: "white",
              borderColor: "transparent",
            }}
          >
            <IconTrash w={13} />
            {busy ? tx("Deleting…", "جارٍ الحذف…") : tx("Delete", "حذف")}
          </button>
        </div>
      </div>
    </div>
  );
}

function MediaTile({ m, onDelete }: { m: Media; onDelete: () => void }) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);

  const base = API_BASE;
  const tok = tokenStore.get();
  const previewUrl = `${base}/media/${m.id}/file`;

  return (
    <div
      style={{
        border: "1px solid var(--line-soft)",
        borderRadius: 12,
        overflow: "hidden",
        background: "var(--bg-1)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          position: "relative",
          aspectRatio: "1 / 1",
          background: "var(--bg-2)",
          display: "grid",
          placeItems: "center",
        }}
      >
        <AuthorizedImage url={previewUrl} alt={m.fileName} token={tok} />
      </div>
      <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 500,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={m.fileName}
        >
          {m.fileName}
        </div>
        <div
          className="mono"
          style={{
            fontSize: 10,
            color: "var(--ink-3)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>{formatBytes(m.sizeBytes)}</span>
          <button
            type="button"
            className="btn ghost sm"
            onClick={onDelete}
            aria-label={tx("Delete", "حذف")}
            title={tx("Delete", "حذف")}
            style={{ padding: "0 6px", color: "var(--ink-3)" }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--bad)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--ink-3)";
            }}
          >
            <IconTrash w={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * <img> tags don't send Authorization headers. We fetch the binary via
 * fetch() with the bearer token, then render it as a blob URL.
 */
function AuthorizedImage({
  url,
  alt,
  token,
}: {
  url: string;
  alt: string;
  token: string | null;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then((b) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(b);
        setSrc(objectUrl);
      })
      .catch(() => {
        /* leave src null */
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, token]);

  if (!src) {
    return <div className="mono muted" style={{ fontSize: 11 }}>…</div>;
  }
  return (
    <img
      src={src}
      alt={alt}
      style={{
        width: "100%",
        height: "100%",
        objectFit: "cover",
        display: "block",
      }}
    />
  );
}

const Media = memo(MediaImpl);
export default Media;
