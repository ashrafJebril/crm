import { memo } from "react";
import { useHashParam } from "@/lib/useHashParam";
import { availableAgentTabs, pickAgentTab, type AgentTab } from "./agent/agentTabs";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { usePermissions } from "@/auth/usePermissions";
import { useFetch } from "@/api/useFetch";
import { PageHeader } from "@/components/PageHeader";
import { KnowledgePage } from "./knowledge/KnowledgePage";
import { ToolsTab } from "./kewy-agent/ToolsTab";
import { McpServersTab } from "./kewy-agent/McpServersTab";
import { AgentSettingsTab } from "./agent/AgentSettingsTab";
import { TryAgentPanel } from "./agent/TryAgentPanel";
import { ContinueSetupCard } from "./setup/ContinueSetupCard";
import { SkillsTab } from "./kewy-agent/skills/SkillsTab";

// SP-20 adds the agent's settings and the "Try your agent" preview.
// SP-22 adds the skills gallery (agent.view; actions gate themselves).
type Tab = AgentTab;

interface LStatus {
  connected: boolean;
}

function KewyAgentImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { can, loading } = usePermissions();
  const canEditTools = can("agent.update");
  const canEditMcp = can("connectors.update");
  // SP-21: the knowledge (content, FAQs, guidelines, files, websites and the
  // SP-17 photos) lives in the CRM, so it no longer needs an l link.
  const canViewKnowledge = can("knowledge.view");
  // SP-20: settings for agent.view; the sandbox (a turn costs money, ruling 9) for agent.update.
  const canViewSettings = can("agent.view");
  const canTry = can("agent.update");
  // The tab is chosen only once permissions are known (else a cold load opens on Tools),
  // honouring `#/agent?tab=…` when the member can open it. Clicking a tab updates the hash.
  const [hashTab, setHashTab] = useHashParam("tab");
  const tab = pickAgentTab({ loading, available: availableAgentTabs(can), requested: hashTab });
  const setTab = (id: Tab) => setHashTab(id);

  const statusQ = useFetch<LStatus>("/integrations/l/status");
  const connected = statusQ.data?.connected === true;

  const tabs: Array<{ id: Tab; label: string; ar: string }> = [
    ...(canViewSettings ? [{ id: "settings" as const, label: "Settings", ar: "الإعدادات" }] : []),
    ...(canTry ? [{ id: "try" as const, label: "Try your agent", ar: "جرّب وكيلك" }] : []),
    ...(canViewSettings ? [{ id: "skills" as const, label: "Skills", ar: "المهارات" }] : []),
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
          "Set up your agent, try it, and manage its knowledge, photos, tools, and MCP connections.",
          "أعدّ وكيلك وجرّبه، وأدِر معرفته وصوره وأدواته واتصالات MCP.",
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
        <ContinueSetupCard tx={tx} offerStart />
        {tab === "settings" && canViewSettings && <AgentSettingsTab tx={tx} lang={t.lang} canEdit={canTry} />}
        {tab === "try" && canTry && <TryAgentPanel tx={tx} canUse={canTry} />}
        {tab === "skills" && canViewSettings && <SkillsTab tx={tx} lang={t.lang} />}
        {tab === "knowledge" && canViewKnowledge && <KnowledgePage tx={tx} lang={t.lang} />}
        {(tab === "tools" || tab === "mcp") && !statusQ.loading && !connected && notConnected}
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
