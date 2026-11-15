import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { API_BASE, ApiError, tokenStore } from "@/api/client";
import { usePermissions } from "@/auth/usePermissions";
import { AuthorizedImage } from "@/components/AuthorizedImage";
import { invalidateMediaLists, updateMedia, useMediaPages } from "@/components/media/mediaApi";
import { AgentBadge, MediaDetailsDialog } from "@/components/media/MediaDetailsDialog";
import { approvalBlock, approvalBlockText, displayTitle } from "@/components/media/mediaDetails";
import { mediaErrorText, mediaLibraryBlocked, mediaNoAccessText } from "@/components/media/mediaErrors";
import { MediaSearchBar, approvedParam, type ApprovalFilter } from "@/components/media/MediaSearchBar";
import { useToast } from "@/components/Toast";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import type { Tx } from "@/lib/tx";
import type { Media } from "@/lib/types";

/** Where the library lives (Templates → Gallery). */
export const GALLERY_HREF = "#/templates?tab=gallery";

const BOX: React.CSSProperties = {
  fontSize: 13,
  padding: "32px 16px",
  textAlign: "center",
  border: "1px dashed var(--line-soft)",
  borderRadius: 12,
};

/**
 * SP-17: the agent's Photos tab. The library's images from `GET /media`
 * (ruling 6, so it needs conversations.view; a 403 shows the shared
 * no-access line), filtered to "Approved for agent" by default. Each tile has
 * the "Agent can send this" switch (knowledge.update), which PATCHes
 * `approvedForAgent`; approving a photo without a title opens the details
 * dialog instead, since the backend requires one.
 */
export function PhotosTab({ tx, canEdit }: { tx: Tx; canEdit: boolean }) {
  const { can } = usePermissions();
  const { toast } = useToast();
  const qc = useQueryClient();
  const canView = can("conversations.view");
  const [query, setQuery] = useState("");
  const [approval, setApproval] = useState<ApprovalFilter>("approved");
  const q = useDebouncedValue(query, 300);
  const pages = useMediaPages("image", canView, { q, approved: approvedParam(approval) });
  const [details, setDetails] = useState<Media | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const token = tokenStore.get();

  const setApproved = async (m: Media, on: boolean) => {
    if (on && !m.title?.trim()) {
      // Approving needs a title: let the user name it first.
      toast(tx("Add a title to approve this photo.", "أضف عنوانًا لاعتماد هذه الصورة."), "info");
      setDetails(m);
      return;
    }
    setBusy(m.id);
    try {
      await updateMedia(m.id, { approvedForAgent: on });
      await invalidateMediaLists(qc);
      toast(
        on ? tx("The agent can send this photo", "يمكن للوكيل إرسال هذه الصورة") : tx("Hidden from the agent", "أُخفيت عن الوكيل"),
        "success",
      );
    } catch (e) {
      toast(mediaErrorText(e, tx), "error");
      if (e instanceof ApiError && e.message === "media.title_required") setDetails(m);
    } finally {
      setBusy(null);
    }
  };

  if (mediaLibraryBlocked(canView, pages.error)) {
    return (
      <div role="status" className="muted" style={BOX}>
        {mediaNoAccessText(tx)}
      </div>
    );
  }

  const filtered = q.trim() !== "" || approval !== "approved";

  return (
    <div style={{ display: "grid", gap: 14, alignContent: "start" }}>
      <div style={{ fontSize: 12.5, color: "var(--ink-2)", maxWidth: 640 }}>
        {tx(
          "Photos approved here can be sent by your agent to customers. The agent finds them by title, alt text, tags and the “use when” note. Only JPG or PNG staff uploads up to 5 MB can be approved.",
          "يمكن لوكيلك إرسال الصور المعتمدة هنا إلى العملاء. يجد الوكيل الصور من خلال العنوان والنص البديل والوسوم وملاحظة «متى تُستخدم». يمكن اعتماد صور JPG أو PNG التي رفعها الفريق فقط، حتى 5 ميغابايت.",
        )}
      </div>
      <MediaSearchBar tx={tx} query={query} onQuery={setQuery} approval={approval} onApproval={setApproval} />

      {pages.error && (
        <div role="alert" style={{ fontSize: 12.5, color: "var(--bad)" }}>
          {mediaErrorText(pages.error, tx)}
        </div>
      )}

      {pages.loading && pages.items.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>
          {tx("loading…", "جارٍ التحميل…")}
        </div>
      ) : pages.items.length === 0 && !pages.hasMore ? (
        <div className="muted" style={BOX}>
          {filtered ? (
            tx("No photos match this search.", "لا توجد صور تطابق هذا البحث.")
          ) : (
            <>
              {tx(
                "No approved photos yet. Approve photos so your agent can send them to customers.",
                "لا توجد صور معتمدة بعد. اعتمد الصور ليتمكن وكيلك من إرسالها إلى العملاء.",
              )}{" "}
              <a href={GALLERY_HREF}>{tx("Open the Gallery", "افتح المعرض")}</a>
            </>
          )}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 12 }}>
          {pages.items.map((m) => {
            const block = approvalBlock(m);
            const switchDisabled = !canEdit || busy === m.id || (block !== null && !m.approvedForAgent);
            return (
              <div key={m.id} className="card" style={{ padding: 10, display: "grid", gap: 8, alignContent: "start" }}>
                <div style={{ height: 120, borderRadius: 8, overflow: "hidden", background: "var(--bg-2)", display: "grid", placeItems: "center" }}>
                  <AuthorizedImage url={`${API_BASE}/media/${m.id}/file`} alt={m.alt ?? m.fileName} token={token} retryable={false} />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                  <div
                    dir="auto"
                    title={m.fileName}
                    style={{ fontSize: 12, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}
                  >
                    {displayTitle(m)}
                  </div>
                  {m.approvedForAgent && <AgentBadge tx={tx} />}
                </div>
                {m.useWhen && (
                  <div dir="auto" style={{ fontSize: 11, color: "var(--ink-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={m.useWhen}>
                    {m.useWhen}
                  </div>
                )}
                {canEdit && (
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5 }}>
                    <input
                      type="checkbox"
                      role="switch"
                      checked={m.approvedForAgent}
                      disabled={switchDisabled}
                      onChange={(e) => void setApproved(m, e.target.checked)}
                    />
                    {tx("Agent can send this", "يمكن للوكيل إرسال هذا")}
                  </label>
                )}
                {canEdit && block && !m.approvedForAgent && (
                  <span style={{ fontSize: 11, color: "var(--ink-3)" }}>{approvalBlockText(block, tx)}</span>
                )}
                <div>
                  <button type="button" className="btn ghost sm" onClick={() => setDetails(m)}>
                    {tx("Details", "التفاصيل")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {pages.hasMore && (
        <div>
          <button type="button" className="btn" disabled={pages.loadingMore} onClick={pages.loadMore}>
            {pages.loadingMore ? tx("Loading…", "جارٍ التحميل…") : tx("Load more", "تحميل المزيد")}
          </button>
        </div>
      )}

      {details && <MediaDetailsDialog media={details} tx={tx} canEdit={canEdit} onClose={() => setDetails(null)} />}
    </div>
  );
}
