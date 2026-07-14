import { useEffect, useRef, useState } from "react";
import { useFetch } from "@/api/useFetch";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { api, tokenStore } from "@/api/client";
import { IconPlus, IconX } from "@/icons";
import type { Media } from "@/lib/types";

interface Props {
  open: boolean;
  onClose: () => void;
  onPick: (m: Media) => void;
}

/**
 * Modal that lets the user pick an existing media row OR upload a new image
 * (which is then auto-selected). Shares the same /media listing the Media
 * screen uses, so newly-uploaded files appear instantly there too via React
 * Query cache.
 */
export function MediaPicker({ open, onClose, onPick }: Props) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);

  const listQ = useFetch<Media[]>(open ? "/media" : null);
  const items = listQ.data ?? [];

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !uploading) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, uploading, onClose]);

  if (!open) return null;

  const handleFile = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const base =
        (import.meta.env.VITE_API_URL as string | undefined) ??
        "http://localhost:3001/api";
      const token = tokenStore.get();
      const resp = await fetch(`${base}/media/upload`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      if (!resp.ok) {
        let msg = `Upload failed (${resp.status})`;
        try {
          const j = (await resp.json()) as { message?: string };
          if (j.message) msg = j.message;
        } catch {
          /* keep generic */
        }
        throw new Error(msg);
      }
      const created: Media = await resp.json();
      // Auto-pick the freshly uploaded item.
      onPick(created);
      onClose();
      listQ.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const onFileChosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) void handleFile(file);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={uploading ? undefined : onClose}
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
          width: "min(640px, 92vw)",
          maxHeight: "min(620px, 88vh)",
          background: "var(--bg-elev)",
          border: "1px solid var(--line)",
          borderRadius: 14,
          boxShadow: "var(--shadow-lg)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "14px 16px",
            borderBottom: "1px solid var(--line-soft)",
            gap: 12,
          }}
        >
          <h3 style={{ margin: 0, fontSize: 15, flex: 1 }}>
            {tx("Attach an image", "إرفاق صورة")}
          </h3>
          <button
            type="button"
            className="btn sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            <IconPlus w={12} />
            {uploading
              ? tx("Uploading…", "جارٍ الرفع…")
              : tx("Upload new", "رفع جديد")}
          </button>
          <button
            type="button"
            className="btn ghost icon sm"
            onClick={onClose}
            disabled={uploading}
            aria-label={tx("Close", "إغلاق")}
          >
            <IconX w={13} />
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          onChange={onFileChosen}
          style={{ display: "none" }}
        />

        {error && (
          <div
            style={{
              padding: "8px 14px",
              fontSize: 12,
              color: "var(--bad)",
              background: "color-mix(in oklch, var(--bad) 10%, transparent)",
              borderBottom: "1px solid color-mix(in oklch, var(--bad) 30%, transparent)",
            }}
          >
            {error}
          </div>
        )}

        <div style={{ overflowY: "auto", padding: 14 }}>
          {listQ.loading && items.length === 0 ? (
            <div
              className="mono muted pulse"
              style={{ fontSize: 12, padding: 16, textAlign: "center" }}
            >
              {tx("loading…", "جارٍ التحميل…")}
            </div>
          ) : items.length === 0 ? (
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
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))",
                gap: 8,
              }}
            >
              {items.map((m) => (
                <PickerTile
                  key={m.id}
                  m={m}
                  onPick={() => {
                    onPick(m);
                    onClose();
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PickerTile({ m, onPick }: { m: Media; onPick: () => void }) {
  const base =
    (import.meta.env.VITE_API_URL as string | undefined) ??
    "http://localhost:3001/api";
  const token = tokenStore.get();
  const url = `${base}/media/${m.id}/file`;
  return (
    <button
      type="button"
      onClick={onPick}
      title={m.fileName}
      style={{
        position: "relative",
        aspectRatio: "1 / 1",
        background: "var(--bg-2)",
        border: "1px solid var(--line-soft)",
        borderRadius: 10,
        overflow: "hidden",
        cursor: "pointer",
        padding: 0,
        display: "grid",
        placeItems: "center",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--accent)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--line-soft)";
      }}
    >
      <PickerImage url={url} alt={m.fileName} token={token} />
    </button>
  );
}

function PickerImage({
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
    return <span className="mono muted" style={{ fontSize: 10 }}>…</span>;
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

// Avoid unused-import warning for `api` (used elsewhere in module patterns).
void api;
