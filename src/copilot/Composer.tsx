import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import type { SuggestionOptions } from "@tiptap/suggestion";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import { api } from "@/api/client";
import { usePermissions } from "@/auth/usePermissions";
import type { Tx } from "@/lib/tx";
import type { CopilotAttachmentInfo, CopilotRef, CopilotRefKind } from "@/lib/types";
import { deleteAttachment, uploadAttachment } from "./copilotApi";
import { copilotErrorText, copilotKeyText } from "./copilotErrors";
import { ATTACH_MAX_PER_MESSAGE, MAX_REFS, MESSAGE_MAX } from "./copilotConstants";
import { ATTACH_ACCEPT, checkAttachment } from "./attachmentsClient";
import { addRef, refCandidates, type BookingHit, type RefCandidate, type SearchHits } from "./refs";

interface Pending {
  localId: string;
  fileName: string;
  progress: number;
  status: "uploading" | "ready" | "error";
  id?: string;
  kind?: "document" | "image";
  error?: string;
  abort?: AbortController;
}

/** The message text (mentions as "@Title") and its references (capped, deduped). */
function serialize(doc: JSONContent): { text: string; refs: CopilotRef[] } {
  const parts: string[] = [];
  let refs: CopilotRef[] = [];
  const walk = (n: JSONContent) => {
    if (n.type === "text") parts.push(n.text ?? "");
    else if (n.type === "mention") {
      const [kind, ...rest] = String(n.attrs?.id ?? "").split(":");
      const label = String(n.attrs?.label ?? "");
      parts.push(`@${label}`);
      if (kind && rest.length) refs = addRef(refs, { kind: kind as CopilotRefKind, id: rest.join(":"), title: label });
    } else if (n.type === "hardBreak") parts.push("\n");
    for (const c of n.content ?? []) walk(c);
    if (n.type === "paragraph") parts.push("\n");
  };
  for (const c of doc.content ?? []) walk(c);
  return { text: parts.join("").trim(), refs };
}

/** The suggestion list: plain DOM built with textContent (never HTML). */
function renderItems(container: HTMLDivElement, items: RefCandidate[], command: (a: { id: string; label: string }) => void, tx: Tx) {
  container.textContent = "";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "mention-suggestion-item";
    empty.textContent = tx("No matches", "لا نتائج");
    container.appendChild(empty);
    return;
  }
  const KIND: Record<string, [string, string]> = { contact: ["Customer", "عميل"], ticket: ["Ticket", "تذكرة"], booking: ["Booking", "حجز"] };
  for (const it of items) {
    const el = document.createElement("div");
    el.className = "mention-suggestion-item";
    el.dir = "auto";
    el.textContent = `${tx(KIND[it.kind][0], KIND[it.kind][1])} · ${it.title}${it.subtitle ? ` · ${it.subtitle}` : ""}`;
    el.onmousedown = (e) => {
      e.preventDefault();
      command({ id: `${it.kind}:${it.id}`, label: it.title });
    };
    container.appendChild(el);
  }
}

/**
 * SP-18 composer: TipTap with `@` references (customers and tickets from the
 * member's own search, bookings with bookings.view; at most MAX_REFS), file
 * attachments checked here like the server (type, size, count) with upload
 * progress and remove-before-send. Enter sends, Shift+Enter starts a line.
 *
 * The composer stays mounted while the drawer is hidden, so a draft, its
 * references and its attachments survive closing. It clears only when the
 * send is accepted (`onSend` resolves true); a refused send keeps
 * everything for another try.
 */
export interface ComposerHandle {
  focus: () => void;
}

