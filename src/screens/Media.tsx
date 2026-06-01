import { memo, useEffect, useRef, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { PageHeader } from "@/components/PageHeader";
import { useFetch, useMutation } from "@/api/useFetch";
import { api, tokenStore } from "@/api/client";
import { IconPlus, IconMore } from "@/icons";
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

  const onDelete = async (m: Media) => {
    if (
      !window.confirm(
        tx(
          `Delete ${m.fileName}? This cannot be undone.`,
          `حذف ${m.fileName}؟ لا يمكن التراجع.`,
        ),
      )
    ) {
      return;
    }
    await deleteMut.mutate({ id: m.id });
    listQ.refetch();
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
            <MediaTile key={m.id} m={m} onDelete={() => onDelete(m)} />
          ))}
        </div>
      </div>
    </div>
  );
}

function MediaTile({ m, onDelete }: { m: Media; onDelete: () => void }) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);

  const base =
    (import.meta.env.VITE_API_URL as string | undefined) ??
    "http://localhost:3001/api";
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
            style={{ padding: "0 4px", color: "var(--ink-3)" }}
            aria-label={tx("Delete", "حذف")}
            title={tx("Delete", "حذف")}
          >
            <IconMore w={11} />
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
