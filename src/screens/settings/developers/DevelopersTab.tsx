import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { useAuth } from "@/auth/context";
import { usePermissions } from "@/auth/usePermissions";
import { ApiKeysSection } from "./ApiKeysSection";
import { WebhooksSection } from "./WebhooksSection";
import { DEVELOPERS_DOC_HREF } from "./apiModel";

/**
 * SP-27 Settings → Developers (api_keys.view): API keys, webhooks and a link
 * to the static developer docs. Creating keys or webhooks and rotating
 * secrets are hidden while impersonating (the server refuses them too, R10).
 * The workspace MCP token stays where it is (OAuth is deferred).
 */
export function DevelopersTab() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { can } = usePermissions();
  const { impersonating } = useAuth();
  if (!can("api_keys.view")) return null;
  return (
    <div>
      <div style={{ fontSize: 12.5, marginBottom: 14 }}>
        <a href={DEVELOPERS_DOC_HREF} target="_blank" rel="noopener noreferrer">
          {tx("API and webhook documentation", "توثيق الواجهة البرمجية والويب هوكس")}
        </a>
      </div>
      <ApiKeysSection
        tx={tx}
        lang={t.lang}
        canCreate={can("api_keys.create") && !impersonating}
        canDelete={can("api_keys.delete")}
      />
      <WebhooksSection
        tx={tx}
        lang={t.lang}
        caps={{
          canCreate: can("api_keys.create"),
          canUpdate: can("api_keys.update"),
          canDelete: can("api_keys.delete"),
          impersonating,
        }}
      />
    </div>
  );
}
