import { useMemo, useRef, useState, type CSSProperties } from "react";
import { API_BASE, tokenStore } from "@/api/client";
import { AuthorizedImage } from "@/components/AuthorizedImage";
import { LIBRARY_MIMES, formatBytes, kindOfMime } from "@/components/media/mediaKinds";
import { useToast } from "@/components/Toast";
import { NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";
import { loadMedia, MediaFetchError } from "@/lib/mediaFetch";
import type { Tx } from "@/lib/tx";
import {
  useAttachCustomerFile,
  useAttachmentCandidates,
  useTicketAttachments,
  useUnlinkAttachment,
  useUploadTicketFile,
} from "./hooks/useTicketSupport";
import { attachmentCapacity, attachmentFetchUrl, attachmentRows, pendingCandidates, type AttachmentRow } from "./ticketAttachmentModel";
import { ticketErrorText, ticketKeyText } from "./ticketErrors";
import { formatSlaDue } from "./ticketSla";

const ACCEPT = [...LIBRARY_MIMES.image, ...LIBRARY_MIMES.video, ...LIBRARY_MIMES.document].join(",");

const smallBtn: CSSProperties = {
  paddingInline: 10,
  paddingBlock: 4,
  background: "transparent",
  border: "1px solid var(--line)",
  borderRadius: 6,
  color: "var(--ink-2)",
  fontSize: 11.5,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const KIND_TAG: Record<string, string> = { image: "IMG", video: "VID", document: "PDF" };

/** Fetch the streamed, authenticated route and save it under its file name (never a plain link). */
async function downloadAttachment(row: AttachmentRow): Promise<void> {
  const url = attachmentFetchUrl(row.url, API_BASE);
  if (!url) throw new MediaFetchError("Bad attachment URL", 404);
  const blob = await loadMedia(url, tokenStore.get());
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = row.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

/**
 * SP-09 ticket files: customer files linked from the conversation and staff
 * uploads. Upload, link and unlink need tickets.update (hidden otherwise);
 * listing and downloading need tickets.view, which opening the ticket implies.
 */
export function TicketAttachments({
  ticketId,
  tx,
  tz,
  canUpdate,
  hasConversation,
}: {
  ticketId: string;
  tx: Tx;
  tz: string;
  canUpdate: boolean;
  hasConversation: boolean;
}) {
  const { toast } = useToast();
  const list = useTicketAttachments(ticketId);
  const [pickerOpen, setPickerOpen] = useState(false);
  const candidatesQ = useAttachmentCandidates(ticketId, canUpdate && hasConversation && pickerOpen);
  const attach = useAttachCustomerFile(ticketId);
  const upload = useUploadTicketFile(ticketId);
  const unlink = useUnlinkAttachment(ticketId);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyDownload, setBusyDownload] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const token = tokenStore.get();

  const items = useMemo(() => list.data ?? [], [list.data]);
  const rows = useMemo(() => attachmentRows(items, tx), [items, tx]);
  const candidates = useMemo(() => pendingCandidates(candidatesQ.data ?? [], items), [candidatesQ.data, items]);
  const cap = attachmentCapacity(items.length);
  const fullText = ticketKeyText("tickets.attachments_full", {}, tx) ?? "";
  const fail = (e: unknown, fallback: string) => toast(ticketErrorText(e, tx, fallback), "error", e);

  const onDownload = async (row: AttachmentRow) => {
    setBusyDownload(row.id);
    try {
      await downloadAttachment(row);
    } catch (e) {
      const status = e instanceof MediaFetchError ? e.status : 0;
      toast(
        status === 404
          ? ticketKeyText("tickets.attachment_not_found", {}, tx)!
          : status === 403
            ? tx(NO_PERMISSION_EN, NO_PERMISSION_AR)
            : tx("Download failed. Try again.", "فشل التنزيل. حاول مجددًا."),
        "error",
      );
    } finally {
      setBusyDownload(null);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {canUpdate ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              upload.mutate(f, {
                onSuccess: () => toast(tx("File uploaded", "تم رفع الملف"), "success"),
                onError: (err) => fail(err, tx("Upload failed", "فشل الرفع")),
              });
            }}
          />
          <button
            type="button"
            style={smallBtn}
            disabled={upload.isPending || cap.full}
            title={cap.full ? fullText : undefined}
            onClick={() => fileRef.current?.click()}
          >
            {upload.isPending ? tx("Uploading…", "جارٍ الرفع…") : tx("Upload", "رفع ملف")}
          </button>
          {hasConversation ? (
            <button
              type="button"
              style={{ ...smallBtn, color: pickerOpen ? "var(--ink)" : smallBtn.color }}
              aria-expanded={pickerOpen}
              disabled={cap.full && !pickerOpen}
              title={cap.full ? fullText : undefined}
              onClick={() => setPickerOpen((o) => !o)}
            >
              {tx("Files from this conversation", "ملفات من هذه المحادثة")}
            </button>
          ) : null}
        </div>
      ) : null}

      {pickerOpen && canUpdate && hasConversation ? (
        <div
          role="group"
          aria-label={tx("Files from this conversation", "ملفات من هذه المحادثة")}
          style={{ border: "1px dashed var(--line)", borderRadius: 8, padding: 8, display: "flex", flexDirection: "column", gap: 6 }}
        >
          {candidatesQ.isPending ? (
            <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{tx("Loading…", "جارٍ التحميل…")}</div>
          ) : candidatesQ.isError ? (
            <div role="alert" style={{ fontSize: 12, color: "var(--bad, #ef4444)" }}>
              {ticketErrorText(candidatesQ.error, tx, tx("Couldn't load the conversation's files.", "تعذّر تحميل ملفات المحادثة."))}
            </div>
          ) : candidates.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
              {tx("No customer files in this conversation that aren't on the ticket yet.", "لا توجد ملفات من العميل في هذه المحادثة غير مرفقة بالتذكرة.")}
            </div>
          ) : (
            candidates.map((c) => (
              <div key={c.mediaId} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                <span className="mono" style={{ fontSize: 9.5, color: "var(--ink-3)", minWidth: 28 }}>
                  {KIND_TAG[kindOfMime(c.mimeType) ?? ""] ?? "FILE"}
                </span>
                <span dir="auto" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--ink)" }}>
                  {c.fileName}
                </span>
                <span style={{ color: "var(--ink-3)", fontSize: 11 }}>
                  <bdi>{formatBytes(c.sizeBytes)}</bdi> · <bdi>{formatSlaDue(c.at, tz, tx)}</bdi>
                </span>
                <button
                  type="button"
                  style={smallBtn}
                  disabled={attach.isPending || cap.full}
                  onClick={() =>
                    attach.mutate(c.mediaId, {
                      onSuccess: () => toast(tx("File added to the ticket", "أُضيف الملف إلى التذكرة"), "success"),
                      onError: (err) => fail(err, tx("Couldn't add the file.", "تعذّرت إضافة الملف.")),
                    })
                  }
                >
                  {tx("Add", "إضافة")}
                </button>
              </div>
            ))
          )}
        </div>
      ) : null}

      {list.isPending ? (
        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{tx("Loading…", "جارٍ التحميل…")}</div>
      ) : list.isError ? (
        <div role="alert" style={{ fontSize: 12, color: "var(--bad, #ef4444)" }}>
          {ticketErrorText(list.error, tx, tx("Couldn't load the files.", "تعذّر تحميل الملفات."))}{" "}
          <button type="button" style={{ ...smallBtn, marginInlineStart: 6 }} onClick={() => void list.refetch()}>
            {tx("Retry", "إعادة المحاولة")}
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{tx("No files on this ticket yet.", "لا توجد ملفات على هذه التذكرة بعد.")}</div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {rows.map((r) => {
            const fetchUrl = attachmentFetchUrl(r.url, API_BASE);
            return (
              <li key={r.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div
                  style={{
                    width: 40,
                    height: 40,
                    flexShrink: 0,
                    borderRadius: 6,
                    overflow: "hidden",
                    background: "var(--bg-2)",
                    border: "1px solid var(--line)",
                    display: "grid",
                    placeItems: "center",
                  }}
                >
                  {r.isImage && fetchUrl ? (
                    <AuthorizedImage url={fetchUrl} alt={r.fileName} token={token} retryable={false} />
                  ) : (
                    <span className="mono" style={{ fontSize: 9.5, color: "var(--ink-3)" }}>
                      {KIND_TAG[kindOfMime(r.mimeType) ?? ""] ?? "FILE"}
                    </span>
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                  <span dir="auto" style={{ fontSize: 12.5, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.fileName}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--ink-3)", display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <bdi>{r.size}</bdi>
                    <span>·</span>
                    <span>{r.sourceLabel}</span>
                    {r.addedBy ? (
                      <>
                        <span>·</span>
                        <span dir="auto">{r.addedBy}</span>
                      </>
                    ) : null}
                  </span>
                </div>
                {confirmId === r.id ? (
                  <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                    <span style={{ fontSize: 11, color: "var(--ink-2)" }}>{tx("Remove from ticket?", "إزالة من التذكرة؟")}</span>
                    <button type="button" style={smallBtn} onClick={() => setConfirmId(null)}>
                      {tx("Cancel", "إلغاء")}
                    </button>
                    <button
                      type="button"
                      style={{ ...smallBtn, color: "white", background: "var(--bad, #ef4444)", borderColor: "transparent" }}
                      disabled={unlink.isPending}
                      onClick={() =>
                        unlink.mutate(r.id, {
                          onSuccess: () => {
                            setConfirmId(null);
                            toast(tx("File removed from the ticket", "أُزيل الملف من التذكرة"), "success");
                          },
                          onError: (err) => {
                            setConfirmId(null);
                            fail(err, tx("Couldn't remove the file.", "تعذّرت إزالة الملف."));
                          },
                        })
                      }
                    >
                      {tx("Remove", "إزالة")}
                    </button>
                  </span>
                ) : (
                  <span style={{ display: "inline-flex", gap: 6 }}>
                    <button type="button" style={smallBtn} disabled={busyDownload === r.id} onClick={() => void onDownload(r)}>
                      {busyDownload === r.id ? tx("Downloading…", "جارٍ التنزيل…") : tx("Download", "تنزيل")}
                    </button>
                    {canUpdate ? (
                      <button type="button" style={smallBtn} onClick={() => setConfirmId(r.id)} aria-label={tx(`Remove ${r.fileName}`, `إزالة ${r.fileName}`)}>
                        {tx("Remove", "إزالة")}
                      </button>
                    ) : null}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {canUpdate && items.length > 0 ? (
        <div style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
          {tx("Removing a file keeps it in the media library.", "إزالة الملف من التذكرة تُبقيه في مكتبة الوسائط.")}
        </div>
      ) : null}
    </div>
  );
}
