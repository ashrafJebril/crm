import { memo, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { usePermissions } from "@/auth/usePermissions";
import { useFetch } from "@/api/useFetch";
import { PageHeader } from "@/components/PageHeader";
import { KnowledgeTab } from "./kewy-agent/KnowledgeTab";
import { ToolsTab } from "./kewy-agent/ToolsTab";
import { McpServersTab } from "./kewy-agent/McpServersTab";
import { PhotosTab } from "./kewy-agent/PhotosTab";

type Tab = "knowledge" | "photos" | "tools" | "mcp";

interface LStatus {
  connected: boolean;
}

function KewyAgentImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { can } = usePermissions();
  const canEditKnowledge = can("knowledge.create");
  const canEditTools = can("agent.update");
  const canEditMcp = can("connectors.update");
  // SP-17: the Photos tab is shown with knowledge.view; its switch needs knowledge.update.
  const canViewPhotos = can("knowledge.view");
  const [tab, setTab] = useState<Tab>("knowledge");

  const statusQ = useFetch<LStatus>("/integrations/l/status");
  const connected = statusQ.data?.connected === true;

  const tabs: Array<{ id: Tab; label: string; ar: string }> = [
    { id: "knowledge", label: "Knowledge", ar: "المعرفة" },
    ...(canViewPhotos ? [{ id: "photos" as const, label: "Photos", ar: "الصور" }] : []),
    { id: "tools", label: "Tools", ar: "الأدوات" },
    { id: "mcp", label: "MCP Servers", ar: "خوادم MCP" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <PageHeader
        title={tx("Kewy AI agent", "وكيل كيوي الذكاء")}
        subtitle={tx(
          "Manage your agent's knowledge base, photos, tools, and MCP connections.",
          "إدارة قاعدة معرفة وكيلك وصوره وأدواته واتصالات MCP.",
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
            {tab === "knowledge" && <KnowledgeTab tx={tx} canEdit={canEditKnowledge} canDelete={can("knowledge.delete")} />}
            {tab === "photos" && canViewPhotos && <PhotosTab tx={tx} canEdit={can("knowledge.update")} />}
            {tab === "tools" && <ToolsTab tx={tx} canEdit={canEditTools} />}
            {tab === "mcp" && <McpServersTab tx={tx} canEdit={canEditMcp} canCreate={can("connectors.create")} canDelete={can("connectors.delete")} />}
          </div>
        </>
      )}
    </div>
  );
}

const KewyAgent = memo(KewyAgentImpl);
export default KewyAgent;