export const Composer = forwardRef<ComposerHandle, {
  tx: Tx;
  lang: "en" | "ar";
  disabled: boolean;
  onSend: (m: { text: string; refs: CopilotRef[]; attachments: CopilotAttachmentInfo[] }) => Promise<boolean>;
  /** The @ list opened or closed (the drawer's Escape leaves the drawer open while it is). */
  onSuggestingChange?: (open: boolean) => void;
}>(function Composer({ tx, lang, disabled, onSend, onSuggestingChange }, ref) {
  const { can } = usePermissions();
  const canBookings = can("bookings.view");
  const [files, setFiles] = useState<Pending[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [length, setLength] = useState(0);
  const suggesting = useRef(false);
  const [sending, setSending] = useState(false);
  // The editor keeps its first extensions: reach the latest callback through a ref.
  const onSuggestRef = useRef(onSuggestingChange);
  onSuggestRef.current = onSuggestingChange;
  const setSuggesting = (v: boolean) => {
    suggesting.current = v;
    onSuggestRef.current?.(v);
  };
  const sendRef = useRef<() => void>(() => undefined);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const suggestion = useMemo<Partial<SuggestionOptions>>(
    () => ({
      char: "@",
      items: async ({ query, editor }: { query: string; editor: { getJSON: () => JSONContent } }) => {
        const q = query.trim();
        if (q.length < 1) return [];
        const chosen = serialize(editor.getJSON()).refs;
        if (chosen.length >= MAX_REFS) return [];
        const [search, bookings] = await Promise.all([
          api.get<SearchHits>(`/search?q=${encodeURIComponent(q)}&limit=5`).catch(() => null),
          canBookings && q.length >= 2 ? api.get<{ items: BookingHit[] }>(`/appointments/search?q=${encodeURIComponent(q)}`).then((r) => r.items.slice(0, 5)).catch(() => []) : Promise.resolve([]),
        ]);
        return refCandidates(search, bookings, chosen, lang).slice(0, 8);
      },
      render: () => {
        let popup: TippyInstance[] = [];
        let list: HTMLDivElement;
        let current: { items: RefCandidate[]; command: (a: { id: string; label: string }) => void } | null = null;
        return {
          onStart: (props) => {
            setSuggesting(true);
            current = { items: props.items as RefCandidate[], command: props.command };
            list = document.createElement("div");
            list.className = "mention-suggestion-list";
            renderItems(list, props.items as RefCandidate[], props.command, tx);
            popup = tippy("body", {
              getReferenceClientRect: () => (props.clientRect?.() ?? new DOMRect()) as DOMRect,
              appendTo: () => document.body,
              content: list,
              showOnCreate: true,
              interactive: true,
              trigger: "manual",
              placement: "top-start",
              zIndex: 1200,
            });
          },
          onUpdate: (props) => {
            current = { items: props.items as RefCandidate[], command: props.command };
            renderItems(list, props.items as RefCandidate[], props.command, tx);
            popup[0]?.setProps({ getReferenceClientRect: () => (props.clientRect?.() ?? new DOMRect()) as DOMRect });
          },
          onKeyDown: (props) => {
            if (props.event.key === "Escape") {
              // Handled here: the drawer must not close (it checks defaultPrevented).
              props.event.preventDefault();
              popup[0]?.hide();
              setSuggesting(false);
              return true;
            }
            // Enter takes the first match.
            if (props.event.key === "Enter" && current?.items.length) {
              const it = current.items[0];
              current.command({ id: `${it.kind}:${it.id}`, label: it.title });
              return true;
            }
            return false;
          },
          onExit: () => {
            setSuggesting(false);
            popup[0]?.destroy();
          },
        };
      },
    }),
    [canBookings, lang, tx],
  );

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false, bulletList: false, orderedList: false, codeBlock: false, blockquote: false, horizontalRule: false }),
      Mention.configure({
        HTMLAttributes: { class: "copilot-mention" },
        suggestion,
        renderText: ({ node }) => `@${(node.attrs.label as string | null) ?? ""}`,
        renderHTML: ({ node, options }) => ["span", options.HTMLAttributes, `@${(node.attrs.label as string | null) ?? ""}`],
      }),
    ],
    content: "",
    editorProps: {
      attributes: { class: "copilot-editor", dir: "auto", "aria-label": tx("Ask Kewy", "اسأل كيوي") },
      handleKeyDown: (_view, event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !suggesting.current) {
          event.preventDefault();
          sendRef.current();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: e }) => setLength(serialize(e.getJSON()).text.length),
  });

  useImperativeHandle(ref, () => ({ focus: () => editor?.commands.focus("end") }), [editor]);

  const uploading = files.some((f) => f.status === "uploading");
  const ready = files.filter((f) => f.status === "ready");

  sendRef.current = () => {
    if (!editor || disabled || uploading || sending) return;
    const { text, refs } = serialize(editor.getJSON());
    if (!text) return;
    if (text.length > MESSAGE_MAX) {
      setError(copilotKeyText("copilot.message_invalid", tx, { max: MESSAGE_MAX }));
      return;
    }
    setError(null);
    setSending(true);
    void onSend({ text, refs, attachments: ready.map((f) => ({ id: f.id!, fileName: f.fileName, kind: f.kind! })) })
      .then((accepted) => {
        // Cleared only once the server took the message; a refusal keeps text, references and files.
        if (!accepted) return;
        editor.commands.clearContent(true);
        setLength(0);
        setFiles((fs) => fs.filter((f) => !ready.some((r) => r.localId === f.localId)));
      })
      .finally(() => setSending(false));
  };

  const pick = (list: FileList | null) => {
    if (!list) return;
    setError(null);
    let count = files.filter((f) => f.status !== "error").length;
    for (const file of Array.from(list)) {
      const check = checkAttachment(file, count);
      if (!check.ok) {
        setError(`${file.name}: ${copilotKeyText(check.key, tx, check.extra)}`);
        continue;
      }
      count++;
      const localId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const abort = new AbortController();
      setFiles((fs) => [...fs, { localId, fileName: file.name, progress: 0, status: "uploading", kind: check.kind, abort }]);
      uploadAttachment(file, (p) => setFiles((fs) => fs.map((f) => (f.localId === localId ? { ...f, progress: p } : f))), abort.signal)
        .then((a) => {
          // Removed while uploading but the server finished first: delete it (else the 24 h sweep would).
          if (abort.signal.aborted) {
            void deleteAttachment(a.id).catch(() => undefined);
            return;
          }
          setFiles((fs) => fs.map((f) => (f.localId === localId ? { ...f, status: "ready", progress: 1, id: a.id, kind: a.kind } : f)));
        })
        .catch((e) => {
          if (abort.signal.aborted) return;
          setFiles((fs) => fs.map((f) => (f.localId === localId ? { ...f, status: "error", error: copilotErrorText(e, tx) } : f)));
        });
    }
  };

  const remove = (f: Pending) => {
    f.abort?.abort();
    setFiles((fs) => fs.filter((x) => x.localId !== f.localId));
    if (f.status === "ready" && f.id) void deleteAttachment(f.id).catch(() => undefined);
  };

  return (
    <div className="copilot-composer">
      {files.length > 0 && (
        <div className="copilot-chips">
          {files.map((f) => (
            <span key={f.localId} className="copilot-chip" data-status={f.status} title={f.error ?? undefined}>
              <bdi>{f.fileName}</bdi>
              {f.status === "uploading" && <span className="mono"> {Math.round(f.progress * 100)}%</span>}
              {f.status === "error" && <span> · {tx("failed", "فشل")}</span>}
              <button type="button" className="copilot-chip-x" aria-label={tx("Remove", "إزالة")} onClick={() => remove(f)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <EditorContent editor={editor} />
      {error && (
        <div className="copilot-error" role="alert">
          {error}
        </div>
      )}
      <div className="copilot-composer-bar">
        <input ref={fileInput} type="file" multiple hidden accept={ATTACH_ACCEPT} onChange={(e) => (pick(e.target.files), (e.target.value = ""))} />
        <button
          type="button"
          className="btn ghost sm"
          disabled={files.filter((f) => f.status !== "error").length >= ATTACH_MAX_PER_MESSAGE}
          onClick={() => fileInput.current?.click()}
          title={tx("Attach a file (PDF, CSV, Excel, text, image)", "أرفق ملفًا (PDF أو CSV أو Excel أو نص أو صورة)")}
        >
          📎 {tx("Attach", "إرفاق")}
        </button>
        <span className="copilot-hint">{tx("Type @ to reference a customer, ticket or booking", "اكتب @ للإشارة إلى عميل أو تذكرة أو حجز")}</span>
        <span className="mono copilot-count" data-over={length > MESSAGE_MAX ? "1" : undefined}>
          {length.toLocaleString("en-US")}/{MESSAGE_MAX.toLocaleString("en-US")}
        </span>
        <button type="button" className="btn primary sm" disabled={disabled || uploading || sending || length === 0} onClick={() => sendRef.current()}>
          {tx("Send", "إرسال")}
        </button>
      </div>
    </div>
  );
});
