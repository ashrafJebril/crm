import { useState } from "react";
import { NewTicketModal } from "@/screens/pipeline/NewTicketModal";
import type { Lang } from "@/lib/types";
import { usePermissions, NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";

interface Props {
  conversationId: string;
  contactName: string;
  intent?: string;
  preview?: string;
  lang: Lang;
}

export function AddToPipelineButton({
  conversationId,
  contactName,
  intent,
  preview,
  lang,
}: Props) {
  const [open, setOpen] = useState(false);
  const { can } = usePermissions();
  const canCreate = can("tickets.create");
  const defaultTitle = intent ? `${contactName} — ${intent}` : contactName;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!canCreate}
        title={canCreate ? undefined : lang === "ar" ? NO_PERMISSION_AR : NO_PERMISSION_EN}
        style={{
          opacity: canCreate ? 1 : 0.5,
          cursor: canCreate ? "pointer" : "not-allowed",
          padding: "4px 10px",
          background: "var(--accent)",
          color: "white",
          border: 0,
          borderRadius: "var(--r)",
          fontSize: 11,
          whiteSpace: "nowrap",
        }}
      >
        + {lang === "ar" ? "أضف إلى الأنابيب" : "Add to pipeline"}
      </button>

      {open ? (
        <NewTicketModal
          mode="from-conversation"
          conversationId={conversationId}
          lang={lang}
          defaultTitle={defaultTitle}
          conversationPreview={preview}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
