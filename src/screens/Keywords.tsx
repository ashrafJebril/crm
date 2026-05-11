import { memo, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/Badge";
import { IconPlus } from "@/icons";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import type { Keyword, KeywordKind } from "@/lib/types";

const KIND_OPTIONS: KeywordKind[] = ["brand", "hashtag", "handle", "competitor"];

function KeywordsImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);

  const listQ = useFetch<Keyword[]>("/keywords");
  const [draft, setDraft] = useState<{ value: string; kind: KeywordKind }>({ value: "", kind: "brand" });

  const createKw = useMutation<{ value: string; kind: KeywordKind }, Keyword>((input) =>
    api.post("/keywords", input),
  );
  const deleteKw = useMutation<{ id: string }, { ok: true }>((input) =>
    api.delete(`/keywords/${input.id}`),
  );

  const submit = async () => {
    const value = draft.value.trim();
    if (!value) return;
    await createKw.mutate({ value, kind: draft.kind });
    setDraft({ value: "", kind: draft.kind });
    listQ.refetch();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, padding: 24 }}>
      <PageHeader
        title={tx("Tracked keywords", "الكلمات المتابَعة")}
        subtitle={tx(
          "Words, hashtags, handles and competitor names that the listener watches for.",
          "كلمات وعلامات وأسماء حسابات ومنافسين يراقبها النظام.",
        )}
      />

      <div style={{ display: "flex", gap: 8, padding: "12px 0" }}>
        <input
          value={draft.value}
          onChange={(e) => setDraft({ ...draft, value: e.target.value })}
          placeholder={tx("e.g. samemha or #صممها", "مثلاً samemha أو #صممها")}
          className="input"
          style={{ flex: 1, padding: "8px 12px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg)" }}
        />
        <select
          value={draft.kind}
          onChange={(e) => setDraft({ ...draft, kind: e.target.value as KeywordKind })}
          className="input"
          style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg)" }}
        >
          {KIND_OPTIONS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <button className="btn primary" type="button" disabled={createKw.loading} onClick={submit}>
          <IconPlus w={13} />
          {tx("Add", "إضافة")}
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
        {(listQ.data ?? []).map((k) => (
          <div
            key={k.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              border: "1px solid var(--line-soft)",
              borderRadius: 8,
              padding: "8px 12px",
            }}
          >
            <span style={{ fontWeight: 600 }}>{k.value}</span>
            <Badge kind="ai">{k.kind}</Badge>
            {!k.enabled && <Badge kind="ai">disabled</Badge>}
            <button
              type="button"
              className="btn ghost sm"
              style={{ marginInlineStart: "auto" }}
              disabled={deleteKw.loading}
              onClick={async () => {
                await deleteKw.mutate({ id: k.id });
                listQ.refetch();
              }}
            >
              {tx("Remove", "حذف")}
            </button>
          </div>
        ))}
        {(listQ.data ?? []).length === 0 && !listQ.loading && (
          <div className="mono muted" style={{ fontSize: 12 }}>
            {tx("No keywords yet — add your brand to start listening.", "لا توجد كلمات بعد — أضف اسم علامتك للبدء.")}
          </div>
        )}
      </div>
    </div>
  );
}

const Keywords = memo(KeywordsImpl);
export default Keywords;
