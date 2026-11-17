import { useState } from "react";
import { useFetch } from "@/api/useFetch";
import { usePermissions } from "@/auth/usePermissions";
import type { OnboardingState } from "@/lib/types";
import type { Tx } from "@/lib/tx";
import { ONBOARDING_PATH, patchOnboarding } from "@/screens/agent/agentApi";
import { agentErrorText } from "@/screens/agent/agentErrors";
import { showContinueCard } from "@/screens/agent/onboardingSteps";
import { ErrorRow } from "@/screens/settings/form";

/**
 * SP-20: "Continue setup" (a skipped onboarding) on the dashboard and the
 * agent page. With `offerStart` (the agent page only, ruling 10) it also
 * offers "Set up your agent" to a workspace that never started onboarding;
 * nothing ever starts it by itself.
 */
export function ContinueSetupCard({ tx, offerStart = false }: { tx: Tx; offerStart?: boolean }) {
  const { can } = usePermissions();
  const allowed = can("settings.update");
  const q = useFetch<OnboardingState>(allowed ? ONBOARDING_PATH : null);
  const [error, setError] = useState<string | null>(null);
  const s = q.data;
  const continueIt = showContinueCard(s);
  const startIt = offerStart && !!s && s.canManage && s.status === "not_started";
  if (!allowed || (!continueIt && !startIt)) return null;

  async function start() {
    setError(null);
    try {
      await patchOnboarding({ action: "start" });
      window.location.hash = "#/setup";
    } catch (e) {
      setError(agentErrorText(e, tx));
    }
  }

  return (
    <div style={{ border: "1px solid var(--line-soft)", borderRadius: 12, padding: 14, marginBottom: 16, background: "var(--bg-1)", maxWidth: 760 }}>
      <div style={{ fontWeight: 600, fontSize: 14 }}>{continueIt ? tx("Finish setting up your agent", "أكمل إعداد وكيلك") : tx("Set up your agent", "إعداد وكيلك")}</div>
      <div className="muted" style={{ fontSize: 13, margin: "4px 0 10px" }}>
        {tx(
          "A few guided steps: your business, your website, what the agent learned, and a test chat.",
          "بضع خطوات موجّهة: نشاطك وموقعك وما تعلّمه الوكيل ومحادثة تجريبية.",
        )}
      </div>
      {continueIt ? (
        <a className="btn primary" href="#/setup">
          {tx("Continue setup", "أكمل الإعداد")}
        </a>
      ) : (
        <button type="button" className="btn primary" onClick={() => void start()}>
          {tx("Set up your agent", "إعداد وكيلك")}
        </button>
      )}
      <ErrorRow message={error} />
    </div>
  );
}
