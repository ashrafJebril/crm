import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { API_BASE, tokenStore } from "@/api/client";
import { AuthorizedImage } from "@/components/AuthorizedImage";
import { Modal } from "@/components/Modal";
import { useToast } from "@/components/Toast";
import type { Tx } from "@/lib/tx";
import type { Media } from "@/lib/types";
import { invalidateMediaLists, updateMedia } from "./mediaApi";
import {
  MEDIA_DETAIL_LIMITS,
  approvalBlock,
  approvalBlockText,
  defaultTitle,
  detailsDraft,
  detailsPatch,
  parseTagsWithOverflow,
  type MediaDetailsDraft,
} from "./mediaDetails";
import { mediaErrorText } from "./mediaErrors";
import { formatBytes, kindOfMime } from "./mediaKinds";

const INPUT: React.CSSProperties = { width: "100%", boxSizing: "border-box" };
const LABEL: React.CSSProperties = { display: "grid", gap: 4, fontSize: 12.5, color: "var(--ink-2)" };

/** Counter shown under a limited field, e.g. "12/500". */
function Counter({ value, max }: { value: string; max: number }) {
  const n = value.trim().length;
  return (
    <span className="mono" style={{ fontSize: 10.5, color: n > max ? "var(--bad)" : "var(--ink-3)", textAlign: "end" }}>
      <bdi dir="ltr">
        {n}/{max}
      </bdi>
    </span>
  );
}

/**
 * SP-17: one dialog for a library file's agent details (title, alt text,
 * tags, "use when") and the "Agent can send this" switch. Shared by the
 * Gallery, the Media screen and the agent's Photos tab. Saving sends only the
 * changed fields (PATCH /media/:id, knowledge.update). Without `canEdit` it is
 * read-only: inputs disabled and no Save.
 */
