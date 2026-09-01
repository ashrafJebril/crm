import { memo, useEffect, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { useAuth } from "@/auth/context";
import { PageHeader } from "@/components/PageHeader";
import { WorkspaceTab } from "./settings/WorkspaceTab";
import { MembersTab } from "./settings/MembersTab";
import { IntegrationsTab } from "./settings/IntegrationsTab";
import { AiKnowledgeTab } from "./settings/AiKnowledgeTab";
import { ProfileTab } from "./settings/ProfileTab";

type Tab = "workspace" | "members" | "integrations" | "aiKnowledge" | "profile";

const TAB_IDS: readonly Tab[] = ["workspace", "members", "integrations", "aiKnowledge", "profile"];

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

  const [tab, setTabState] = useState<Tab>(parseTab);

  // Follow the URL, not just drive it: back/forward and hand-edited links
  // must move the tab too, or the URL and the screen silently disagree.
  useEffect(() => {
    const onHash = () => setTabState(parseTab());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const setTab = (next: Tab) => {
    writeTab(next);
    setTabState(next);
  };

  const tabs: Array<{ id: Tab; label: string; ar: string }> = [
    { id: "workspace", label: "Workspace", ar: "مساحة العمل" },
    { id: "members", label: "Members", ar: "الأعضاء" },
    { id: "integrations", label: "Integrations", ar: "التكاملات" },
    { id: "aiKnowledge", label: "AI Knowledge", ar: "معرفة الذكاء" },
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
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          {tab === "workspace" && <WorkspaceTab />}
          {tab === "members" && <MembersTab />}
          {tab === "integrations" && <IntegrationsTab />}
          {tab === "aiKnowledge" && <AiKnowledgeTab />}
          {tab === "profile" && <ProfileTab />}
        </div>
      </div>
    </div>
  );
}

const Settings = memo(SettingsImpl);
export default Settings;
