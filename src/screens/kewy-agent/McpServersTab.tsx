import { useState } from "react";
import type { Tx } from "@/lib/tx";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import { SettingsCard, Field, ErrorRow, inputStyle } from "@/screens/settings/form";
import { Modal } from "@/components/Modal";
import { Toggle } from "@/components/Toggle";
import { Badge } from "@/components/Badge";
import { IconPlus, IconGlobe } from "@/icons";

interface LMcpServer {
  id: string;
  name: string;
  description: string;
  url: string;
  enabled: boolean;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

interface LMcpServerList {
  connected: boolean;
  servers: LMcpServer[];
}

interface LMcpTestResult {
  ok: boolean;
  tools: string[];
  error: string | null;
}

interface CreateServerInput {
  name: string;
  description: string;
  url: string;
}

export function McpServersTab({ tx, canEdit }: { tx: Tx; canEdit: boolean }) {
  const listQ = useFetch<LMcpServerList>("/integrations/l/mcp-servers");
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bound, setBound] = useState<Set<string>>(new Set());
  const [testResults, setTestResults] = useState<Record<string, LMcpTestResult>>({});

  const createMut = useMutation<CreateServerInput, LMcpServer>((input) =>
    api.post("/integrations/l/mcp-servers", input),
  );
  const deleteMut = useMutation<{ id: string }, { ok: true }>(({ id }) =>
    api.delete(`/integrations/l/mcp-servers/${id}`),
  );
  const bindMut = useMutation<{ id: string; on: boolean }, { ok: true }>(({ id, on }) =>
    on
      ? api.post(`/integrations/l/mcp-servers/${id}/binding`)
      : api.delete(`/integrations/l/mcp-servers/${id}/binding`),
  );
  const testMut = useMutation<{ id: string }, LMcpTestResult>(({ id }) =>
    api.post(`/integrations/l/mcp-servers/${id}/test`),
  );

  const servers = listQ.data?.servers ?? [];

  const [form, setForm] = useState<CreateServerInput>({ name: "", description: "", url: "" });

  async function onCreate() {
    setError(null);
    try {
      await createMut.mutate(form);
      setForm({ name: "", description: "", url: "" });
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

  async function onTest(id: string) {
    setError(null);
    try {
      const result = await testMut.mutate({ id });
      setTestResults({ ...testResults, [id]: result });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <SettingsCard
      title={tx("MCP servers", "خوادم MCP")}
      description={tx(
        "Remote MCP servers your agent can use for extra tools.",
        "خوادم MCP عن بُعد يمكن لوكيلك استخدامها لأدوات إضافية.",
      )}
      footer={
        canEdit && (
          <button type="button" className="btn primary" onClick={() => setShowAdd(true)}>
            <IconPlus w={13} />
            {tx("Add server", "إضافة خادم")}
          </button>
        )
      }
    >
      <ErrorRow message={error} />
      {servers.length === 0 && (
        <div className="muted" style={{ textAlign: "center", padding: 24 }}>
          {tx("No MCP servers yet.", "لا توجد خوادم MCP بعد.")}
        </div>
      )}
      {servers.map((server) => {
        const result = testResults[server.id];
        return (
          <div
            key={server.id}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              padding: 14,
              borderBottom: "1px solid var(--line-soft)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
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
                <IconGlobe w={16} />
              </div>
              <div style={{ flex: 1 }}>
                <div className="mono" style={{ fontSize: 13, fontWeight: 500 }}>{server.name}</div>
                <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{server.description}</div>
              </div>
              {canEdit && (
                <>
                  <button type="button" className="btn ghost sm" onClick={() => onTest(server.id)}>
                    {tx("Test", "اختبار")}
                  </button>
                  <Toggle on={bound.has(server.id)} onChange={(on) => onToggle(server.id, on)} />
                  <button type="button" className="btn ghost sm" onClick={() => onDelete(server.id)}>
                    {tx("Delete", "حذف")}
                  </button>
                </>
              )}
            </div>
            {result && (
              <div style={{ paddingInlineStart: 46 }}>
                {result.ok ? (
                  <Badge kind="ok" dot>
                    {tx(`Connected · tools: ${result.tools.join(", ") || "none"}`, `متصل · الأدوات: ${result.tools.join(", ") || "لا شيء"}`)}
                  </Badge>
                ) : (
                  <Badge kind="bad" dot>{result.error ?? tx("Failed", "فشل")}</Badge>
                )}
              </div>
            )}
          </div>
        );
      })}

      {showAdd && (
        <Modal onClose={() => setShowAdd(false)} label={tx("Add MCP server", "إضافة خادم MCP")}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field label={tx("Name", "الاسم")} hint={tx("Lowercase, e.g. docs", "أحرف صغيرة")}>
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
            <Field label={tx("URL", "الرابط")} hint="https://mcp.example.com/mcp">
              <input
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
              />
            </Field>
            <button
              type="button"
              className="btn primary"
              onClick={onCreate}
              disabled={!form.name || !form.description || !form.url}
            >
              {tx("Create", "إنشاء")}
            </button>
          </div>
        </Modal>
      )}
    </SettingsCard>
  );
}
