import { memo, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { usePermissions } from "@/auth/usePermissions";
import { useFetch } from "@/api/useFetch";
import { PageHeader } from "@/components/PageHeader";
import { KnowledgePage } from "./knowledge/KnowledgePage";
import { ToolsTab } from "./kewy-agent/ToolsTab";
import { McpServersTab } from "./kewy-agent/McpServersTab";

type Tab = "knowledge" | "tools" | "mcp";

interface LStatus {
  connected: boolean;
}

function KewyAgentImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { can } = usePermissions();
  const canEditTools = can("agent.update");
  const canEditMcp = can("connectors.update");
  // SP-21: the knowledge (content, FAQs, guidelines, files, websites and the
  // SP-17 photos) lives in the CRM, so it no longer needs an l link.
  const canViewKnowledge = can("knowledge.view");
  const [tab, setTab] = useState<Tab>(canViewKnowledge ? "knowledge" : "tools");

  const statusQ = useFetch<LStatus>("/integrations/l/status");
  const connected = statusQ.data?.connected === true;

  const tabs: Array<{ id: Tab; label: string; ar: string }> = [
    ...(canViewKnowledge ? [{ id: "knowledge" as const, label: "Knowledge", ar: "المعرفة" }] : []),
    { id: "tools", label: "Tools", ar: "الأدوات" },
    { id: "mcp", label: "MCP Servers", ar: "خوادم MCP" },
  ];

  // The "Not connected" card applies only to Tools and MCP.
  const notConnected = (
    <div
      style={{
        background: "var(--bg-1)",
        border: "1px solid var(--line-soft)",
        borderRadius: 12,
        padding: 18,
        maxWidth: 560,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{tx("Not connected to Kewy", "غير متصل بكيوي")}</div>
      <div className="muted" style={{ fontSize: 13 }}>
        {tx(
          "This workspace isn't linked to a Kewy AI agent yet. Connect it from the Kewy control panel to manage its tools and MCP servers here.",
          "لم تُربط مساحة العمل هذه بوكيل كيوي الذكاء بعد. اربطها من لوحة تحكم كيوي لإدارة الأدوات وخوادم MCP هنا.",
        )}
      </div>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <PageHeader
        title={tx("Kewy AI agent", "وكيل كيوي الذكاء")}
        subtitle={tx(
          "Manage your agent's knowledge, photos, tools, and MCP connections.",
          "إدارة معرفة وكيلك وصوره وأدواته واتصالات MCP.",
        )}
      />

      <div className="tabs" role="tablist" aria-label={tx("Kewy AI agent", "وكيل كيوي الذكاء")} style={{ padding: "0 24px" }}>
        {tabs.map((tb) => (
          <button
            key={tb.id}
            type="button"
            role="tab"
            aria-selected={tab === tb.id}
            className={`tab ${tab === tb.id ? "active" : ""}`.trim()}
            onClick={() => setTab(tb.id)}
          >
            <span>{t.lang === "ar" ? tb.ar : tb.label}</span>
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "24px 32px" }}>
        {tab === "knowledge" && canViewKnowledge && <KnowledgePage tx={tx} lang={t.lang} />}
        {tab !== "knowledge" && !statusQ.loading && !connected && notConnected}
        {tab === "tools" && connected && <ToolsTab tx={tx} canEdit={canEditTools} />}
        {tab === "mcp" && connected && (
          <McpServersTab tx={tx} canEdit={canEditMcp} canCreate={can("connectors.create")} canDelete={can("connectors.delete")} />
        )}
      </div>
    </div>
  );
}

const KewyAgent = memo(KewyAgentImpl);
export default KewyAgent;
