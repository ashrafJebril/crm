import { useState } from "react";
import type { Tx } from "@/lib/tx";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import { SettingsCard, Field, ErrorRow, inputStyle } from "@/screens/settings/form";
import { Modal } from "@/components/Modal";
import { Toggle } from "@/components/Toggle";
import { IconPlus, IconBolt } from "@/icons";
import { parseToolJson, type JsonField } from "./toolJson";

interface LTool {
  id: string;
  name: string;
  description: string;
  method: string;
  url_template: string;
  enabled: boolean;
  created_at: string;
  params: string[];
}

interface LToolList {
  connected: boolean;
  tools: LTool[];
}

interface CreateToolInput {
  name: string;
  description: string;
  method: string;
  url_template: string;
  headers?: Record<string, string>;
  body_template?: Record<string, unknown>;
  param_descriptions?: Record<string, string>;
}

const EMPTY_JSON: Record<JsonField, string> = { headers: "", body_template: "", param_descriptions: "" };

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export function ToolsTab({ tx, canEdit }: { tx: Tx; canEdit: boolean }) {
  const listQ = useFetch<LToolList>("/integrations/l/tools");
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bound, setBound] = useState<Set<string>>(new Set());

  const createMut = useMutation<CreateToolInput, LTool>((input) => api.post("/integrations/l/tools", input));
  const deleteMut = useMutation<{ id: string }, { ok: true }>(({ id }) => api.delete(`/integrations/l/tools/${id}`));
  const bindMut = useMutation<{ id: string; on: boolean }, { ok: true }>(({ id, on }) =>
    on ? api.post(`/integrations/l/tools/${id}/binding`) : api.delete(`/integrations/l/tools/${id}/binding`),
  );

  const tools = listQ.data?.tools ?? [];

  const [form, setForm] = useState<CreateToolInput>({
    name: "",
    description: "",
    method: "GET",
    url_template: "",
  });

  // Optional JSON boxes, kept as typed until Create.
  const [json, setJson] = useState<Record<JsonField, string>>(EMPTY_JSON);

  async function onCreate() {
    setError(null);
    const parsed = parseToolJson(json);
    if (!parsed.ok) {
      setError(
        {
          headers: tx("Headers must be a JSON object of text values.", "الترويسات لازم تكون كائن JSON قيمه نصوص."),
          body_template: tx("Body template must be a JSON object.", "قالب الطلب لازم يكون كائن JSON."),
          param_descriptions: tx(
            "Parameter descriptions must be a JSON object of text values.",
            "وصف المعاملات لازم يكون كائن JSON قيمه نصوص.",
          ),
        }[parsed.field],
      );
      return;
    }
    const { ok: _ok, ...extra } = parsed;
    try {
      await createMut.mutate({ ...form, ...extra });
      setForm({ name: "", description: "", method: "GET", url_template: "" });
      setJson(EMPTY_JSON);
      setShowAdd(false);
      listQ.refetch();
    } catch (err) {
      setError((err as Error).message);
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

  async function onToggle(id: string, on: boolean) {
    setError(null);
    const next = new Set(bound);
    if (on) next.add(id);
    else next.delete(id);
    setBound(next);
    try {
      await bindMut.mutate({ id, on });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <SettingsCard
      title={tx("Tools", "الأدوات")}
      description={tx(
        "HTTP tools your agent can call while answering.",
        "أدوات HTTP يمكن لوكيلك استدعاؤها أثناء الرد.",
      )}
      footer={
        canEdit && (
          <button type="button" className="btn primary" onClick={() => setShowAdd(true)}>
            <IconPlus w={13} />
            {tx("Add tool", "إضافة أداة")}
          </button>
        )
      }
    >
      <ErrorRow message={listQ.error} />
      <ErrorRow message={error} />
      {tools.length === 0 && (
        <div className="muted" style={{ textAlign: "center", padding: 24 }}>
          {tx("No tools yet.", "لا توجد أدوات بعد.")}
        </div>
      )}
      {tools.map((toolRow) => (
        <div
          key={toolRow.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            padding: 14,
            borderBottom: "1px solid var(--line-soft)",
          }}
        >
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: "var(--bg-2)",
              display: "grid",
              placeItems: "center",
              color: "var(--ink-3)",
            }}
          >
            <IconBolt w={16} />
          </div>
          <div style={{ flex: 1 }}>
            <div className="mono" style={{ fontSize: 13, fontWeight: 500 }}>
              {toolRow.name}({toolRow.params.join(", ")})
            </div>
            <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{toolRow.description}</div>
          </div>
          {canEdit && (
            <>
              <Toggle on={bound.has(toolRow.id)} onChange={(on) => onToggle(toolRow.id, on)} />
              <button type="button" className="btn ghost sm" onClick={() => onDelete(toolRow.id)}>
                {tx("Delete", "حذف")}
              </button>
            </>
          )}
        </div>
      ))}

      {showAdd && (
        <Modal onClose={() => setShowAdd(false)} label={tx("Add tool", "إضافة أداة")}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field label={tx("Name", "الاسم")} hint={tx("Lowercase, e.g. search_listings", "أحرف صغيرة")}>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                style={inputStyle}
              />
            </Field>
            <Field label={tx("Description", "الوصف")}>
              <input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                style={inputStyle}
              />
            </Field>
            <Field label={tx("Method", "الطريقة")}>
              <select
                value={form.method}
                onChange={(e) => setForm({ ...form, method: e.target.value })}
                style={inputStyle}
              >
                {METHODS.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </Field>
            <Field label={tx("URL template", "قالب الرابط")} hint="https://api.example.com/weather/{city}">
              <input
                value={form.url_template}
                onChange={(e) => setForm({ ...form, url_template: e.target.value })}
                style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
              />
            </Field>
            <Field
              label={tx("Headers (optional)", "الترويسات (اختياري)")}
              hint={tx("JSON. Sent with every call; not shown again after saving.", "JSON. بتنبعت مع كل طلب، وما بتنعرض بعد الحفظ.")}
            >
              <textarea
                value={json.headers}
                onChange={(e) => setJson({ ...json, headers: e.target.value })}
                placeholder='{"x-api-key": "…"}'
                rows={2}
                spellCheck={false}
                autoComplete="off"
                style={{ ...inputStyle, fontFamily: "var(--font-mono)", resize: "vertical" }}
              />
            </Field>
            <Field
              label={tx("Body template (optional)", "قالب الطلب (اختياري)")}
              hint={tx("JSON sent as the request body. {name} becomes a parameter, like in the URL.", "JSON بينبعت كجسم الطلب. {name} بيصير معامل، متل الرابط.")}
            >
              <textarea
                value={json.body_template}
                onChange={(e) => setJson({ ...json, body_template: e.target.value })}
                placeholder='{"city": "{city}"}'
                rows={4}
                spellCheck={false}
                style={{ ...inputStyle, fontFamily: "var(--font-mono)", resize: "vertical" }}
              />
            </Field>
            <Field
              label={tx("Parameter descriptions (optional)", "وصف المعاملات (اختياري)")}
              hint={tx("JSON: what the agent should put in each parameter.", "JSON: شو لازم يحط الوكيل بكل معامل.")}
            >
              <textarea
                value={json.param_descriptions}
                onChange={(e) => setJson({ ...json, param_descriptions: e.target.value })}
                placeholder='{"city": "City name in English"}'
                rows={3}
                spellCheck={false}
                style={{ ...inputStyle, fontFamily: "var(--font-mono)", resize: "vertical" }}
              />
            </Field>
            <ErrorRow message={error} />
            <button
              type="button"
              className="btn primary"
              onClick={onCreate}
              disabled={!form.name || !form.description || !form.url_template}
            >
              {tx("Create", "إنشاء")}
            </button>
          </div>
        </Modal>
      )}
    </SettingsCard>
  );
}
