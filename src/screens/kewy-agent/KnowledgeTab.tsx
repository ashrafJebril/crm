import { useRef, useState } from "react";
import type { Tx } from "@/lib/tx";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import { uploadKnowledgeDocument, type LDocument } from "@/api/l-knowledge";
import { Badge } from "@/components/Badge";
import { SettingsCard, ErrorRow } from "@/screens/settings/form";
import { IconBook } from "@/icons";

interface LKnowledgeList {
  connected: boolean;
  documents: LDocument[];
}

export function KnowledgeTab({ tx, canEdit }: { tx: Tx; canEdit: boolean }) {
  const listQ = useFetch<LKnowledgeList>("/integrations/l/knowledge");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const deleteMut = useMutation<{ id: string }, { ok: true }>(({ id }) =>
    api.delete(`/integrations/l/knowledge/${id}`),
  );

  const docs = listQ.data?.documents ?? [];

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploading(true);
    setError(null);
    try {
      await uploadKnowledgeDocument(f);
      listQ.refetch();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  async function onDelete(id: string) {
    setError(null);
    try {
      await deleteMut.mutate({ id });
      listQ.refetch();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <SettingsCard
      title={tx("Knowledge sources", "مصادر المعرفة")}
      description={tx(
        "Documents your agent can retrieve from when answering.",
        "المستندات التي يمكن لوكيلك الرجوع إليها عند الرد.",
      )}
    >
      <ErrorRow message={listQ.error} />
      <ErrorRow message={error} />
      {canEdit && (
        <div>
          <button
            type="button"
            className="btn primary"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            <IconBook w={13} />
            {uploading ? tx("Uploading…", "جارٍ الرفع…") : tx("Upload document", "رفع مستند")}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            hidden
            onChange={onPickFile}
          />
        </div>
      )}
      <table className="tbl">
        <thead>
          <tr>
            <th>{tx("Title", "العنوان")}</th>
            <th>{tx("Status", "الحالة")}</th>
            <th>{tx("Added", "أُضيف")}</th>
            {canEdit && <th style={{ width: 80 }} aria-label="actions" />}
          </tr>
        </thead>
        <tbody>
          {docs.length === 0 && (
            <tr>
              <td colSpan={canEdit ? 4 : 3} className="muted" style={{ textAlign: "center", padding: 24 }}>
                {tx("No documents yet.", "لا توجد مستندات بعد.")}
              </td>
            </tr>
          )}
          {docs.map((d) => (
            <tr key={d.id}>
              <td style={{ fontWeight: 500 }}>{d.title}</td>
              <td>
                {d.status === "ready" && <Badge kind="ok" dot>ready</Badge>}
                {(d.status === "pending" || d.status === "processing") && (
                  <Badge kind="warn" dot>{d.status}</Badge>
                )}
                {d.status === "failed" && <Badge kind="bad" dot>failed</Badge>}
              </td>
              <td className="mono muted">{new Date(d.created_at).toLocaleDateString()}</td>
              {canEdit && (
                <td>
                  <button type="button" className="btn ghost sm" onClick={() => onDelete(d.id)}>
                    {tx("Delete", "حذف")}
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </SettingsCard>
  );
}
