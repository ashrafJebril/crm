import { memo, useEffect, useState } from "react";
import { navigateIfAllowed } from "@/lib/leaveGuard";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { useAuth } from "@/auth/context";
import { usePermissions } from "@/auth/usePermissions";
import { PageHeader } from "@/components/PageHeader";
import { WorkspaceTab } from "./settings/WorkspaceTab";
import { MembersTab } from "./settings/MembersTab";
import { IntegrationsTab } from "./settings/IntegrationsTab";
import { AiKnowledgeTab } from "./settings/AiKnowledgeTab";
import { ProfileTab } from "./settings/ProfileTab";
import { PipelinesTab } from "./settings/PipelinesTab";
import { SavedRepliesTab } from "./settings/SavedRepliesTab";
import { ModulesTab } from "./settings/ModulesTab";
import { LifecycleTab } from "./settings/LifecycleTab";
import { DevelopersTab } from "./settings/developers/DevelopersTab";

type Tab = "workspace" | "modules" | "members" | "integrations" | "aiKnowledge" | "pipelines" | "automaticMessages" | "savedReplies" | "developers" | "profile";

const TAB_IDS: readonly Tab[] = ["workspace", "modules", "members", "integrations", "aiKnowledge", "pipelines", "automaticMessages", "savedReplies", "developers", "profile"];

/**
 * The active tab lives IN THE URL (`#/settings?tab=aiKnowledge`), not in
 * transient state: a refresh, a shared link, or a back-navigation should land
 * on the tab the user was actually looking at, not silently reset to the
 * first one. The router already strips the query part when matching the
 * route (see router.tsx parseHash), so this piggybacks on the same hash.
 */
const parseTab = (): Tab => {
  const query = window.location.hash.split("?")[1] ?? "";
  const tab = new URLSearchParams(query).get("tab");
  return TAB_IDS.includes(tab as Tab) ? (tab as Tab) : "workspace";
};

const writeTab = (tab: Tab) => {
  const [route, query] = window.location.hash.split("?");
  // Only the `tab` param is ours. Anything else in the query — the hosted
  // OAuth flows send customers back to `#/settings?zernio=connected&…` — must
  // survive a tab click, or switching tabs mid-redirect eats the result.
  const params = new URLSearchParams(query ?? "");
  if (tab === "workspace") params.delete("tab");
  else params.set("tab", tab);
  const qs = params.toString();
  const next = qs ? `${route}?${qs}` : route;
  if (window.location.hash !== next) window.location.hash = next;
};

function SettingsImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { activeWorkspace } = useAuth();
  const { can } = usePermissions();

  const [tab, setTabState] = useState<Tab>(parseTab);

  // Follow the URL, not just drive it: back/forward and hand-edited links
  // must move the tab too, or the URL and the screen silently disagree.
  useEffect(() => {
    const onHash = () => setTabState(parseTab());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // SP-29: ask the leave guard (unsaved general settings) before the tab unmounts.
  const setTab = (next: Tab) => {
    if (next === tab) return;
    navigateIfAllowed(() => {
      writeTab(next);
      setTabState(next);
    });
  };

  const tabs: Array<{ id: Tab; label: string; ar: string }> = [
    { id: "workspace", label: "Workspace", ar: "مساحة العمل" },
    // SP-11: one place listing every module the member can configure.
    { id: "modules", label: "Modules", ar: "الوحدات" },
    { id: "members", label: "Members", ar: "الأعضاء" },
    { id: "integrations", label: "Integrations", ar: "التكاملات" },
    { id: "aiKnowledge", label: "AI Knowledge", ar: "معرفة الذكاء" },
    ...(can("pipelines.view") ? [{ id: "pipelines" as const, label: "Pipelines", ar: "المسارات" }] : []),
    // SP-24: lifecycle messages (GET /lifecycle needs workflows.view).
    ...(can("workflows.view") ? [{ id: "automaticMessages" as const, label: "Automatic messages", ar: "الرسائل التلقائية" }] : []),
    ...(can("conversations.manage") ? [{ id: "savedReplies" as const, label: "Saved replies", ar: "الردود المحفوظة" }] : []),
    // SP-27: API keys and webhooks (api_keys is hidden from viewers).
    ...(can("api_keys.view") ? [{ id: "developers" as const, label: "Developers", ar: "المطورون" }] : []),
    { id: "profile", label: "Profile", ar: "حسابي" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <PageHeader
        title={tx("Settings", "الإعدادات")}
        subtitle={
          activeWorkspace
            ? tx(
                `Manage ${activeWorkspace.name}, your team, integrations, and your account.`,
                `إدارة ${activeWorkspace.name} والفريق والتكاملات وحسابك.`,
              )
            : tx("Manage your workspace, team, and account.", "إدارة المساحة والفريق والحساب.")
        }
      />

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
        <div style={{ maxWidth: tab === "pipelines" || tab === "automaticMessages" ? 860 : 720, margin: "0 auto" }}>
          {tab === "workspace" && <WorkspaceTab />}
          {tab === "modules" && <ModulesTab />}
          {tab === "members" && <MembersTab />}
          {tab === "integrations" && <IntegrationsTab />}
          {tab === "aiKnowledge" && <AiKnowledgeTab />}
          {tab === "pipelines" && <PipelinesTab />}
          {tab === "automaticMessages" && can("workflows.view") && <LifecycleTab />}
          {tab === "savedReplies" && <SavedRepliesTab />}
          {tab === "developers" && can("api_keys.view") && <DevelopersTab />}
          {tab === "profile" && <ProfileTab />}
        </div>
      </div>
    </div>
  );
}

const Settings = memo(SettingsImpl);
export default Settings;
