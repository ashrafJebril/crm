import { memo, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { useAuth } from "@/auth/context";
import { useFetch } from "@/api/useFetch";
import { PageHeader } from "@/components/PageHeader";
import { KnowledgeTab } from "./kewy-agent/KnowledgeTab";
import { ToolsTab } from "./kewy-agent/ToolsTab";
import { McpServersTab } from "./kewy-agent/McpServersTab";

type Tab = "knowledge" | "tools" | "mcp";

interface LStatus {
  connected: boolean;
}

function KewyAgentImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { activeWorkspace } = useAuth();
  const canEdit = activeWorkspace?.role === "owner" || activeWorkspace?.role === "admin";
  const [tab, setTab] = useState<Tab>("knowledge");

  const statusQ = useFetch<LStatus>("/integrations/l/status");
  const connected = statusQ.data?.connected === true;

  const tabs: Array<{ id: Tab; label: string; ar: string }> = [
    { id: "knowledge", label: "Knowledge", ar: "المعرفة" },
    { id: "tools", label: "Tools", ar: "الأدوات" },
    { id: "mcp", label: "MCP Servers", ar: "خوادم MCP" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <PageHeader
        title={tx("Kewy AI agent", "وكيل كيوي الذكاء")}
        subtitle={tx(
          "Manage your agent's knowledge base, tools, and MCP connections.",
          "إدارة قاعدة معرفة وكيلك وأدواته واتصالات MCP.",
        )}
      />

      {!statusQ.loading && !connected ? (
        <div style={{ padding: "0 32px" }}>
          <div
            style={{
              background: "var(--bg-1)",
              border: "1px solid var(--line-soft)",
              borderRadius: 12,
              padding: 18,
              maxWidth: 560,
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
              {tx("Not connected to Kewy", "غير متصل بكيوي")}
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              {tx(
                "This workspace isn't linked to a Kewy AI agent yet. Connect it from the Kewy control panel to manage its knowledge base, tools, and MCP servers here.",
                "لم تُربط مساحة العمل هذه بوكيل كيوي الذكاء بعد. اربطها من لوحة تحكم كيوي لإدارة قاعدة المعرفة والأدوات وخوادم MCP هنا.",
              )}
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="tabs" style={{ padding: "0 24px" }}>
            {tabs.map((tb) => (
              <button
                key={tb.id}
                type="button"
                className={`tab ${tab === tb.id ? "active" : ""}`.trim()}
                onClick={() => setTab(tb.id)}
              >
                <span>{t.lang === "ar" ? tb.ar : tb.label}</span>
              </button>
            ))}
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "24px 32px" }}>
            {tab === "knowledge" && <KnowledgeTab tx={tx} canEdit={canEdit} />}
            {tab === "tools" && <ToolsTab tx={tx} canEdit={canEdit} />}
            {tab === "mcp" && <McpServersTab tx={tx} canEdit={canEdit} />}
          </div>
        </>
      )}
    </div>
  );
}

const KewyAgent = memo(KewyAgentImpl);
export default KewyAgent;
