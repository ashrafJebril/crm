import { useState } from "react";
import { NewTicketModal } from "@/screens/pipeline/NewTicketModal";
import type { Lang } from "@/lib/types";

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
  const defaultTitle = intent ? `${contactName} — ${intent}` : contactName;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          padding: "4px 10px",
          background: "var(--accent)",
          color: "white",
          border: 0,
          borderRadius: "var(--r)",
          fontSize: 11,
          cursor: "pointer",
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