export function MediaDetailsDialog({
  media,
  tx,
  canEdit,
  onClose,
  onSaved,
}: {
  media: Media;
  tx: Tx;
  canEdit: boolean;
  onClose: () => void;
  onSaved?: (m: Media) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [draft, setDraft] = useState<MediaDetailsDraft>(() => detailsDraft(media));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const block = approvalBlock(media);
  const kind = kindOfMime(media.mimeType);
  const tags = parseTagsWithOverflow(draft.tagsText);
  const patch = detailsPatch(media, draft);
  const tooLong =
    draft.title.trim().length > MEDIA_DETAIL_LIMITS.title ||
    draft.alt.trim().length > MEDIA_DETAIL_LIMITS.alt ||
    draft.useWhen.trim().length > MEDIA_DETAIL_LIMITS.useWhen;
  // Approving, or clearing the title of an approved file, needs a title (backend media.title_required).
  const needsTitle =
    draft.approvedForAgent && !draft.title.trim() && (patch?.approvedForAgent === true || (patch !== null && "title" in patch));
  // A blocked file can still be switched off, never on.
  const switchDisabled = !canEdit || saving || (block !== null && !draft.approvedForAgent);
  const set = (k: keyof MediaDetailsDraft, v: string | boolean) => setDraft((d) => ({ ...d, [k]: v }));

  const toggle = (on: boolean) =>
    setDraft((d) => ({
      ...d,
      approvedForAgent: on,
      // Approving needs a title: start from the file name.
      title: on && !d.title.trim() ? defaultTitle(media.fileName) : d.title,
    }));

  const save = async () => {
    if (!patch) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await updateMedia(media.id, patch);
      await invalidateMediaLists(qc);
      toast(tx("Details saved", "تم حفظ التفاصيل"), "success");
      onSaved?.(updated);
      onClose();
    } catch (e) {
      setError(mediaErrorText(e, tx, tx("Saving failed. Try again.", "تعذّر الحفظ. حاول مجددًا.")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onClose={saving ? () => {} : onClose} width={520} label={tx("File details", "تفاصيل الملف")}>
      <div dir={tx("ltr", "rtl")} style={{ display: "grid", gap: 12 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>{tx("File details", "تفاصيل الملف")}</h3>

        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <div
            style={{
              width: 88,
              height: 88,
              flex: "none",
              borderRadius: 8,
              overflow: "hidden",
              background: "var(--bg-2)",
              display: "grid",
              placeItems: "center",
              fontSize: 30,
            }}
          >
            {kind === "image" ? (
              <AuthorizedImage
                url={`${API_BASE}/media/${media.id}/file`}
                alt={media.alt ?? media.fileName}
                token={tokenStore.get()}
                retryable={false}
              />
            ) : (
              <span aria-hidden>{kind === "video" ? "🎬" : "📄"}</span>
            )}
          </div>
          <div style={{ minWidth: 0, display: "grid", gap: 2 }}>
            <div style={{ fontSize: 12.5, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              <bdi>{media.fileName}</bdi>
            </div>
            <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
              <bdi dir="ltr">{formatBytes(media.sizeBytes)}</bdi>
            </div>
          </div>
        </div>

        <label style={LABEL}>
          {tx("Title", "العنوان")}
          <input
            className="input"
            dir="auto"
            style={INPUT}
            value={draft.title}
            disabled={!canEdit || saving}
            maxLength={MEDIA_DETAIL_LIMITS.title + 20}
            onChange={(e) => set("title", e.target.value)}
          />
          <Counter value={draft.title} max={MEDIA_DETAIL_LIMITS.title} />
        </label>

        <label style={LABEL}>
          {tx("Alt text", "النص البديل")}
          <input
            className="input"
            dir="auto"
            style={INPUT}
            value={draft.alt}
            disabled={!canEdit || saving}
            placeholder={tx("What the photo shows", "ما تُظهره الصورة")}
            onChange={(e) => set("alt", e.target.value)}
          />
          <Counter value={draft.alt} max={MEDIA_DETAIL_LIMITS.alt} />
        </label>

        <label style={LABEL}>
          {tx("Tags", "الوسوم")}
          <input
            className="input"
            dir="auto"
            style={INPUT}
            value={draft.tagsText}
            disabled={!canEdit || saving}
            placeholder={tx("menu, offers", "قائمة، عروض")}
            onChange={(e) => set("tagsText", e.target.value)}
          />
          <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
            {tx("Separate tags with commas.", "افصل بين الوسوم بفاصلة.")}
          </span>
        </label>
        {tags.tags.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }} aria-label={tx("Tags", "الوسوم")}>
            {tags.tags.map((t) => (
              <span key={t} className="chip" style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: "var(--bg-2)" }}>
                <bdi>{t}</bdi>
              </span>
            ))}
          </div>
        )}
        {tags.overflow && (
          <div role="status" style={{ fontSize: 11.5, color: "var(--warn, var(--bad))" }}>
            {tx(
              `Only the first ${MEDIA_DETAIL_LIMITS.tags} tags are kept.`,
              `يُحتفظ بأول ${MEDIA_DETAIL_LIMITS.tags} وسمًا فقط.`,
            )}
          </div>
        )}

        <label style={LABEL}>
          {tx("Use when", "متى تُستخدم")}
          <textarea
            className="input"
            dir="auto"
            rows={3}
            style={{ ...INPUT, resize: "vertical" }}
            value={draft.useWhen}
            disabled={!canEdit || saving}
            placeholder={tx("Send when a customer asks for the menu", "أرسلها عندما يطلب العميل القائمة")}
            onChange={(e) => set("useWhen", e.target.value)}
          />
          <Counter value={draft.useWhen} max={MEDIA_DETAIL_LIMITS.useWhen} />
        </label>

        <div style={{ display: "grid", gap: 4, paddingBlock: 4, borderBlockStart: "1px solid var(--line-soft)" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, paddingBlockStart: 8 }}>
            <input
              type="checkbox"
              role="switch"
              checked={draft.approvedForAgent}
              disabled={switchDisabled}
              onChange={(e) => toggle(e.target.checked)}
            />
            {tx("Agent can send this", "يمكن للوكيل إرسال هذا")}
          </label>
          {block && (
            <span style={{ fontSize: 11.5, color: "var(--ink-3)", paddingInlineStart: 24 }}>{approvalBlockText(block, tx)}</span>
          )}
          {needsTitle && (
            <span role="alert" style={{ fontSize: 11.5, color: "var(--bad)", paddingInlineStart: 24 }}>
              {tx("Add a title so the agent can find this photo.", "أضف عنوانًا ليتمكن الوكيل من العثور على هذه الصورة.")}
            </span>
          )}
        </div>

        {error && (
          <div role="alert" style={{ fontSize: 12.5, color: "var(--bad)" }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn ghost sm" disabled={saving} onClick={onClose}>
            {canEdit ? tx("Cancel", "إلغاء") : tx("Close", "إغلاق")}
          </button>
          {canEdit && (
            <button
              type="button"
              className="btn primary sm"
              disabled={saving || !patch || tooLong || needsTitle}
              onClick={() => void save()}
            >
              {saving ? tx("Saving…", "جارٍ الحفظ…") : tx("Save", "حفظ")}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** The "Agent" badge on an approved tile. */
export function AgentBadge({ tx }: { tx: Tx }) {
  return (
    <span
      className="chip"
      title={tx("Approved for the AI agent", "معتمدة لوكيل الذكاء الاصطناعي")}
      style={{
        fontSize: 10.5,
        padding: "1px 8px",
        borderRadius: 999,
        background: "var(--accent-soft)",
        color: "var(--accent)",
        border: "1px solid var(--accent-ring)",
        flex: "none",
      }}
    >
      {tx("Agent", "الوكيل")}
    </span>
  );
}
