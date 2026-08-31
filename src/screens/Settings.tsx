import { memo, useState } from "react";
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

function SettingsImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { activeWorkspace } = useAuth();

  const [tab, setTab] = useState<Tab>("workspace");

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
