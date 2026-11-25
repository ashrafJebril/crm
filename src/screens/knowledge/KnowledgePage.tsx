import { useCallback, useState } from "react";
import { useAuth } from "@/auth/context";
import { NO_PERMISSION_AR, NO_PERMISSION_EN, usePermissions } from "@/auth/usePermissions";
import type { Tx } from "@/lib/tx";
import { PhotosTab } from "@/screens/kewy-agent/PhotosTab";
import { ContentEditor } from "./ContentEditor";
import { FaqsEditor } from "./FaqsEditor";
import { FilesPanel } from "./FilesPanel";
import { GuidelinesEditor } from "./GuidelinesEditor";
import { WebsitesPanel } from "./WebsitesPanel";

export type KnowledgeTabId = "content" | "faqs" | "guidelines" | "files" | "websites" | "photos";

export const KNOWLEDGE_TABS: { id: KnowledgeTabId; en: string; ar: string }[] = [
  { id: "content", en: "Business content", ar: "محتوى النشاط" },
  { id: "faqs", en: "FAQs", ar: "الأسئلة الشائعة" },
  { id: "guidelines", en: "Guidelines", ar: "الإرشادات" },
  { id: "files", en: "Files and spreadsheets", ar: "الملفات وجداول البيانات" },
  { id: "websites", en: "Websites", ar: "المواقع الإلكترونية" },
  { id: "photos", en: "Photos", ar: "الصور" },
];

/**
 * SP-21 the Knowledge page (inside the Kewy agent screen): the business's own
 * knowledge, stored in the CRM. Shown whether or not the workspace is linked
 * to an l agent. Viewing needs knowledge.view; adding knowledge.create,
 * editing knowledge.update, deleting knowledge.delete (hidden actions are not
 * rendered). Leaving an editor with unsaved changes asks first.
 */
export function KnowledgePage({ tx, lang }: { tx: Tx; lang: "en" | "ar" }) {
  const { can } = usePermissions();
  const { activeWorkspace } = useAuth();
  const timeZone = activeWorkspace?.timezone ?? undefined;
  const [tab, setTab] = useState<KnowledgeTabId>("content");
  const [dirty, setDirty] = useState(false);
  const onDirtyChange = useCallback((d: boolean) => setDirty(d), []);

  if (!can("knowledge.view")) {
    return (
      <div className="muted" style={{ fontSize: 13 }}>
        {tx(NO_PERMISSION_EN, NO_PERMISSION_AR)}
      </div>
    );
  }

  const canCreate = can("knowledge.create");
  const canEdit = can("knowledge.update");
  const canDelete = can("knowledge.delete");

  function go(next: KnowledgeTabId) {
    if (next === tab) return;
    if (dirty && !window.confirm(tx("You have unsaved changes. Leave without saving?", "لديك تغييرات غير محفوظة. هل تريد المغادرة دون حفظ؟"))) return;
    setDirty(false);
    setTab(next);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div role="tablist" aria-label={tx("Knowledge", "المعرفة")} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {KNOWLEDGE_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`btn sm ${tab === t.id ? "primary" : "ghost"}`}
            onClick={() => go(t.id)}
          >
            {tx(t.en, t.ar)}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === "content" && <ContentEditor tx={tx} canEdit={canEdit} onDirtyChange={onDirtyChange} />}
        {tab === "faqs" && <FaqsEditor tx={tx} canCreate={canCreate} canEdit={canEdit} canDelete={canDelete} />}
        {tab === "guidelines" && <GuidelinesEditor tx={tx} canEdit={canEdit} onDirtyChange={onDirtyChange} />}
        {tab === "files" && <FilesPanel tx={tx} lang={lang} timeZone={timeZone} canCreate={canCreate} canEdit={canEdit} canDelete={canDelete} />}
        {tab === "websites" && <WebsitesPanel tx={tx} lang={lang} timeZone={timeZone} canCreate={canCreate} canEdit={canEdit} canDelete={canDelete} />}
        {tab === "photos" && <PhotosTab tx={tx} canEdit={canEdit} />}
      </div>
    </div>
  );
}
