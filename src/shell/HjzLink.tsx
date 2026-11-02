import { memo, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { useFetch } from "@/api/useFetch";
import { api, ApiError } from "@/api/client";
import { IconArrow } from "@/icons";

/**
 * "Open HJZ" — shown only when the workspace is connected to HJZ. Opens HJZ
 * in a new tab already signed in (single-use ticket from POST /hjz/link).
 */
function HjzLinkImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const status = useFetch<{ connected: boolean; linked: boolean }>("/hjz/link");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!status.data?.connected) return null;

  const notLinked = tx(
    "Your CRM user isn't linked to an HJZ account yet. Open the CRM from HJZ once to link it.",
    "مستخدم CRM غير مرتبط بحساب في HJZ بعد. افتح CRM من HJZ مرة واحدة لربطه.",
  );

  async function open() {
    setError(null);
    // Open the tab inside the click so pop-up blockers allow it, then point it at HJZ.
    const tab = window.open("", "_blank");
    setBusy(true);
    try {
      const { url } = await api.post<{ url: string }>("/hjz/link");
      if (tab) tab.location.href = url;
      else window.location.href = url;
    } catch (e) {
      tab?.close();
      setError(
        e instanceof ApiError && e.code === "HJZ_ACCOUNT_NOT_LINKED"
          ? notLinked
          : tx("Couldn't open HJZ. Try again.", "تعذّر فتح HJZ. حاول مرة أخرى."),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="side-link">
      <button
        className="btn ghost sm side-link-btn"
        onClick={open}
        disabled={busy}
        title={status.data.linked ? tx("Open HJZ without signing in again", "افتح HJZ دون تسجيل الدخول مجدداً") : notLinked}
      >
        <span>{tx("Open HJZ", "فتح HJZ")}</span>
        <IconArrow w={14} />
      </button>
      {error && <div className="side-link-error">{error}</div>}
    </div>
  );
}

export const HjzLink = memo(HjzLinkImpl);
