import { Fragment, memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { REPLY_DRAFT_EVENT, takeReplyDraft } from "@/copilot/replyDraft";
import { openParamForRoute, useOpenParam } from "@/lib/useOpenParam";
import { InlineNote } from "@/components/InlineNote";
import { mergeByTime } from "@/lib/mentions";
import { useTweaks } from "@/tweaks/context";
import { makeTx, type Tx } from "@/lib/tx";
import { Avatar } from "@/components/Avatar";
import { type BadgeKind } from "@/components/Badge";
import { ResolutionBadge } from "./inbox/ResolutionBadge";
import { Modal } from "@/components/Modal";
import { ConvRowSkeleton, MessageSkeleton } from "@/components/Skeleton";
import { NotesPanel } from "@/components/NotesPanel";
import {
  IconAttach,
  IconBook,
  IconCheck,
  IconMore,
  IconPhone,
  IconSend,
  IconTemplate,
  IconX,
} from "@/icons";
import { API_BASE, ApiError, api, tokenStore } from "@/api/client";
import { useFetch, useMutation } from "@/api/useFetch";
import { uploadMedia } from "@/api/uploadMedia";
import { mediaErrorText } from "@/components/media/mediaErrors";
import { useRealtime } from "@/api/useRealtime";
import { useAuth } from "@/auth/context";
import { usePermissions, NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";
import {
  CHANNEL_LABEL,
  type Contact,
  type ConversationLabel,
  type TeamMember,
  type Note,
  type ConvChannel,
  type Conversation,
  type Lang,
  type Message,
  type Pipeline,
  type Ticket,
  type TicketStage,
} from "@/lib/types";
import { ConversationTicketsPill } from "./inbox/ConversationTicketsPill";
import { ConversationAiToggle } from "./inbox/ConversationAiToggle";
import { ConversationActions, isLiveThreadId } from "./inbox/ConversationActions";
import {
  activeFilterCount, bucketCounts, type InboxView, EMPTY_FILTER, matchesFilter, needsAttention, sortConversations, numberTabs, type NumberTab,
  type FilterCtx, type InboxBucket, type InboxFilter, type InboxSort,
} from "./inbox/inboxFilters";
import {
  readFilterFromHash, readNumberFromHash, readViewFromHash, writeFilterToHash, writeNumberToHash, writeViewToHash,
} from "./inbox/inboxHash";
import { pickSendRoute, supportsTemplates } from "./inbox/sendRoute";
import { invalidateChannels, useChannelsList } from "./channels/channelUi";
import { useQueryClient } from "@tanstack/react-query";
import { channelErrorText, sendErrorText } from "./channels/channelErrors";
import { AddFilteredToGroup } from "./inbox/AddFilteredToGroup";
import { InboxBoard } from "./inbox/InboxBoard";
import { InboxTable } from "./inbox/InboxTable";
import { InboxFilterMenu } from "./inbox/InboxFilterMenu";
import { InboxSortMenu } from "./inbox/InboxSortMenu";
import { TriageStrip } from "./inbox/TriageStrip";
import { LabelChips } from "./inbox/LabelChips";
import { AdAttributionCard, CtwaChip } from "./inbox/CtwaChip";
import { shouldAutoSelect, useEmbedVisible } from "@/embed/visibility";
import { AddToPipelineButton } from "./inbox/AddToPipelineButton";
import { MediaPicker } from "@/components/MediaPicker";
import type { ChannelDto, Media } from "@/lib/types";
import { CustomerThread } from "./inbox/thread/CustomerThread";
import { useSavedReplies } from "./inbox/SavedRepliesPicker";
import { LinkedItemsCard } from "./inbox/LinkedItemsCard";
import { TopicsCard } from "./inbox/TopicsCard";
import { TemplateSendDialog, type TemplateHeaderValue } from "./inbox/TemplateSendDialog";
import { getHashParam, setHashParam } from "@/lib/hashState";


/** Day label for thread separators: Today / Yesterday / a localized date.
 *  Threads span days (a recovered complaint sat a week), so per-message
 *  clock times alone were misleading. */
function dayLabel(
  iso: string,
  lang: Lang,
  tx: (en: string, ar: string) => string,
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(new Date()) - startOf(d)) / 86_400_000);
  if (diffDays === 0) return tx("Today", "اليوم");
  if (diffDays === 1) return tx("Yesterday", "أمس");
  return d.toLocaleDateString(lang === "ar" ? "ar" : undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}
type ConversationDetail = Conversation & { messages: Message[] };

const CHANNELS: ConvChannel[] = ["whatsapp", "instagram", "facebook", "tiktok", "webchat", "telegram", "l"];
/** Channels offered as filter toggles. TikTok is hidden until we support it;
 *  it stays in CHANNELS so the default filter never hides a conversation. */
const FILTER_CHANNELS = CHANNELS.filter((ch) => ch !== "tiktok");

/** Channel brand colors — used for the filter-pill dots and the solid channel
 *  tag in the thread header (per the Samemha Inbox v2 mock). */
const CHANNEL_DOT: Record<ConvChannel, string> = {
  whatsapp: "#22b573",
  instagram: "#d64d7a",
  facebook: "#4267b2",
  tiktok: "#7a7a7a",
  webchat: "#5A8FD4",
  telegram: "#229ED9",
  l: "#8b5cf6",
};

/* ── Inline channel glyphs ───────────────────────────────────────────────── */

interface GlyphProps {
  size?: number;
}

function WaIcon({ size = 10 }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#fff"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5 18l-1 4 4-1a8 8 0 1 0-3-3z" />
      <path d="M9 10c.5 1.5 1.5 2.5 3 3l1.5-1 2.5 1.5c0 1.5-1 2.5-2.5 2.5-3 0-6-3-6-6 0-1.5 1-2.5 2.5-2.5L11.5 10z" />
    </svg>
  );
}

function IgIcon({ size = 10 }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#fff"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.5" cy="6.5" r="0.6" fill="#fff" stroke="none" />
    </svg>
  );
}

function FbIcon({ size = 10 }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <path
        d="M14 8h2.5V5H14c-2 0-3.5 1.5-3.5 3.5V11H8v3h2.5v7H14v-7h2.5l.5-3H14V9c0-.6.4-1 1-1z"
        fill="#fff"
      />
    </svg>
  );
}

function WebIcon({ size = 10 }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#fff"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18" />
      <path d="M12 3a14 14 0 0 0 0 18" />
    </svg>
  );
}

function TgIcon({ size = 10 }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M21 4 3 11l5.5 2L10 19l3-3.5 4.5 3.3L21 4z" fill="#fff" />
    </svg>
  );
}

function TtIcon({ size = 10 }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      {/* Cyan back-shadow note */}
      <path
        d="M14 4.6c.5 1.7 1.7 3 3.4 3.5v2.4a6.5 6.5 0 0 1-3.4-1V15a4.6 4.6 0 1 1-4.6-4.6c.3 0 .6 0 .9.1v2.5a2.2 2.2 0 1 0 1.5 2.1V4.6H14z"
        fill="#25F4EE"
        transform="translate(-1.2 1)"
      />
      {/* Magenta back-shadow note */}
      <path
        d="M14 4.6c.5 1.7 1.7 3 3.4 3.5v2.4a6.5 6.5 0 0 1-3.4-1V15a4.6 4.6 0 1 1-4.6-4.6c.3 0 .6 0 .9.1v2.5a2.2 2.2 0 1 0 1.5 2.1V4.6H14z"
        fill="#FE2C55"
        transform="translate(1.2 -0.4)"
      />
      {/* White note on top */}
      <path
        d="M14 4.6c.5 1.7 1.7 3 3.4 3.5v2.4a6.5 6.5 0 0 1-3.4-1V15a4.6 4.6 0 1 1-4.6-4.6c.3 0 .6 0 .9.1v2.5a2.2 2.2 0 1 0 1.5 2.1V4.6H14z"
        fill="#fff"
      />
    </svg>
  );
}

const CHANNEL_BG: Record<ConvChannel, string> = {
  whatsapp: "#25D366",
  instagram:
    "linear-gradient(135deg, #f09433 0%, #e6683c 25%, #dc2743 50%, #cc2366 75%, #bc1888 100%)",
  facebook: "#1877F2",
  tiktok: "#000000",
  webchat: "var(--info)",
  telegram: "#229ED9",
  l: "#8b5cf6",
};

function ChannelMark({
  channel,
  size = 14,
}: {
  channel: ConvChannel;
  size?: number;
}) {
  const glyphSize = Math.round(size * 0.7);
  const Glyph =
    channel === "whatsapp"
      ? WaIcon
      : channel === "instagram"
        ? IgIcon
        : channel === "facebook"
          ? FbIcon
          : channel === "tiktok"
            ? TtIcon
            : channel === "telegram"
              ? TgIcon
              : WebIcon;
  return (
    <span
      title={CHANNEL_LABEL[channel]}
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(3, Math.round(size * 0.28)),
        background: CHANNEL_BG[channel],
        display: "inline-grid",
        placeItems: "center",
        flex: "0 0 auto",
        boxShadow: "0 0 0 1.5px var(--bg)",
      }}
    >
      <Glyph size={glyphSize} />
    </span>
  );
}

interface InboxListProps {
  filter: InboxFilter;
  setFilter: (f: InboxFilter) => void;
  sort: InboxSort;
  setSort: (s: InboxSort) => void;
  bucketCountMap: Record<InboxBucket, number>;
  attention: Conversation[];
  team: TeamMember[];
  labels: ConversationLabel[];
  channels: Set<ConvChannel>;
  toggleChannel: (c: ConvChannel) => void;
  allConvs: Conversation[];
  activeId: string | null;
  setActiveId: (id: string) => void;
  view: InboxView;
  setView: (v: InboxView) => void;
  search: string;
  setSearch: (s: string) => void;
  visibleConvs: Conversation[];
  numberTabList: NumberTab[];
  numberTab: string | null;
  setNumberTab: (id: string | null) => void;
  numberChannels: ChannelDto[];
  contactById: Map<string, Contact>;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  tx: Tx;
}

interface ConversationPaneProps {
  conv: ConversationDetail;
  contactById: Map<string, Contact>;
  onSend: (body: string, mediaId?: string) => Promise<void>;
  onSendTemplate: (
    name: string,
    language: string,
    variables: string[],
    header?: TemplateHeaderValue,
  ) => Promise<void>;
  /** "conv" = this conversation only, "all" = the customer's stitched thread (`?tv=all`). */
  threadView: "conv" | "all";
  onThreadView: (v: "conv" | "all") => void;
  sending: boolean;
  sendError: string | null;
  /** SP-19: the conversation's channel, and whether its kind has several numbers. */
  channel: ChannelDto | null;
  multiNumber: boolean;
  /** I1: the channel's label among the number tabs (tells apart numbers sharing a name). */
  numberLabel?: string | null;
  onConvertToTicket: () => void;
  onConversationChanged: () => Promise<unknown>;
  messagesLoading: boolean;
  lang: Lang;
  tx: Tx;
}

interface ContactRightRailProps {
  conv: Conversation;
  contactById: Map<string, Contact>;
  onContactsChanged: () => void;
  tx: Tx;
}

/* ── Tag presets (Samemha-tailored for a custom-print business) ─────────── */

interface TagPreset {
  id: string;
  ar: string;
  kind: BadgeKind;
}

const TAG_PRESETS: TagPreset[] = [
  { id: "VIP",       ar: "مميّز",       kind: "warn"   },
  { id: "New",       ar: "جديد",        kind: "info"   },
  { id: "Hot",       ar: "حار",          kind: "bad"    },
  { id: "Repeat",    ar: "عميل دائم",    kind: "ok"     },
  { id: "Bulk",      ar: "بالجملة",      kind: "accent" },
  { id: "B2B",       ar: "شركات",        kind: "human"  },
  { id: "Wholesale", ar: "موزّع",        kind: ""       },
  { id: "Designer",  ar: "بتصميمه",      kind: ""       },
  { id: "At-risk",   ar: "في خطر",       kind: "warn"   },
  { id: "Promoter",  ar: "مروّج",        kind: "accent" },
];

function tagKindFor(tag: string): BadgeKind {
  const preset = TAG_PRESETS.find((p) => p.id === tag);
  return preset?.kind ?? "";
}

interface TagEditorProps {
  contactId: string;
  current: string[];
  onChanged: () => void;
  tx: Tx;
}

function TagEditor({ contactId, current, onChanged, tx }: TagEditorProps) {
  const [open, setOpen] = useState<boolean>(false);
  const [draft, setDraft] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);

  const save = (next: string[]): void => {
    setBusy(true);
    api
      .patch<Contact>(`/contacts/${contactId}`, { tags: next })
      .then(() => {
        onChanged();
        setDraft("");
      })
      .catch(() => {
        /* silent */
      })
      .finally(() => setBusy(false));
  };

  const addTag = (raw: string): void => {
    const t = raw.trim();
    if (!t) return;
    if (current.includes(t)) return;
    save([...current, t]);
  };

  const removeTag = (t: string): void => {
    save(current.filter((x) => x !== t));
  };

  const onSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    addTag(draft);
  };

  // Suggestions = preset list minus tags already on the contact, optionally
  // filtered by what the user is typing.
  const q = draft.trim().toLowerCase();
  const suggestions = TAG_PRESETS.filter((p) => !current.includes(p.id)).filter(
    (p) =>
      q.length === 0 ||
      p.id.toLowerCase().includes(q) ||
      p.ar.includes(q),
  );
  const isCustom =
    q.length > 0 && !TAG_PRESETS.some((p) => p.id.toLowerCase() === q);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          display: "flex",
          gap: 6,
          justifyContent: "center",
          flexWrap: "wrap",
        }}
      >
        {current.map((tag) => (
          <span
            key={tag}
            className={`badge ${tagKindFor(tag)}`.trim()}
            style={{ paddingInlineEnd: 4, gap: 4 }}
          >
            {tag}
            <button
              type="button"
              onClick={() => removeTag(tag)}
              disabled={busy}
              title={tx("Remove tag", "إزالة الوسم")}
              style={{
                border: 0,
                background: "transparent",
                color: "currentColor",
                opacity: 0.6,
                cursor: "pointer",
                padding: "0 2px",
                fontSize: 14,
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </span>
        ))}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={busy}
          className="badge"
          style={{
            cursor: "pointer",
            background: open ? "var(--accent-soft)" : "var(--bg-2)",
            color: open ? "var(--accent)" : "var(--ink-2)",
            borderColor: open ? "var(--accent-ring)" : "var(--line-soft)",
            padding: "2px 8px",
          }}
        >
          + {tx("Add tag", "إضافة وسم")}
        </button>
      </div>

      {open && (
        <div
          style={{
            padding: 10,
            border: "1px solid var(--line-soft)",
            background: "var(--bg-2)",
            borderRadius: "var(--r)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <form onSubmit={onSubmit} style={{ display: "flex", gap: 6 }}>
            <input
              type="text"
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={tx("Search or create…", "ابحث أو أضف…")}
              style={{
                flex: 1,
                background: "var(--bg-1)",
                border: "1px solid var(--line-soft)",
                borderRadius: "var(--r-sm)",
                padding: "6px 8px",
                color: "var(--ink)",
                fontSize: 12,
                outline: "none",
              }}
            />
            <button
              type="submit"
              className="btn primary sm"
              disabled={busy || draft.trim().length === 0}
            >
              {tx("Add", "أضف")}
            </button>
          </form>

          {suggestions.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {suggestions.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => addTag(p.id)}
                  disabled={busy}
                  className={`badge ${p.kind}`.trim()}
                  style={{ cursor: "pointer", border: "1px dashed currentColor" }}
                >
                  + {p.id}
                </button>
              ))}
            </div>
          )}
          {isCustom && (
            <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
              {tx(`Press Add to create custom tag "${draft}"`, `اضغط أضف لإنشاء وسم مخصص "${draft}"`)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const ticketInputStyle: CSSProperties = {
  width: "100%",
  background: "var(--bg-2)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r)",
  padding: "8px 12px",
  color: "var(--ink)",
  fontSize: 13,
  marginTop: 6,
  outline: "none",
};

const ticketLabelStyle: CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  color: "var(--ink-3)",
  marginTop: 12,
  display: "block",
};

interface ConvertTicketModalProps {
  conv: ConversationDetail;
  contact: Contact | undefined;
  isFbConv: boolean;
  onClose: () => void;
  onCreated: (ticketNumber: number) => void;
  tx: Tx;
}

interface CreateTicketBody {
  pipelineId: string;
  stageId: string;
  contactId: string;
  title: string;
  description?: string;
  value?: number;
  conversationId?: string;
}

function ConvertTicketModal({
  conv,
  contact,
  isFbConv,
  onClose,
  onCreated,
  tx,
}: ConvertTicketModalProps) {
  const pipelinesQ = useFetch<Pipeline[]>("/pipelines");
  const pipelines = pipelinesQ.data ?? [];

  const [pipelineId, setPipelineId] = useState<string>("");
  const [stageId, setStageId] = useState<string>("");
  const [title, setTitle] = useState<string>(() => conv.preview.slice(0, 60));
  const [description, setDescription] = useState<string>("");
  const [valueStr, setValueStr] = useState<string>("");
  const [pickersInit, setPickersInit] = useState(false);

  // Default-pick the default pipeline + its first stage once data arrives.
  useEffect(() => {
    if (pickersInit) return;
    if (pipelines.length === 0) return;
    const def = pipelines.find((p) => p.isDefault) ?? pipelines[0]!;
    setPipelineId(def.id);
    const firstStage = [...def.stages].sort((a, b) => a.order - b.order)[0];
    if (firstStage) setStageId(firstStage.id);
    setPickersInit(true);
  }, [pipelines, pickersInit]);

  const activePipeline = pipelines.find((p) => p.id === pipelineId);
  const stages: TicketStage[] = activePipeline
    ? [...activePipeline.stages].sort((a, b) => a.order - b.order)
    : [];

  // When pipeline changes, reset stage to first of new pipeline.
  const handlePipelineChange = (id: string) => {
    setPipelineId(id);
    const next = pipelines.find((p) => p.id === id);
    const firstStage = next ? [...next.stages].sort((a, b) => a.order - b.order)[0] : undefined;
    setStageId(firstStage ? firstStage.id : "");
  };

  const createTicket = useMutation<CreateTicketBody, Ticket>((body) =>
    api.post<Ticket>("/tickets", body),
  );

  const canSubmit =
    pipelineId.length > 0 &&
    stageId.length > 0 &&
    title.trim().length > 0 &&
    !!contact &&
    !createTicket.loading;

  // Synthetic FB contacts don't exist in our DB.  Before creating a ticket
  // for one, materialize a real Contact row so the FK is valid.
  const ensureRealContactId = (): Promise<string> => {
    if (!contact) return Promise.reject(new Error("No contact"));
    if (contact.industry !== "facebook-dm") return Promise.resolve(contact.id);
    return api
      .post<Contact>("/contacts", {
        name: contact.name,
        phone: contact.phone || "—",
        industry: "facebook",
        lifecycle: "lead",
        source: "Facebook DM",
        tags: ["Facebook"],
        lastSeen: contact.lastSeen,
      })
      .then((c) => c.id);
  };

  const handleSubmit = () => {
    if (!canSubmit || !contact) return;
    const desc = description.trim();
    const numValue = Number(valueStr);
    const hasValue = valueStr.trim().length > 0 && Number.isFinite(numValue);

    ensureRealContactId()
      .then((realContactId) => {
        const body: CreateTicketBody = {
          pipelineId,
          stageId,
          contactId: realContactId,
          title: title.trim(),
        };
        if (desc.length > 0) body.description = desc;
        if (hasValue) body.value = numValue;
        if (!isFbConv) body.conversationId = conv.id;
        return createTicket.mutate(body);
      })
      .then((t) => {
        onCreated(t.number);
        onClose();
      })
      .catch(() => {
        // surfaced via createTicket.error
      });
  };

  return (
    <Modal onClose={onClose} width={480} label="Convert to ticket">
        <h3 style={{ margin: 0, fontSize: 16 }}>
          {tx("Convert to ticket", "تحويل إلى تذكرة")}
        </h3>
        <p
          style={{
            margin: "4px 0 16px",
            color: "var(--ink-2)",
            fontSize: 13,
          }}
        >
          {tx(
            "Create a sales ticket from this conversation.",
            "أنشئ تذكرة مبيعات من هذه المحادثة.",
          )}
        </p>

        {pipelinesQ.loading && (
          <div
            className="mono"
            style={{ fontSize: 12, color: "var(--ink-3)", padding: "8px 0" }}
          >
            {tx("loading…", "جارٍ التحميل…")}
          </div>
        )}
        {pipelinesQ.error && (
          <div style={{ fontSize: 12, color: "var(--bad)", padding: "8px 0" }}>
            {pipelinesQ.error}
          </div>
        )}

        {!pipelinesQ.loading && !pipelinesQ.error && (
          <>
            <label
              className="mono"
              style={{ ...ticketLabelStyle, marginTop: 0 }}
            >
              {tx("Pipeline", "خط الأنابيب")}
            </label>
            <select
              style={{ ...ticketInputStyle, appearance: "none" }}
              value={pipelineId}
              onChange={(e) => handlePipelineChange(e.target.value)}
            >
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>

            <label className="mono" style={ticketLabelStyle}>
              {tx("Stage", "المرحلة")}
            </label>
            <select
              style={{ ...ticketInputStyle, appearance: "none" }}
              value={stageId}
              onChange={(e) => setStageId(e.target.value)}
            >
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>

            <label className="mono" style={ticketLabelStyle}>
              {tx("Title", "العنوان")}
            </label>
            <input
              className="input"
              style={ticketInputStyle}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={tx("Short title", "عنوان قصير")}
            />

            <label className="mono" style={ticketLabelStyle}>
              {tx("Description", "الوصف")}
            </label>
            <textarea
              className="input"
              style={{ ...ticketInputStyle, minHeight: 70, resize: "vertical" }}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={tx("Optional context…", "سياق اختياري…")}
            />

            <label className="mono" style={ticketLabelStyle}>
              {tx("Value (SAR)", "القيمة (ريال)")}
            </label>
            <input
              className="input"
              style={ticketInputStyle}
              type="number"
              inputMode="decimal"
              value={valueStr}
              onChange={(e) => setValueStr(e.target.value)}
              placeholder="0"
            />
          </>
        )}

        {createTicket.error && (
          <div
            style={{
              marginTop: 12,
              fontSize: 12,
              color: "var(--bad)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {createTicket.error}
          </div>
        )}

        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: 20,
          }}
        >
          <button className="btn ghost" onClick={onClose}>
            {tx("Cancel", "إلغاء")}
          </button>
          <button
            className="btn primary"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            <IconCheck w={13} />
            {createTicket.loading
              ? tx("Creating…", "جارٍ الإنشاء…")
              : tx("Create", "أنشئ")}
          </button>
        </div>
    </Modal>
  );
}

interface BubbleProps {
  m: Message;
}

function InboxList({
  filter,
  setFilter,
  sort,
  setSort,
  bucketCountMap,
  attention,
  team,
  labels,
  channels,
  toggleChannel,
  allConvs,
  activeId,
  setActiveId,
  view,
  setView,
  search,
  setSearch,
  visibleConvs,
  numberTabList,
  numberTab,
  setNumberTab,
  numberChannels,
  contactById,
  loading,
  error,
  onRetry,
  tx,
}: InboxListProps) {
  const teamById = useMemo(() => new Map(team.map((m) => [m.id, m])), [team]);
  const labelById = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels]);

  // During the unified initial load the skeleton stands in for the rows —
  // rendering partial rows underneath would reintroduce per-channel pop-in.
  const q = search.trim().toLowerCase();

  // Per-channel totals for the channel filter pills.
  const channelCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of allConvs) m.set(c.channel, (m.get(c.channel) ?? 0) + 1);
    return m;
  }, [allConvs]);

  const filters: { id: InboxBucket; label: string }[] = [
    { id: "all", label: tx("All", "الكل") },
    { id: "mine", label: tx("Mine", "مخصّصة لي") },
    { id: "unassigned", label: tx("Unassigned", "غير معيّنة") },
    { id: "unread", label: tx("Unread", "غير مقروءة") },
    { id: "human", label: tx("Open", "مفتوحة") },
    { id: "pending_customer", label: tx("Pending", "بانتظار العميل") },
    { id: "resolved", label: tx("Resolved", "محلولة") },
    { id: "closed", label: tx("Closed", "مغلقة") },
    { id: "spam", label: tx("Spam", "مزعجة") },
  ];

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        borderInlineEnd: "1px solid var(--line-soft)",
        background: "var(--bg-1)",
        minHeight: 0,
      }}
    >
      <div style={{ padding: "18px 16px 12px", borderBottom: "1px solid var(--line-soft)" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          <div>
            <h2 className="ix-display" style={{ margin: 0, fontSize: 18, fontWeight: 800, lineHeight: 1 }}>
              {tx("Inbox", "الرسائل")}
            </h2>
            <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 4 }}>
              {allConvs.length} {tx("conversations", "محادثة")}
            </div>
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            <InboxFilterMenu filter={filter} onChange={setFilter} team={team} labels={labels} channels={numberChannels} tx={tx} />
            <InboxSortMenu sort={sort} onChange={setSort} tx={tx} />
          </div>
        </div>
        <div
          role="group"
          aria-label={tx("View", "العرض")}
          style={{ display: "flex", gap: 4, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}
        >
          {(["list", "table", "board"] as const).map((v) => (
            <button
              key={v}
              type="button"
              className={`btn sm${view === v ? " primary" : ""}`}
              aria-pressed={view === v}
              onClick={() => setView(v)}
            >
              {v === "list" ? tx("List", "قائمة") : v === "table" ? tx("Table", "جدول") : tx("Board", "لوحة")}
            </button>
          ))}
          <span style={{ flex: 1 }} />
          <AddFilteredToGroup convs={visibleConvs} tx={tx} lang={tx("en", "ar") as Lang} />
        </div>
        <input
          className="ix-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={tx("Search conversations…", "ابحث في المحادثات…")}
          aria-label={tx("Search conversations", "ابحث في المحادثات")}
        />
        {numberTabList.length > 0 && (
          <div
            role="tablist"
            aria-label={tx("Numbers", "الأرقام")}
            style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 12 }}
          >
            {numberTabList.map((tab) => (
              <button
                key={tab.id ?? "all"}
                type="button"
                role="tab"
                aria-selected={numberTab === tab.id}
                className={`ix-pill ${numberTab === tab.id ? "active" : ""}`.trim()}
                onClick={() => setNumberTab(tab.id)}
              >
                <span dir="auto">{tab.id === null ? tx("All numbers", "كل الأرقام") : tab.label}</span>
                <span className="ct">{tab.count}</span>
              </button>
            ))}
          </div>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 12 }}>
          {filters.map((f) => (
            <button
              key={f.id}
              className={`ix-pill ${filter.bucket === f.id ? "active" : ""}`.trim()}
              aria-pressed={filter.bucket === f.id}
              onClick={() => setFilter({ ...filter, bucket: f.id })}
            >
              {f.label}
              <span className="ct">{bucketCountMap[f.id]}</span>
            </button>
          ))}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 8 }}>
          {FILTER_CHANNELS.map((ch) => {
            const active = channels.has(ch);
            return (
              <button
                key={ch}
                type="button"
                className={`ix-ch ${active ? "active" : ""}`.trim()}
                onClick={() => toggleChannel(ch)}
                aria-pressed={active}
              >
                <span className="dot" style={{ background: CHANNEL_DOT[ch] }} />
                {CHANNEL_LABEL[ch]}
                <span style={{ opacity: 0.6 }}>{channelCounts.get(ch) ?? 0}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", paddingBlock: "6px 16px" }}>
        {loading && (
          <div aria-label={tx("Loading conversations", "جارٍ تحميل المحادثات")}>
            {Array.from({ length: 6 }).map((_, i) => (
              <ConvRowSkeleton key={i} />
            ))}
          </div>
        )}
        {error && (
          <div
            style={{
              padding: "12px 14px",
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
              color: "var(--bad)",
            }}
          >
            <span style={{ flex: 1 }}>{error}</span>
            <button className="btn sm ghost" onClick={onRetry}>
              {tx("Retry", "إعادة")}
            </button>
          </div>
        )}
        {!loading && !error && visibleConvs.length === 0 && !q && (
          <div style={{ padding: "18px 16px", fontSize: 12, color: "var(--ink-3)" }}>
            <div>
              {allConvs.length === 0
                ? tx("No conversations yet", "لا توجد محادثات بعد")
                : tx("No conversations match these filters.", "لا توجد محادثات تطابق عوامل التصفية.")}
            </div>
            {allConvs.length > 0 && (filter.bucket !== "all" || activeFilterCount(filter) > 0) && (
              <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setFilter(EMPTY_FILTER)}>
                {tx("Clear filters", "مسح عوامل التصفية")}
              </button>
            )}
          </div>
        )}
        {!loading && (
          <TriageStrip
            items={attention}
            contactById={contactById}
            activeId={activeId}
            onSelect={setActiveId}
            tx={tx}
          />
        )}
        {!loading && visibleConvs.length === 0 && q && (
          <div style={{ padding: "18px 16px", fontSize: 12, color: "var(--ink-3)" }}>
            {tx("No conversations match your search.", "لا توجد محادثات مطابقة لبحثك.")}
          </div>
        )}
        {visibleConvs.map((c) => {
          const contact = contactById.get(c.contactId);
          return (
            <div
              key={c.id}
              className={`conv-row ix-row ${activeId === c.id ? "active" : ""}`.trim()}
              onClick={() => setActiveId(c.id)}
            >
              <div style={{ position: "relative", flex: "0 0 auto" }}>
                <Avatar name={contact?.name} color="200" size="lg" />
                <span
                  style={{
                    position: "absolute",
                    insetInlineEnd: -3,
                    bottom: -3,
                    display: "inline-flex",
                  }}
                >
                  <ChannelMark channel={c.channel} size={15} />
                </span>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <span
                    style={{
                      fontWeight: c.unread ? 700 : 600,
                      fontSize: 13.5,
                      flex: 1,
                      minWidth: 0,
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                    }}
                  >
                    {contact?.name}
                  </span>
                  <span style={{ fontSize: 10.5, color: "var(--ink-4)", flexShrink: 0 }}>
                    {c.lastAt}
                  </span>
                </div>
                <div
                  dir="auto"
                  style={{
                    fontSize: 12.5,
                    color: c.unread ? "var(--ink)" : "var(--ink-3)",
                    fontWeight: c.unread ? 600 : 400,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    marginTop: 3,
                    textAlign: "start",
                  }}
                >
                  {c.lastFrom === "human" && <span style={{ color: "var(--accent)" }}>↳ </span>}
                  {c.preview}
                </div>
                {c.adSource && (
                  <div style={{ marginTop: 4, minWidth: 0, display: "flex" }}>
                    <CtwaChip ad={c.adSource} tx={tx} />
                  </div>
                )}
                {(c.labelIds?.length ?? 0) > 0 && (
                  <div style={{ marginTop: 4 }}>
                    <LabelChips labelIds={c.labelIds ?? []} labelById={labelById} />
                  </div>
                )}
              </div>
              {c.assigneeId && teamById.get(c.assigneeId) && (
                <span
                  title={teamById.get(c.assigneeId)!.name}
                  aria-label={teamById.get(c.assigneeId)!.name}
                  style={{
                    flex: "0 0 auto",
                    width: 22,
                    height: 22,
                    borderRadius: 99,
                    display: "grid",
                    placeItems: "center",
                    fontSize: 9.5,
                    fontWeight: 700,
                    background: "var(--bg-3)",
                    color: "var(--ink-2)",
                  }}
                >
                  {teamById.get(c.assigneeId)!.initials}
                </span>
              )}
              {(c.unread > 0 || c.escalated) && (
                <span
                  className="ix-unread-dot"
                  style={c.escalated ? { background: "var(--warn)" } : undefined}
                  title={c.escalated ? tx("Escalated", "مُصعَّدة") : tx("Unread", "غير مقروءة")}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Bubble({ m }: BubbleProps) {
  // 'ai' is outbound too: it is the salon speaking, just not a person. Treating
  // only 'human' as outbound put AI replies on the customer's side of the
  // thread, which reads as though the customer said it.
  const isAi = m.from === "ai";
  const isOut = m.from === "human" || isAi;
  const { user } = useAuth();
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const humanName = isAi ? tx("AI Agent", "الوكيل الذكي") : (user?.name ?? "You");
  const humanColor = user?.color ?? "150";
  // Zernio flattens WhatsApp content it can't carry (stickers, polls, …) into
  // a bullets-only placeholder with no attachment — label it honestly instead
  // of showing cryptic dots. (Live-diagnosed 2026-08-19: a sticker arrived as
  // "•••••••••" with attachments: [].)
  const isUnsupported = !m.attach && /^•+$/.test(m.body.trim());
  // Stored `t` strings are inconsistent across ingestion eras (some local,
  // some UTC — one thread showed 14:26 above 11:36). createdAt is the truth;
  // render it in the viewer's own timezone, falling back to `t` only for
  // rows without a timestamp.
  const timeLabel = m.createdAt
    ? new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : m.t;
  return (
    <div
      className="ix-msg"
      style={{ display: "flex", justifyContent: isOut ? "flex-end" : "flex-start", gap: 8 }}
    >
      {!isOut && <div style={{ width: 24 }} />}
      <div style={{ maxWidth: "58%" }}>
        {isOut && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginBottom: 5,
              justifyContent: "flex-end",
            }}
          >
            {isAi ? (
              <>
                {/* Staff must be able to tell at a glance who spoke. An AI reply
                    that looks like a colleague's is how a wrong answer gets
                    trusted. The 'shadow' agent suffix is set by the CRM when
                    the draft was logged but never delivered. */}
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: "var(--ink-2)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <span aria-hidden>🤖</span>
                  {m.agent?.includes("shadow")
                    ? tx("AI (draft — not sent)", "الذكاء الاصطناعي (مسودة — لم تُرسل)")
                    : tx("AI", "الذكاء الاصطناعي")}
                </span>
              </>
            ) : (
              <>
                <Avatar name={humanName} color={humanColor} size="sm" />
                <span style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-2)" }}>
                  {humanName}
                </span>
              </>
            )}
          </div>
        )}
        <div
          dir="auto"
          style={{
            padding: "11px 15px",
            borderRadius: isOut ? "18px 18px 6px 18px" : "18px 18px 18px 6px",
            background: isOut ? "var(--bubble-out)" : "var(--bubble-in)",
            // A shadow draft is dashed: it is visible to staff but was never
            // delivered, and nothing in the thread should imply the customer
            // saw it.
            border: m.agent?.includes("shadow")
              ? "1px dashed var(--bubble-out-line)"
              : `1px solid ${isOut ? "var(--bubble-out-line)" : "var(--bubble-in-line)"}`,
            opacity: m.agent?.includes("shadow") ? 0.75 : 1,
            boxShadow: "var(--ix-shadow)",
            color: isOut ? "var(--bubble-out-ink)" : "var(--ink)",
            fontSize: 13.5,
            lineHeight: 1.55,
            whiteSpace: "pre-wrap",
            textAlign: "start",
          }}
        >
          {isUnsupported ? (
            <span style={{ fontStyle: "italic", color: "var(--ink-3)" }}>
              {tx(
                "🧩 Unsupported message (sticker, poll, or similar) — view it in WhatsApp",
                "🧩 رسالة غير مدعومة (ملصق أو استفتاء أو نحوه) — اعرضها في واتساب",
              )}
            </span>
          ) : (
            m.body
          )}
          {m.attach && <MessageAttachment value={m.attach} />}
        </div>
        {m.reaction && (
          <div
            title={tx("Customer reaction", "تفاعل العميل")}
            aria-label={tx(`Customer reacted ${m.reaction}`, `تفاعل العميل ${m.reaction}`)}
            style={{
              display: "flex",
              justifyContent: isOut ? "flex-end" : "flex-start",
              marginTop: -8,
              paddingInline: 10,
              position: "relative",
            }}
          >
            <span
              style={{
                fontSize: 14,
                lineHeight: 1,
                padding: "2px 6px",
                borderRadius: 999,
                background: "var(--bg-elev)",
                border: "1px solid var(--line)",
                boxShadow: "var(--ix-shadow)",
              }}
            >
              {m.reaction}
            </span>
          </div>
        )}
        <div
          style={{
            fontSize: 10.5,
            color: "var(--ink-4)",
            marginTop: 5,
            textAlign: isOut ? "end" : "start",
          }}
        >
          {timeLabel}
          {isOut && <DeliveryTicks status={m.deliveryStatus ?? undefined} />}
        </div>
      </div>
    </div>
  );
}

function ConversationPane({
  conv,
  contactById,
  onSend,
  onSendTemplate,
  threadView,
  onThreadView,
  sending,
  sendError,
  channel,
  multiNumber,
  numberLabel,
  onConvertToTicket,
  onConversationChanged,
  messagesLoading,
  lang,
  tx,
}: ConversationPaneProps) {
  const contact = contactById.get(conv.contactId);
  const { user } = useAuth();
  // Every send path (text, media, template) is POST .../messages|send|send-template,
  // all mapped to conversations.create on the backend.
  const { can } = usePermissions();
  const canCompose = can("conversations.create");
  const canViewAds = can("reports.view");
  const noPermCompose = tx(NO_PERMISSION_EN, NO_PERMISSION_AR);
  const [draft, setDraft] = useState<string>("");
  // SP-18 "Copy to reply box": a copilot draft for this conversation fills the composer (never sends).
  useEffect(() => {
    const take = () => {
      const text = takeReplyDraft(conv.id);
      if (text !== null) setDraft(text);
    };
    take();
    const onOffer = (e: Event) => {
      if ((e as CustomEvent<{ conversationId?: string }>).detail?.conversationId === conv.id) take();
    };
    window.addEventListener(REPLY_DRAFT_EVENT, onOffer);
    return () => window.removeEventListener(REPLY_DRAFT_EVENT, onOffer);
  }, [conv.id]);
  const [attachedMedia, setAttachedMedia] = useState<Media | null>(null);
  const [pickerOpen, setPickerOpen] = useState<boolean>(false);
  const [templatePickerOpen, setTemplatePickerOpen] = useState<boolean>(false);
  const [attachUploading, setAttachUploading] = useState<boolean>(false);
  const [attachError, setAttachError] = useState<string | null>(null);

  /** Upload a file straight into the composer's attachment slot — used by the
   *  paste handler so a screenshot never has to be saved to disk first. */
  const attachDirect = async (file: File) => {
    setAttachUploading(true);
    setAttachError(null);
    try {
      setAttachedMedia(await uploadMedia(file));
    } catch (e) {
      setAttachError(mediaErrorText(e, tx, tx("Upload failed", "فشل الرفع")));
    } finally {
      setAttachUploading(false);
    }
  };

  // WhatsApp 24-hour customer-service window. Backend computes `waWindowOpen`
  // on the conversation payload (true when the last inbound message landed
  // within 24h). Outside the window, free-form text/image sends are blocked
  // by Meta — only approved templates work.
  const isWhatsApp = conv.channel === "whatsapp";
  const waWindowOpen = conv.waWindowOpen !== false;
  const waBlocked = isWhatsApp && !waWindowOpen;
  // SP-19: a disconnected channel keeps its history but cannot send.
  const channelDown = channel?.status === "disconnected";
  const numberName = numberLabel || (channel ? channel.displayName || channel.phoneNumber || "" : "");
  const channelDownText = tx(
    "This channel is disconnected. Reconnect it to send replies.",
    "هذه القناة مفصولة. أعد ربطها لإرسال الردود.",
  );

  // Auto-scroll the thread to the latest message — but only when the user is
  // already near the bottom. Standard chat UX: if they've scrolled up to
  // read history, a new inbound shouldn't yank them back down.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const wasAtBottomRef = useRef<boolean>(true);
  const prevConvIdRef = useRef<string | null>(null);

  // Only ever render real messages. This used to fall back to a fabricated
  // three-message thread (customer line, an "ai" reply, then "Thanks!") when
  // the real ones came back empty — demo scaffolding that rendered on top of
  // live customer conversations and read as though the AI had answered them.
  const messages: Message[] = conv.messages;
  // The stitched customer thread needs DB conversations; live FB/IG threads have no contact thread.
  const canStitch = !isLiveThreadId(conv.id) && !!conv.contactId;
  const showAll = threadView === "all" && canStitch;
  const saved = useSavedReplies({
    draft,
    setDraft,
    lang,
    tx,
    disabled: !canCompose || waBlocked || channelDown,
  });

  // Internal notes for this thread, shown inline between the messages. Same URL
  // as the NotesPanel composer below, so React Query shares the cache and a new
  // note appears here after the panel's refetch.
  const threadNotesQ = useFetch<Note[]>(
    conv.id ? `/notes?conversationId=${encodeURIComponent(conv.id)}` : null,
  );
  const teamQ = useFetch<TeamMember[]>("/team");
  const authorName = (id: string | null) =>
    id ? (teamQ.data ?? []).find((m) => m.id === id)?.name : undefined;
  const threadNotes = useMemo(
    () => (threadNotesQ.data ?? []).flatMap((n) => [n, ...(n.replies ?? [])]),
    [threadNotesQ.data],
  );
  const timeline = useMemo(() => mergeByTime(messages, threadNotes), [messages, threadNotes]);

  const handleSend = () => {
    if (!canCompose) return;
    const body = draft.trim();
    // Allow sending if there's text OR an image attachment.
    if (!body && !attachedMedia) return;
    if (sending) return;
    onSend(body, attachedMedia?.id)
      .then(() => {
        setDraft("");
        setAttachedMedia(null);
      })
      .catch(() => {
        // error surfaced via sendError
      });
  };

  // Snap to bottom whenever messages change AND the user was at the bottom
  // before the update. Always snap when the conversation itself changes
  // (clicking a different thread should land on the latest message).
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const convChanged = prevConvIdRef.current !== conv.id;
    if (convChanged) {
      prevConvIdRef.current = conv.id;
      // Wait a frame so newly-rendered messages have height before we scroll.
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
      wasAtBottomRef.current = true;
      return;
    }
    if (wasAtBottomRef.current) {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    }
  }, [conv.id, messages.length]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        background: "var(--bg)",
      }}
    >
      <div
        style={{
          minHeight: 64,
          padding: "10px 20px",
          borderBottom: "1px solid var(--line-soft)",
          background: "var(--bg-1)",
          display: "flex",
          alignItems: "center",
          gap: 13,
        }}
      >
        <div style={{ position: "relative", flex: "0 0 auto" }}>
          <Avatar name={contact?.name} color="200" size="lg" />
          <span
            style={{
              position: "absolute",
              insetInlineEnd: -2,
              bottom: -2,
              display: "inline-flex",
            }}
          >
            <ChannelMark channel={conv.channel} size={14} />
          </span>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
            <span className="ix-display" style={{ fontWeight: 700, fontSize: 16.5 }}>
              {contact?.name}
            </span>
            <span
              className="ix-chpill"
              style={{ background: CHANNEL_DOT[conv.channel] }}
            >
              {CHANNEL_LABEL[conv.channel]}
            </span>
            {multiNumber && numberName && (
              <span className="ix-chpill" dir="auto" style={{ background: "var(--bg-elev)", color: "var(--ink-2)", border: "1px solid var(--line-soft)" }}>
                {numberName}
              </span>
            )}
            <ResolutionBadge conv={conv} lang={lang} />
            <span className="ix-online">
              <span className="dot" />
              {tx("Online", "متصل")}
            </span>
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--ink-3)",
              display: "flex",
              gap: 6,
              marginTop: 3,
            }}
          >
            <span>{contact?.phone}</span>
            <span>·</span>
            <span>{contact?.industry}</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {canStitch && (
            <div
              role="group"
              aria-label={tx("Thread view", "عرض المحادثة")}
              style={{ display: "inline-flex", border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }}
            >
              {(
                [
                  ["conv", tx("This conversation", "هذه المحادثة")],
                  ["all", tx("All conversations", "كل المحادثات")],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  className="btn sm"
                  aria-pressed={(showAll ? "all" : "conv") === v}
                  onClick={() => onThreadView(v)}
                  style={{
                    borderRadius: 0,
                    border: 0,
                    background: (showAll ? "all" : "conv") === v ? "var(--accent-soft)" : "transparent",
                    color: (showAll ? "all" : "conv") === v ? "var(--accent)" : undefined,
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <ConversationAiToggle
            conversationId={conv.id}
            enabled={conv.aiEnabled ?? false}
            pausedAt={conv.aiPausedAt ?? null}
            lang={lang}
          />
          <ConversationActions key={conv.id} conv={conv} lang={lang} onChanged={onConversationChanged} />
          <button className="btn" onClick={onConvertToTicket}>
            <IconCheck w={13} />
            {tx("Convert to ticket", "إلى تذكرة")}
          </button>
          <ConversationTicketsPill
            conversationId={conv.id}
            lang={lang}
            onClick={(t) => {
              window.location.hash = `#/pipeline?open=${encodeURIComponent(t.id)}`;
            }}
          />
          <AddToPipelineButton
            conversationId={conv.id}
            contactName={contactById.get(conv.contactId)?.name ?? ""}
            intent={conv.intent}
            preview={conv.preview}
            lang={lang}
          />
          <button className="btn ghost icon">
            <IconMore w={16} />
          </button>
        </div>
      </div>
      {conv.adSource && (
        <AdAttributionCard ad={conv.adSource} referredAt={conv.adReferredAt} canOpen={canViewAds} tx={tx} lang={lang} />
      )}

      <div
        ref={scrollerRef}
        onScroll={(e) => {
          const t = e.currentTarget;
          // Treat anything within 60px of bottom as "at bottom" so the
          // auto-snap still kicks in if the user is barely above it.
          wasAtBottomRef.current =
            t.scrollHeight - t.scrollTop - t.clientHeight < 60;
        }}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "26px 30px",
          display: "flex",
          flexDirection: "column",
          gap: 14,
          backgroundImage: "radial-gradient(circle, var(--line-soft) 1px, transparent 1px)",
          backgroundSize: "22px 22px",
          backgroundPosition: "0 0",
        }}
      >
        {showAll ? (
          <CustomerThread
            contactId={conv.contactId}
            lang={lang}
            tx={tx}
            scrollerRef={scrollerRef}
            refreshToken={`${conv.updatedAt ?? ""}|${messages.length}`}
            renderMessage={(m) => <Bubble m={m} />}
            dayLabel={(iso) => dayLabel(iso, lang, tx)}
            onChanged={() => void onConversationChanged()}
          />
        ) : messagesLoading && messages.length === 0 ? (
          <div
            aria-label={tx("Loading messages", "جارٍ تحميل الرسائل")}
            style={{ display: "flex", flexDirection: "column", gap: 4, paddingTop: 8 }}
          >
            <MessageSkeleton side="left" />
            <MessageSkeleton side="right" />
            <MessageSkeleton side="left" />
            <MessageSkeleton side="right" />
            <MessageSkeleton side="left" />
          </div>
        ) : messages.length === 0 ? (
          <div
            className="muted"
            style={{ textAlign: "center", fontSize: 12, padding: "24px 0" }}
          >
            {tx("No messages in this thread yet.", "لا توجد رسائل في هذه المحادثة بعد.")}
          </div>
        ) : (
          timeline.map((m, i) => {
            const label = m.createdAt ? dayLabel(m.createdAt, lang, tx) : "";
            const prev = i > 0 ? timeline[i - 1] : null;
            const prevLabel = prev?.createdAt ? dayLabel(prev.createdAt, lang, tx) : "";
            const isNote = "authorUserId" in m;
            return (
              <Fragment key={isNote ? `note-${m.id}` : `msg-${m.metaMessageId ?? `${m.createdAt ?? ""}|${m.from}|${i}`}`}>
                {label && label !== prevLabel && (
                  <div className="day-divider">
                    <span>{label}</span>
                  </div>
                )}
                {isNote ? (
                  <InlineNote
                    note={m}
                    isOwn={!!user && m.authorUserId === (user as { id?: string }).id}
                    authorName={authorName(m.authorUserId)}
                    label={tx("Internal note", "ملاحظة داخلية")}
                    timeLabel={m.createdAt ? new Date(m.createdAt).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" }) : ""}
                  />
                ) : (
                  <Bubble m={m} />
                )}
              </Fragment>
            );
          })
        )}
      </div>

      <details style={{ borderTop: "1px solid var(--line-soft)", background: "var(--bg-1)" }}>
        <summary
          style={{
            padding: "8px 18px",
            cursor: "pointer",
            fontSize: 12,
            color: "var(--ink-2)",
            display: "flex",
            alignItems: "center",
            gap: 6,
            userSelect: "none",
          }}
        >
          <IconBook w={12} />
          {tx("Internal notes for this thread", "ملاحظات داخلية لهذه المحادثة")}
        </summary>
        <div style={{ padding: "8px 18px 12px" }}>
          <NotesPanel
            contactId={conv.contactId}
            conversationId={conv.id}
            scope="conversation"
          />
        </div>
      </details>

      <div style={{ padding: "12px 18px 16px", borderTop: "1px solid var(--line-soft)" }}>
        {!waBlocked && saved.strip}
        {saved.slashMenu}
        <div className="ix-composer">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (waBlocked || !canCompose) return;
              if (saved.onKeyDown(e)) return;
              // Enter sends, Shift+Enter inserts a newline (standard chat UX).
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                handleSend();
              }
            }}
            onPaste={(e) => {
              if (waBlocked || !canCompose) return;
              // Screenshots and copied images arrive as clipboard FILES; upload
              // straight to the attachment slot. Anything else (text, HTML)
              // falls through to the browser's normal paste.
              const img = Array.from(e.clipboardData?.files ?? []).find((f) =>
                f.type.startsWith("image/"),
              );
              if (!img) return;
              e.preventDefault();
              void attachDirect(img);
            }}
            disabled={waBlocked || !canCompose}
            title={canCompose ? undefined : noPermCompose}
            placeholder={
              !canCompose
                ? noPermCompose
                : waBlocked
                ? tx(
                    "Pick a template above to message outside the 24h window.",
                    "اختر قالبًا أعلاه للمراسلة خارج نافذة الـ٢٤ ساعة.",
                  )
                : tx("Type a reply…", "اكتب ردًّا…")
            }
            style={{
              width: "100%",
              minHeight: 60,
              resize: "none",
              border: 0,
              outline: 0,
              background: "transparent",
              color: "inherit",
              fontSize: 14,
              fontFamily: "inherit",
            }}
          />
          {channelDown && (
            <div role="status" style={{ fontSize: 12, color: "var(--warn)", marginTop: 4 }}>
              {channelDownText}
            </div>
          )}
          {sendError && (
            <div
              style={{
                fontSize: 11,
                color: "var(--bad)",
                marginTop: 4,
                fontFamily: "var(--font-mono)",
              }}
            >
              {sendError}
            </div>
          )}
          {waBlocked && (
            <div
              style={{
                marginTop: 6,
                padding: "10px 12px",
                borderRadius: 8,
                background: "color-mix(in oklch, var(--warn) 10%, transparent)",
                border: "1px solid color-mix(in oklch, var(--warn) 35%, transparent)",
                color: "var(--ink-1)",
                fontSize: 12,
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <span style={{ color: "var(--warn)", fontSize: 14 }}>⚠</span>
              <div style={{ flex: 1, minWidth: 0, lineHeight: 1.4 }}>
                <strong>
                  {tx(
                    "Outside the 24-hour window",
                    "خارج نافذة الـ٢٤ ساعة",
                  )}
                </strong>
                <div style={{ color: "var(--ink-2)", fontSize: 11, marginTop: 2 }}>
                  {tx(
                    "WhatsApp only allows pre-approved templates after 24h since the last customer message.",
                    "واتساب يسمح فقط بالقوالب المعتمدة بعد مرور ٢٤ ساعة على آخر رسالة من العميل.",
                  )}
                </div>
              </div>
              <button
                type="button"
                className="btn primary sm"
                onClick={() => setTemplatePickerOpen(true)}
                disabled={!canCompose}
                title={canCompose ? undefined : noPermCompose}
              >
                {tx("Use template", "استخدم قالبًا")}
              </button>
            </div>
          )}
          {attachUploading && (
            <div
              className="mono"
              style={{
                marginTop: 6,
                fontSize: 11,
                color: "var(--ink-3)",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  border: "2px solid currentColor",
                  borderRightColor: "transparent",
                  display: "inline-block",
                  animation: "aram-spin 0.7s linear infinite",
                }}
              />
              {tx("Uploading pasted image…", "جارٍ تحميل الصورة الملصقة…")}
            </div>
          )}
          {attachError && (
            <div
              style={{
                fontSize: 11,
                color: "var(--bad)",
                marginTop: 4,
                fontFamily: "var(--font-mono)",
              }}
            >
              {attachError}
            </div>
          )}
          {attachedMedia && (
            <AttachmentPreview
              media={attachedMedia}
              onRemove={() => {
                setAttachedMedia(null);
                setAttachError(null);
              }}
              label={tx("Attached", "مرفق")}
            />
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
            <button
              type="button"
              className="btn ghost icon sm"
              onClick={() => setPickerOpen(true)}
              disabled={!canCompose}
              title={canCompose ? tx("Attach image", "إرفاق صورة") : noPermCompose}
              aria-label={tx("Attach image", "إرفاق صورة")}
              style={{
                color: attachedMedia ? "var(--accent)" : undefined,
              }}
            >
              <IconAttach w={14} />
            </button>
            {supportsTemplates(conv) && (
              <button className="btn ghost icon sm" aria-label={tx("Template", "قالب")}>
                <IconTemplate w={14} />
              </button>
            )}
            <span
              className="muted mono"
              style={{ fontSize: 11, marginInlineStart: "auto" }}
            >
              {multiNumber && numberName && (
                <>
                  {tx("Replying from", "الرد من")}{" "}
                  <strong dir="auto" style={{ color: "var(--ink-1)" }}>{numberName}</strong>
                  {" · "}
                </>
              )}
              {tx("Replying as", "يرد بصفة")}:{" "}
              <strong style={{ color: "var(--ink-1)" }}>
                {user?.name ?? tx("you", "أنت")}
              </strong>
            </span>
            <button
              className="btn primary"
              onClick={handleSend}
              title={canCompose ? undefined : noPermCompose}
              disabled={
                !canCompose ||
                sending ||
                waBlocked ||
                channelDown ||
                (draft.trim().length === 0 && !attachedMedia)
              }
              aria-busy={sending}
            >
              {sending ? (
                <span
                  className="spinner"
                  aria-hidden="true"
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: "50%",
                    border: "2px solid currentColor",
                    borderRightColor: "transparent",
                    display: "inline-block",
                    animation: "aram-spin 0.7s linear infinite",
                  }}
                />
              ) : (
                <IconSend w={13} />
              )}
              {sending ? tx("Sending…", "جارٍ الإرسال…") : tx("Send", "إرسال")}
            </button>
          </div>
        </div>
      </div>

      <style>{`
        .day-divider { display: flex; align-items: center; gap: 12px; margin: 4px 0; }
        .day-divider::before, .day-divider::after { content: ""; flex: 1; height: 1px; background: var(--line-soft); }
        .day-divider span { font-family: var(--font-mono); font-size: 11px; color: var(--ink-3); padding: 2px 10px;
          border: 1px solid var(--line-soft); border-radius: 999px; background: var(--bg-elev); }
        @keyframes aram-spin { to { transform: rotate(360deg); } }
      `}</style>

      <MediaPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(m) => setAttachedMedia(m)}
      />

      {isWhatsApp && (
        <TemplateSendDialog
          open={templatePickerOpen}
          onClose={() => setTemplatePickerOpen(false)}
          onSend={async (name, language, variables, header) => {
            await onSendTemplate(name, language, variables, header);
            setTemplatePickerOpen(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * Renders a message attachment. The `value` field is either:
 *  - an absolute URL (legacy / inbound media from Graph) → use directly
 *  - our internal Media id (outbound sends from the composer) → load via
 *    /api/media/:id/file with the bearer token attached
 */
function DeliveryTicks({ status }: { status?: string }) {
  // Render the WhatsApp-style check progression.
  //   sent      → single grey ✓
  //   delivered → grey ✓✓
  //   read      → blue ✓✓
  //   failed    → red ⚠
  //   (unknown) → single grey ✓ (assume sent if outbound)
  if (status === "failed") {
    return (
      <span
        style={{ marginInlineStart: 6, color: "var(--bad)" }}
        title="Failed"
      >
        ⚠
      </span>
    );
  }
  if (status === "read") {
    return (
      <span
        style={{ marginInlineStart: 6, color: "#34B7F1" }}
        title="Read"
      >
        ✓✓
      </span>
    );
  }
  if (status === "delivered") {
    return (
      <span style={{ marginInlineStart: 6 }} title="Delivered">
        ✓✓
      </span>
    );
  }
  return (
    <span style={{ marginInlineStart: 6 }} title="Sent">
      ✓
    </span>
  );
}

/**
 * Full-screen viewer for an attachment. Click the backdrop or press Escape to
 * close; the image itself is click-through-safe so tapping it doesn't dismiss.
 */
function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // Don't let the thread scroll behind the overlay.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Attachment preview"
      style={{
        position: "fixed",
        inset: 0,
        background: "oklch(0 0 0 / 0.82)",
        display: "grid",
        placeItems: "center",
        zIndex: 2147483646,
        padding: 32,
        cursor: "zoom-out",
      }}
    >
      <img
        src={src}
        alt="attachment"
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: "100%",
          maxHeight: "100%",
          objectFit: "contain",
          borderRadius: 8,
          cursor: "default",
        }}
      />
      <button
        type="button"
        className="btn ghost icon"
        onClick={onClose}
        aria-label="Close"
        style={{ position: "fixed", top: 16, insetInlineEnd: 16, color: "#fff" }}
      >
        <IconX w={18} />
      </button>
    </div>
  );
}

function MessageAttachment({ value }: { value: string }) {
  const [zoomed, setZoomed] = useState<boolean>(false);
  const isUrl = /^https?:\/\//i.test(value);
  if (isUrl) {
    return (
      <div style={{ marginTop: 6 }}>
        <img
          src={value}
          alt="attachment"
          onClick={() => setZoomed(true)}
          style={{
            maxWidth: 260,
            maxHeight: 260,
            borderRadius: 8,
            display: "block",
            cursor: "zoom-in",
          }}
        />
        {zoomed && <Lightbox src={value} onClose={() => setZoomed(false)} />}
      </div>
    );
  }
  // Treat as media id.
  const base = API_BASE;
  const token = tokenStore.get();
  return (
    <div style={{ marginTop: 6 }}>
      <InboxMediaImage
        url={`${base}/media/${value}/file`}
        token={token}
        alt="attachment"
      />
    </div>
  );
}

function InboxMediaImage({
  url,
  token,
  alt,
}: {
  url: string;
  token: string | null;
  alt: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState<boolean>(false);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((b) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(b);
        setSrc(objectUrl);
      })
      .catch(() => {
        /* leave null */
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, token]);
  if (!src) {
    return (
      <div
        className="mono muted pulse"
        style={{
          width: 160,
          height: 120,
          background: "var(--bg-2)",
          borderRadius: 8,
          display: "grid",
          placeItems: "center",
          fontSize: 10,
        }}
      >
        …
      </div>
    );
  }
  return (
    <>
      <img
        src={src}
        alt={alt}
        onClick={() => setZoomed(true)}
        style={{
          maxWidth: 260,
          maxHeight: 260,
          borderRadius: 8,
          display: "block",
          cursor: "zoom-in",
        }}
      />
      {zoomed && <Lightbox src={src} onClose={() => setZoomed(false)} />}
    </>
  );
}

function AttachmentPreview({
  media,
  onRemove,
  label,
}: {
  media: Media;
  onRemove: () => void;
  label: string;
}) {
  const base = API_BASE;
  const token = tokenStore.get();
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    fetch(`${base}/media/${media.id}/file`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((b) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(b);
        setSrc(objectUrl);
      })
      .catch(() => {
        /* leave src null */
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [base, media.id, token]);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginTop: 6,
        padding: "6px 8px 6px 6px",
        border: "1px solid var(--accent-ring)",
        background: "var(--accent-soft)",
        borderRadius: 8,
        alignSelf: "flex-start",
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          background: "var(--bg-2)",
          borderRadius: 6,
          overflow: "hidden",
          display: "grid",
          placeItems: "center",
          flex: "0 0 auto",
        }}
      >
        {src ? (
          <img
            src={src}
            alt={media.fileName}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          <span className="mono muted" style={{ fontSize: 9 }}>…</span>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0, fontSize: 11 }}>
        <div
          className="mono"
          style={{
            color: "var(--accent)",
            fontSize: 9,
            textTransform: "uppercase",
            letterSpacing: 0.06,
          }}
        >
          {label}
        </div>
        <div
          style={{
            color: "var(--ink-1)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: 200,
          }}
          title={media.fileName}
        >
          {media.fileName}
        </div>
      </div>
      <button
        type="button"
        className="btn ghost icon sm"
        onClick={onRemove}
        aria-label="Remove attachment"
        style={{ color: "var(--ink-2)" }}
      >
        <IconX w={11} />
      </button>
    </div>
  );
}

const SectionLabel = ({ children }: { children: ReactNode }) => (
  <div
    style={{
      fontSize: 10,
      fontFamily: "var(--font-mono)",
      textTransform: "uppercase",
      letterSpacing: 0.08,
      color: "var(--ink-3)",
    }}
  >
    {children}
  </div>
);

function ContactRightRail({ conv, contactById, onContactsChanged, tx }: ContactRightRailProps) {
  const contact = contactById.get(conv.contactId);
  const { t: tweaks } = useTweaks();
  const lang = tweaks.lang;

  const lifecycleStages: string[] = [
    tx("Lead", "عميل محتمل"),
    tx("Qualified", "مؤهل"),
    tx("Customer", "عميل"),
    tx("Repeat", "متكرر"),
  ];

  return (
    <aside
      style={{
        borderInlineStart: "1px solid var(--line-soft)",
        background: "var(--bg-1)",
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        padding: 18,
        gap: 18,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
          gap: 8,
        }}
      >
        <Avatar name={contact?.name} color="200" size="xl" />
        <div className="ix-display" style={{ fontSize: 18, fontWeight: 700 }}>
          {contact?.name}
        </div>
        <div
          style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--ink-3)" }}
        >
          {contact?.phone}
        </div>
        {contact && (
          <div style={{ width: "100%" }}>
            <TagEditor
              contactId={contact.id}
              current={contact.tags}
              onChanged={onContactsChanged}
              tx={tx}
            />
          </div>
        )}
      </div>

      <button className="btn" style={{ width: "100%" }}>
        <IconPhone w={13} />
        {tx("Call", "اتصال")}
      </button>

      <div>
        <SectionLabel>{tx("Notes", "الملاحظات")}</SectionLabel>
        <div style={{ marginTop: 8 }}>
          <NotesPanel contactId={contact?.id} scope="contact" />
        </div>
      </div>

      <div>
        <SectionLabel>{tx("Lifecycle", "المرحلة")}</SectionLabel>
        <div style={{ display: "flex", gap: 4, marginTop: 10 }}>
          {lifecycleStages.map((s, i) => (
            <div key={s} className={`ix-stage-seg ${i <= 2 ? "on" : ""}`.trim()} title={s} />
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 7 }}>
          <span style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{lifecycleStages[0]}</span>
          <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--accent)" }}>
            {lifecycleStages[2]}
          </span>
          <span style={{ fontSize: 10.5, color: "var(--ink-4)" }}>
            {lifecycleStages[lifecycleStages.length - 1]}
          </span>
        </div>
      </div>

      {contact && contact.industry !== "facebook-dm" && (
        <LinkedItemsCard contactId={contact.id} lang={lang} tx={tx} />
      )}

      <TopicsCard topics={conv.topics} painPoints={conv.painPoints} tx={tx} />

      <div>
        <SectionLabel>{tx("Internal notes", "ملاحظات داخلية")}</SectionLabel>
        <div
          style={{
            marginTop: 8,
            padding: 12,
            borderRadius: 10,
            background: "var(--bg-2)",
            border: "1px dashed var(--line-soft)",
            fontSize: 12,
            color: "var(--ink-3)",
            textAlign: "center",
          }}
        >
          {tx("No notes yet", "لا توجد ملاحظات")}
        </div>
      </div>
    </aside>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function fmtCompact(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days < 1) {
    const hours = Math.floor((Date.now() - t) / 3_600_000);
    if (hours < 1) {
      const mins = Math.max(1, Math.floor((Date.now() - t) / 60_000));
      return `${mins}m`;
    }
    return `${hours}h`;
  }
  if (days < 7) return `${days}d`;
  if (days < 365) return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short" });
}

// ─── Live Facebook Messenger types ────────────────────────────────────────
interface FbStatus {
  connected: boolean;
  pageId?: string;
  pageName?: string;
}
interface FbConv {
  id: string;             // "t_..." — FB conversation thread id
  contactId?: string;     // local DB Contact id (cuid), for joining with notes/tags
  contactPsid?: string;   // FB Page-Scoped ID of the OTHER participant — use for /messages sends
  contactName: string;
  snippet: string;
  unread: number;
  messageCount: number;
  updatedAt: string;
}
interface FbMsg {
  id: string;
  from: "page" | "them";
  authorName: string;
  body: string;
  attachmentUrl?: string;
  at: string;
}
const isFbConvId = (id: string | null | undefined): boolean =>
  typeof id === "string" && id.startsWith("t_");
const isIgConvId = (id: string | null | undefined): boolean =>
  typeof id === "string" && id.startsWith("ig:");
// Strip the `ig:` prefix the backend stamps on IG conv ids so we can call
// /integrations/instagram/conversations/:id with Graph's raw thread id.
const stripIgPrefix = (id: string): string =>
  id.startsWith("ig:") ? id.slice(3) : id;

interface IgConv {
  id: string;                // "ig:t_..." — prefixed by backend
  contactId?: string;        // local DB Contact id
  contactIgsid?: string;     // IG-scoped id of the OTHER participant — used for sends
  contactName: string;
  snippet: string;
  unread: number;
  messageCount: number;
  updatedAt: string;
}
interface IgMsg {
  id: string;
  from: "page" | "them";
  authorName: string;
  body: string;
  at: string;
}

/** 409 channels.disconnected / not_connected: the channel's state changed under us. */
const isChannelStateError = (e: unknown): boolean =>
  e instanceof ApiError && e.status === 409 &&
  [e.message, e.code].some((k) => k === "channels.disconnected" || k === "channels.not_connected");

function InboxImpl() {
  const qc = useQueryClient();
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { user } = useAuth();
  const [filter, setFilterState] = useState<InboxFilter>(() =>
    readFilterFromHash(window.location.hash),
  );
  const [sort, setSort] = useState<InboxSort>("recent");
  // Active number tab (channel id) lives in the hash as `n=`; null = All numbers.
  const [numberTab, setNumberTabState] = useState<string | null>(() =>
    readNumberFromHash(window.location.hash),
  );
  const setNumberTab = (id: string | null) => {
    setNumberTabState(id);
    const next = writeNumberToHash(window.location.hash, id);
    if (next !== window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search + next);
    }
  };
  // Persist the filter in the hash query without triggering hash navigation.
  const setFilter = (f: InboxFilter) => {
    setFilterState(f);
    const next = writeFilterToHash(window.location.hash, f);
    if (next !== window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search + next);
    }
  };
  const [view, setViewState] = useState<InboxView>(() => readViewFromHash(window.location.hash));
  const setView = (v: InboxView) => {
    setViewState(v);
    const next = writeViewToHash(window.location.hash, v);
    if (next !== window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search + next);
    }
  };
  // "This conversation" vs the customer's stitched thread; kept in the hash as `?tv=all`.
  const [threadView, setThreadViewState] = useState<"conv" | "all">(() =>
    getHashParam(window.location.hash, "tv") === "all" ? "all" : "conv",
  );
  const setThreadView = (v: "conv" | "all") => {
    setThreadViewState(v);
    const next = setHashParam(window.location.hash, "tv", v === "all" ? "all" : null);
    if (next !== window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search + next);
    }
  };
  const [search, setSearch] = useState<string>("");
  // A notification deep link is read synchronously so auto-select never overrides it.
  const [activeId, setActiveId] = useState<string | null>(() =>
    openParamForRoute(window.location.hash, "inbox"),
  );
  // Deep link from a notification: `#/inbox?open=<conversationId>`.
  useOpenParam("inbox", setActiveId);
  // A hidden (preloaded) embed must not auto-select or mark anything read.
  const embedVisible = useEmbedVisible();
  const [channels, setChannels] = useState<Set<ConvChannel>>(
    () => new Set<ConvChannel>(CHANNELS),
  );
  const [messageVersion, setMessageVersion] = useState<number>(0);
  // Optimistic "pending" bubbles for messages we've just sent on FB/IG live
  // threads. Lets the new bubble appear instantly without forcing a refetch
  // of the whole thread. Cleared when the next poll lands a matching body,
  // or after a short safety TTL if Graph drops it.
  const [pendingByConv, setPendingByConv] = useState<
    Record<string, { id: string; body: string; at: number }[]>
  >({});
  const [showConvertModal, setShowConvertModal] = useState<boolean>(false);
  const [ticketBanner, setTicketBanner] = useState<{ number: number; visible: boolean } | null>(
    null,
  );

  // ─── Data ──────────────────────────────────────────────────────────────
  // Realtime push (socket.io) keeps the inbox in sync; the polls below are a
  // slow safety net for missed events (network blip, server restart).
  // The Number filter narrows server-side via repeatable ?channelId=; the tab
  // is applied client-side so every tab keeps its count.
  const convsPath = filter.channelIds.length
    ? `/conversations?${filter.channelIds.map((id) => `channelId=${encodeURIComponent(id)}`).join("&")}`
    : "/conversations";
  const convsQ = useFetch<Conversation[]>(convsPath, { pollMs: 30000 });
  // m4: list only (no limits / signup config), and only for channels.view.
  const canViewChannels = usePermissions().can("channels.view");
  const channelsQ = useChannelsList(canViewChannels);
  const channelList = channelsQ.data ?? [];
  const channelById = useMemo(() => new Map(channelList.map((c) => [c.id, c])), [channelList]);
  const contactsQ = useFetch<Contact[]>("/contacts");

  // Live Facebook Messenger: only fetch when integration is connected.
  const fbStatusQ = useFetch<FbStatus>("/integrations/facebook/status");
  const fbConnected = fbStatusQ.data?.connected === true;
  const fbConvsQ = useFetch<FbConv[]>(
    fbConnected ? "/integrations/facebook/conversations" : null,
    { pollMs: 30000 },
  );
  const fbMsgsQ = useFetch<FbMsg[]>(
    fbConnected && isFbConvId(activeId)
      ? `/integrations/facebook/conversations/${activeId}/messages`
      : null,
    { key: `${activeId ?? "none"}:${messageVersion}`, pollMs: 30000 },
  );

  // Internal active query: skip when activeId is a Facebook OR Instagram
  // live thread id (those have their own per-platform messages query).
  const activeQ = useFetch<ConversationDetail>(
    activeId && !isFbConvId(activeId) && !isIgConvId(activeId)
      ? `/conversations/${activeId}`
      : null,
    { key: `${activeId ?? "none"}:${messageVersion}`, pollMs: 30000 },
  );

  // Live Instagram (mirrors the FB pattern). The realtime push handles the
  // common case; this poll is a safety net.
  const igStatusQ = useFetch<{ connected?: boolean }>(
    "/integrations/instagram/status",
    { pollMs: 60000 },
  );
  const igConnected = igStatusQ.data?.connected === true;
  const igConvsQ = useFetch<IgConv[]>(
    igConnected ? "/integrations/instagram/conversations" : null,
    { pollMs: 30000 },
  );
  const igMsgsQ = useFetch<IgMsg[]>(
    igConnected && isIgConvId(activeId)
      ? `/integrations/instagram/conversations/${stripIgPrefix(activeId!)}/messages`
      : null,
    { key: `${activeId ?? "none"}:${messageVersion}`, pollMs: 30000 },
  );

  // FB/IG/WhatsApp threads are all DB-backed now: the Zernio webhook persists
  // every inbound and a one-time backfill imported the pre-webhook history, so
  // the Inbox no longer proxies Zernio's API live per thread. This status
  // query only tells handleSend which channels reply via Zernio.
  const zernioStatusQ = useFetch<{ accounts?: { platform: string }[] }>(
    "/integrations/zernio/status",
    { pollMs: 60000 },
  );

  // Hold the list behind one skeleton until every connected channel's FIRST
  // load settles, so WhatsApp/Facebook/Instagram rows appear together instead
  // of popping in one channel at a time. "Settled" = has data or failed —
  // `data` stays non-null across background polls, so polls never re-trip it.
  const settled = (q: { data: unknown; error: string | null }) =>
    q.data !== null || q.error !== null;
  const initialLoading =
    !settled(convsQ) ||
    !settled(fbStatusQ) ||
    (fbConnected && !settled(fbConvsQ)) ||
    !settled(igStatusQ) ||
    (igConnected && !settled(igConvsQ));

  // Backend emits `inbox.activity` whenever a message lands or a conversation
  // changes (WhatsApp webhook, Meta webhook, REST send/update). Each event
  // refetches the affected list and bumps `messageVersion` so the active
  // thread re-queries. activeId/conversationId routing keeps refetches scoped.
  useRealtime<{ channel: string; conversationId?: string; channelId?: string | null }>(
    "inbox.activity",
    (evt) => {
      // All channels are DB-backed, so the event's conversationId is our own
      // row id — bump the thread query when it's the one on screen.
      const affectsActive =
        (!!evt.conversationId && activeId === evt.conversationId) ||
        (evt.channel === "facebook" && isFbConvId(activeId)) ||
        (evt.channel === "instagram" && isIgConvId(activeId));
      if (affectsActive) setMessageVersion((v) => v + 1);
      if (evt.channel === "facebook" && fbConnected) fbConvsQ.refetch();
      if (evt.channel === "instagram" && igConnected) igConvsQ.refetch();
      // channelId (SP-19) only scopes which number's list changed; every
      // list the viewer can see is one query, so a single refetch covers it.
      convsQ.refetch();
      if (evt.channelId && !channelById.has(evt.channelId)) channelsQ.refetch();
    },
  );

  // Conversations come from two sources:
  //   1. /conversations — DB rows (WhatsApp webhooks + Instagram sync + any future
  //      channel that writes to the DB).
  //   2. /integrations/facebook/conversations — Facebook DMs fetched LIVE from
  //      Graph API (not persisted to DB yet).
  // We MERGE them so all channels appear in the unified list.
  const conversations: Conversation[] = useMemo(() => {
    // DB rows are authoritative for every channel: the Zernio webhook persists
    // all inbound and the backfill imported prior history. Drop FB/IG DB rows
    // only while the LEGACY Meta live paths are connected (rollback mode), so
    // the same thread can't appear twice.
    const dbRows = (convsQ.data ?? []).filter(
      (c) =>
        !(fbConnected && c.channel === "facebook") &&
        !(igConnected && c.channel === "instagram"),
    );

    const fbRows: Conversation[] = fbConnected
      ? (fbConvsQ.data ?? []).map((c) => ({
          id: c.id,
          contactId: c.contactId ?? c.id,
          agent: "",
          unread: c.unread,
          pinned: false,
          lastAt: fmtCompact(c.updatedAt),
          updatedAt: c.updatedAt,
          lastFrom: "them",
          preview: c.snippet || "—",
          channel: "facebook",
          status: "human",
          intent: "—",
          confidence: 0,
          escalated: false,
        }))
      : [];

    const igRows: Conversation[] = igConnected
      ? (igConvsQ.data ?? []).map((c) => ({
          id: c.id,
          contactId: c.contactId ?? c.id,
          agent: "",
          unread: c.unread,
          pinned: false,
          lastAt: fmtCompact(c.updatedAt),
          updatedAt: c.updatedAt,
          lastFrom: "them",
          preview: c.snippet || "—",
          channel: "instagram",
          status: "human",
          intent: "—",
          confidence: 0,
          escalated: false,
        }))
      : [];

    // DB rows arrive ordered (pinned desc, then updatedAt desc). Legacy live
    // rows merged in raw order; they're empty unless rollback mode is active.
    return [...dbRows, ...fbRows, ...igRows];
  }, [
    fbConnected,
    convsQ.data,
    fbConvsQ.data,
    igConnected,
    igConvsQ.data,
  ]);

  // Augment contactById with synthetic Contact entries for FB + IG
  // participants so existing row/header renderers can resolve their names.
  const contactById = useMemo(() => {
    const map = new Map<string, Contact>();
    for (const c of contactsQ.data ?? []) map.set(c.id, c);
    for (const fc of fbConvsQ.data ?? []) {
      if (!fc.contactId) continue;
      if (map.has(fc.contactId)) continue;
      map.set(fc.contactId, {
        id: fc.contactId,
        name: fc.contactName,
        phone: "—",
        tags: ["Facebook"],
        industry: "facebook-dm",
        lifecycle: "lead",
        lastSeen: fmtCompact(fc.updatedAt),
        source: "Facebook DM",
        convs: 1,
        value: "—",
      });
    }
    for (const ic of igConvsQ.data ?? []) {
      if (!ic.contactId) continue;
      if (map.has(ic.contactId)) continue;
      map.set(ic.contactId, {
        id: ic.contactId,
        name: ic.contactName,
        phone: "—",
        tags: ["Instagram"],
        industry: "instagram-dm",
        lifecycle: "lead",
        lastSeen: fmtCompact(ic.updatedAt),
        source: "Instagram DM",
        convs: 1,
        value: "—",
      });
    }
    return map;
  }, [contactsQ.data, fbConvsQ.data, igConvsQ.data]);

  // Auto-select first conversation when list loads.
  useEffect(() => {
    if (shouldAutoSelect(embedVisible, activeId, conversations)) {
      setActiveId(conversations[0]!.id);
    }
  }, [conversations, activeId, embedVisible]);

  // Auto-fade the "Ticket #N created" banner: visible for 2.4s, then fade,
  // then unmount entirely.
  useEffect(() => {
    if (!ticketBanner || !ticketBanner.visible) return;
    const fadeTimer = window.setTimeout(() => {
      setTicketBanner((prev) => (prev ? { ...prev, visible: false } : null));
    }, 2400);
    return () => window.clearTimeout(fadeTimer);
  }, [ticketBanner]);

  useEffect(() => {
    if (!ticketBanner || ticketBanner.visible) return;
    const removeTimer = window.setTimeout(() => {
      setTicketBanner(null);
    }, 400);
    return () => window.clearTimeout(removeTimer);
  }, [ticketBanner]);

  // Mark-as-read whenever the active conversation changes. Skip the legacy
  // live threads (FB "t_", IG "ig:") — those have no DB row to mark.
  useEffect(() => {
    if (!activeId) return;
    if (isFbConvId(activeId) || isIgConvId(activeId)) return;
    let cancelled = false;
    api
      .post<Conversation>(`/conversations/${activeId}/read`, {})
      .then(() => {
        if (!cancelled) convsQ.refetch();
      })
      .catch(() => {
        // non-blocking; silently ignore
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const toggleChannel = (ch: ConvChannel) => {
    setChannels((prev) => {
      const next = new Set(prev);
      if (next.has(ch)) next.delete(ch);
      else next.add(ch);
      return next;
    });
  };

  const teamQ = useFetch<TeamMember[]>("/team");
  const labelsQ = useFetch<ConversationLabel[]>("/conversation-labels");
  const team = teamQ.data ?? [];
  const labels = labelsQ.data ?? [];

  // Drop label ids from a stale ?f= hash (label deleted since) once labels have
  // loaded, so a dead label can't filter the whole inbox out.
  useEffect(() => {
    if (!labelsQ.data) return;
    const known = new Set(labelsQ.data.map((l) => l.id));
    if (filter.labelIds.some((id) => !known.has(id))) {
      setFilter({ ...filter, labelIds: filter.labelIds.filter((id) => known.has(id)) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labelsQ.data, filter.labelIds]);

  const filterCtx = useMemo<FilterCtx>(
    () => ({ meId: user?.id ?? "", contactById, isLive: (c) => isLiveThreadId(c.id) }),
    [user?.id, contactById],
  );
  const bucketCountMap = useMemo(() => bucketCounts(conversations, filterCtx), [conversations, filterCtx]);
  const attention = useMemo(
    () => conversations.filter((c) => needsAttention(c, filterCtx)),
    [conversations, filterCtx],
  );

  // Number tabs: counts over the list as filtered by everything but the tab.
  const tabBase = useMemo(
    () => conversations.filter((c) => matchesFilter(c, filter, filterCtx, null) && (channels.size === 0 || channels.has(c.channel))),
    [conversations, filter, filterCtx, channels],
  );
  const numberTabList = useMemo(() => numberTabs(tabBase, channelList), [tabBase, channelList]);
  const numberChannels = useMemo(() => {
    const ids = new Set(numberTabList.map((t) => t.id));
    return channelList.filter((c) => ids.has(c.id));
  }, [numberTabList, channelList]);
  const numberLabels = useMemo(
    () => new Map(numberTabList.flatMap((t) => (t.id ? [[t.id, t.label] as const] : []))),
    [numberTabList],
  );
  // A hash `n=` for a number that no longer has a tab must not filter invisibly.
  const activeTab = numberTabList.some((t) => t.id === numberTab) ? numberTab : null;

  // matchesFilter + sort over the merged DB/FB/IG list; name/preview search
  // is applied afterwards inside InboxList.
  const filtered = useMemo<Conversation[]>(() => {
    const list = sortConversations(
      conversations.filter((c) => matchesFilter(c, filter, filterCtx, activeTab)),
      sort,
    );
    if (channels.size === 0) return list;
    return list.filter((c) => channels.has(c.channel));
  }, [filter, sort, filterCtx, channels, conversations, activeTab]);


  // Search narrows the filtered list; every view (list/table/board) and
  // "Add to group" share this exact list.
  const visibleConvs = useMemo<Conversation[]>(() => {
    if (initialLoading) return [];
    const q = search.trim().toLowerCase();
    if (!q) return filtered;
    return filtered.filter((c) => {
      const name = contactById.get(c.contactId)?.name ?? "";
      return name.toLowerCase().includes(q) || c.preview.toLowerCase().includes(q);
    });
  }, [filtered, search, contactById, initialLoading]);
  const teamById = useMemo(() => new Map(team.map((m) => [m.id, m])), [team]);
  const labelById = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels]);

  // ─── Mutations ────────────────────────────────────────────────────────
  interface SendInput {
    conversationId: string;
    body: string;
  }
  const sendMessage = useMutation<SendInput, Message>((input) =>
    api.post<Message>(`/conversations/${input.conversationId}/messages`, {
      from: "human",
      body: input.body,
    }),
  );

  // Live Facebook Messenger send: posts via Graph API to the recipient
  // associated with the active thread.
  const sendFbMessage = useMutation<
    { recipientId: string; body: string; mediaId?: string },
    { messageId: string }
  >((input) =>
    api.post<{ messageId: string }>(
      `/integrations/facebook/conversations/${input.recipientId}/send`,
      { message: input.body, mediaId: input.mediaId },
    ),
  );

  // Instagram outbound: posts via Graph through the linked FB Page.
  const sendIgMessage = useMutation<
    { conversationId: string; body: string; mediaId?: string },
    { ok: true; messageId?: string }
  >((input) =>
    api.post(`/integrations/instagram/conversations/${input.conversationId}/send`, {
      message: input.body,
      mediaId: input.mediaId,
    }),
  );
  // Live IG DM send — uses IGSID directly so we don't need a DB conversation row.
  const sendIgLiveMessage = useMutation<
    { igsid: string; body: string; mediaId?: string },
    { ok: true; messageId?: string }
  >((input) =>
    api.post(`/integrations/instagram/conversations/by-igsid/${input.igsid}/send`, {
      message: input.body,
      mediaId: input.mediaId,
    }),
  );

  // Reply into a DB-backed conversation whose transport is Zernio (WhatsApp,
  // and FB/IG threads persisted by the inbound webhook). The backend resolves
  // the Zernio conversation + accountId from the contact; media attaches via
  // mediaId (Zernio's attachmentUrl contract, live-verified 2026-08-19).
  const sendZernioDbMessage = useMutation<
    { conversationId: string; body: string; mediaId?: string },
    { ok: true; id?: string | null }
  >((input) =>
    api.post(`/integrations/zernio/db-conversations/${input.conversationId}/send`, {
      message: input.body,
      mediaId: input.mediaId,
    }),
  );

  // WhatsApp outbound: posts via Cloud API. Optional mediaId attaches an image
  // (or sends caption-only when body is empty).
  const sendWaMessage = useMutation<
    { conversationId: string; body: string; mediaId?: string },
    { ok: true; wamid?: string }
  >((input) =>
    api.post(`/integrations/whatsapp/conversations/${input.conversationId}/send`, {
      message: input.body,
      mediaId: input.mediaId,
    }),
  );

  // WhatsApp template send — required path for messaging outside the 24-hour
  // customer-service window. Templates must already be APPROVED on the WABA.
  const sendWaTemplate = useMutation<
    {
      conversationId: string;
      name: string;
      language: string;
      variables: string[];
      header?: TemplateHeaderValue;
    },
    { ok: true; wamid?: string }
  >((input) =>
    api.post(
      `/integrations/whatsapp/conversations/${input.conversationId}/send-template`,
      {
        name: input.name,
        language: input.language,
        variables: input.variables,
        header: input.header,
      },
    ),
  );

  // WhatsApp template over the Zernio transport. Zernio carries templates on
  // the same endpoint as free text, so this mirrors sendZernioDbMessage — and
  // is the path that actually works while WhatsApp is connected via Zernio
  // (the Meta path below has no token for a provider="zernio" row).
  const sendZernioDbTemplate = useMutation<
    {
      conversationId: string;
      name: string;
      language: string;
      variables: string[];
      header?: TemplateHeaderValue;
    },
    { ok: true; id?: string | null }
  >((input) =>
    api.post(`/integrations/zernio/db-conversations/${input.conversationId}/send-template`, {
      name: input.name,
      language: input.language,
      variables: input.variables,
      header: input.header,
    }),
  );

  const addPending = (convId: string, body: string) => {
    const id = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const at = Date.now();
    setPendingByConv((prev) => ({
      ...prev,
      [convId]: [...(prev[convId] ?? []), { id, body, at }],
    }));
    // Safety net: clear the pending entry after 15s even if polling never
    // catches up (e.g. Graph silently drops it). Prevents stuck bubbles.
    window.setTimeout(() => {
      setPendingByConv((prev) => {
        const list = (prev[convId] ?? []).filter((p) => p.id !== id);
        return { ...prev, [convId]: list };
      });
    }, 15000);
  };

  /**
   * Does Zernio own this conversation's channel? Both the text and the
   * template send need the same answer — the template path 404'd for months
   * because only handleSend asked the question.
   */
  const zernioOwnsConvChannel = (convId: string): boolean => {
    const conv = (convsQ.data ?? []).find((c) => c.id === convId);
    if (!conv) return false;
    return pickSendRoute(conv, zernioPlatformGuess(conv)) === "zernio";
  };
  // Only the fallback for rows without a channelProvider.
  const zernioPlatformGuess = (conv: Conversation): boolean =>
    (zernioStatusQ.data?.accounts ?? []).some((a) => a.platform === conv.channel);

  // Telegram / web chat: POST /conversations/:id/send, errors localized.
  const [nativeSend, setNativeSend] = useState<{ loading: boolean; error: string | null }>({
    loading: false,
    error: null,
  });
  const sendNative = async (conversationId: string, body: string) => {
    setNativeSend({ loading: true, error: null });
    try {
      await api.post(`/conversations/${conversationId}/send`, { body });
      setNativeSend({ loading: false, error: null });
    } catch (e) {
      setNativeSend({ loading: false, error: channelErrorText(e, tx) });
      if (isChannelStateError(e)) {
        invalidateChannels(qc);
        void convsQ.refetch();
      }
      throw e;
    }
  };

  // m1: Zernio / Meta sends refresh the channel list and threads when the
  // channel's state changed under us (409 channels.disconnected / not_connected).
  const refreshOnChannelState = (e: unknown): never => {
    if (isChannelStateError(e)) {
      invalidateChannels(qc);
      void convsQ.refetch();
    }
    throw e;
  };

  const handleSend = async (body: string, mediaId?: string): Promise<void> => {
    if (!activeId) return;
    if (isFbConvId(activeId)) {
      const fbConv = (fbConvsQ.data ?? []).find((c) => c.id === activeId);
      // Meta /messages requires the Page-Scoped ID (numeric), not our DB cuid.
      const recipientId = fbConv?.contactPsid;
      if (!recipientId) return;
      if (body) addPending(activeId, body);
      await sendFbMessage.mutate({ recipientId, body, mediaId });
      return;
    }
    if (isIgConvId(activeId)) {
      const igConv = (igConvsQ.data ?? []).find((c) => c.id === activeId);
      const igsid = igConv?.contactIgsid;
      if (!igsid) return;
      if (body) addPending(activeId, body);
      await sendIgLiveMessage.mutate({ igsid, body, mediaId });
      return;
    }
    // Route by channel for DB-stored conversations. Channels Zernio owns go
    // through Zernio — the legacy Meta services no longer hold a usable token
    // for them, since Zernio's sync replaced those Integration rows.
    const conv = (convsQ.data ?? []).find((c) => c.id === activeId);
    const route = conv ? pickSendRoute(conv, zernioPlatformGuess(conv)) : "legacy";
    // DB-backed sends round-trip Zernio + the remote DB (~2s) — show the
    // bubble immediately, same as the live-thread paths above.
    if (conv && body) addPending(activeId, body);
    if (conv && route === "native") {
      await sendNative(activeId, body);
    } else if (conv && route === "zernio") {
      await sendZernioDbMessage.mutate({ conversationId: activeId, body, mediaId }).catch(refreshOnChannelState);
    } else if (conv && route === "meta_ig") {
      await sendIgMessage.mutate({ conversationId: activeId, body, mediaId });
    } else if (conv && route === "meta_wa") {
      await sendWaMessage.mutate({ conversationId: activeId, body, mediaId }).catch(refreshOnChannelState);
    } else {
      // Fallback: just write to DB (web chat, etc.)
      await sendMessage.mutate({ conversationId: activeId, body });
    }
    // Bumping messageVersion changes activeQ's queryKey, which already fetches
    // the fresh thread — calling activeQ.refetch() as well re-fetched the OLD
    // key entry, a wasted ~0.5s DB round trip per send.
    setMessageVersion((n) => n + 1);
    convsQ.refetch();
  };

  // The detail payload may predate SP-19 fields; the list row is authoritative.
  const activeChannelId =
    conversations.find((c) => c.id === activeId)?.channelId ?? null;

  // Compute the active conversation: either the internal /conversations/:id
  // result, or a synthetic one assembled from live Facebook DMs.
  const active: ConversationDetail | undefined = useMemo(() => {
    if (!activeId) return undefined;
    // Pending bubbles for live threads — append after server messages so the
    // operator's just-sent message appears instantly. Drop any pending entry
    // whose body already shows up in the server payload (polling caught up).
    const appendPending = (convId: string, baseMsgs: Message[]): Message[] => {
      const pending = pendingByConv[convId] ?? [];
      if (pending.length === 0) return baseMsgs;
      const serverBodies = new Set(
        baseMsgs.filter((m) => m.from === "human").map((m) => m.body),
      );
      const stillPending = pending.filter((p) => !serverBodies.has(p.body));
      if (stillPending.length === 0) return baseMsgs;
      return [
        ...baseMsgs,
        ...stillPending.map((p) => ({
          from: "human" as const,
          t: new Date(p.at).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
          body: p.body,
        })),
      ];
    };

    if (isFbConvId(activeId)) {
      const fbConv = (fbConvsQ.data ?? []).find((c) => c.id === activeId);
      if (!fbConv) return undefined;
      const serverMsgs: Message[] = (fbMsgsQ.data ?? []).map((m) => ({
        from: m.from === "page" ? "human" : "them",
        t: fmtCompact(m.at),
        createdAt: m.at,
        body: m.body || (m.attachmentUrl ? "📎 attachment" : ""),
        agent: m.from === "page" ? undefined : undefined,
        attach: m.attachmentUrl,
      }));
      return {
        id: fbConv.id,
        contactId: fbConv.contactId ?? fbConv.id,
        agent: "",
        unread: fbConv.unread,
        pinned: false,
        lastAt: fmtCompact(fbConv.updatedAt),
        updatedAt: fbConv.updatedAt,
        lastFrom: "them",
        preview: fbConv.snippet || "—",
        channel: "facebook",
        status: "human",
        intent: "—",
        confidence: 0,
        escalated: false,
        messages: appendPending(activeId, serverMsgs),
      };
    }
    if (isIgConvId(activeId)) {
      const igConv = (igConvsQ.data ?? []).find((c) => c.id === activeId);
      if (!igConv) return undefined;
      const serverMsgs: Message[] = (igMsgsQ.data ?? []).map((m) => ({
        from: m.from === "page" ? "human" : "them",
        t: fmtCompact(m.at),
        createdAt: m.at,
        body: m.body || "📎 attachment",
        agent: undefined,
      }));
      return {
        id: igConv.id,
        contactId: igConv.contactId ?? igConv.id,
        agent: "",
        unread: igConv.unread,
        pinned: false,
        lastAt: fmtCompact(igConv.updatedAt),
        updatedAt: igConv.updatedAt,
        lastFrom: "them",
        preview: igConv.snippet || "—",
        channel: "instagram",
        status: "human",
        intent: "—",
        confidence: 0,
        escalated: false,
        messages: appendPending(activeId, serverMsgs),
      };
    }
    // DB-backed conversation: same optimistic-append as the live paths, so a
    // just-sent reply shows instantly instead of after the ~2s send round trip.
    if (!activeQ.data) return undefined;
    return {
      ...activeQ.data,
      messages: appendPending(activeId, activeQ.data.messages ?? []),
    };
  }, [
    activeId,
    fbConvsQ.data,
    fbMsgsQ.data,
    igConvsQ.data,
    igMsgsQ.data,
    activeQ.data,
    pendingByConv,
  ]);

  const activeContact = active ? contactById.get(active.contactId) : undefined;
  const activeIsFb = active ? isFbConvId(active.id) : false;
  const activeIsIg = active ? isIgConvId(active.id) : false;

  return (
    <div
      className="inbox-v2"
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(300px, 348px) minmax(0, 1fr) minmax(300px, 336px)",
        flex: 1,
        minHeight: 0,
        position: "relative",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateRows: "auto 1fr",
          // Single-column grids size their auto track to max-content, which
          // let the pill rows push this column to ~760px and bleed under the
          // thread pane. Pin the track to the grid area's own width.
          gridTemplateColumns: "minmax(0, 1fr)",
          minWidth: 0,
          minHeight: 0,
        }}
      >
        {ticketBanner ? (
          <div
            style={{
              padding: "8px 14px",
              borderBottom: "1px solid var(--line-soft)",
              background: "var(--accent-soft)",
              color: "var(--accent)",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              display: "flex",
              alignItems: "center",
              gap: 8,
              opacity: ticketBanner.visible ? 1 : 0,
              transition: "opacity .35s ease",
            }}
          >
            <IconCheck w={12} />
            <span>
              {tx(
                `Ticket #${ticketBanner.number} created`,
                `تم إنشاء التذكرة #${ticketBanner.number}`,
              )}
            </span>
          </div>
        ) : (
          <div />
        )}
        <InboxList
          filter={filter}
          setFilter={setFilter}
          sort={sort}
          setSort={setSort}
          bucketCountMap={bucketCountMap}
          attention={attention}
          team={team}
          labels={labels}
          channels={channels}
          toggleChannel={toggleChannel}
          allConvs={conversations}
          activeId={activeId}
          setActiveId={setActiveId}
          view={view}
          setView={setView}
          search={search}
          setSearch={setSearch}
          visibleConvs={visibleConvs}
          numberTabList={numberTabList}
          numberTab={activeTab}
          setNumberTab={setNumberTab}
          numberChannels={numberChannels}
          contactById={contactById}
          loading={initialLoading}
          error={convsQ.error ?? fbConvsQ.error ?? igConvsQ.error}
          onRetry={
            convsQ.error
              ? convsQ.refetch
              : fbConvsQ.error
                ? fbConvsQ.refetch
                : igConvsQ.refetch
          }
          tx={tx}
        />
      </div>
      {view === "table" || view === "board" ? (
        <div style={{ gridColumn: "2 / -1", display: "flex", minWidth: 0, minHeight: 0, paddingBlockStart: 12 }}>
          {view === "table" ? (
            <InboxTable
              convs={visibleConvs}
              contactById={contactById}
              teamById={teamById}
              labelById={labelById}
              activeId={activeId}
              onOpen={(id) => {
                setActiveId(id);
                setView("list");
              }}
              lang={t.lang}
              tx={tx}
              noConversations={conversations.length === 0}
            />
          ) : (
            <InboxBoard
              convs={visibleConvs}
              contactById={contactById}
              teamById={teamById}
              labelById={labelById}
              onOpen={(id) => {
                setActiveId(id);
                setView("list");
              }}
              onChanged={() => Promise.all([convsQ.refetch(), activeQ.refetch()])}
              tx={tx}
            />
          )}
        </div>
      ) : active ? (
        <ConversationPane
          conv={active}
          contactById={contactById}
          onSend={handleSend}
          threadView={threadView}
          onThreadView={setThreadView}
          onSendTemplate={async (name, language, variables, header) => {
            if (!activeId) return;
            // Same transport routing as handleSend: Zernio-owned WhatsApp goes
            // through Zernio, which carries templates on its normal send
            // endpoint. Only a direct Meta connection uses the Cloud API path.
            if (zernioOwnsConvChannel(activeId)) {
              await sendZernioDbTemplate
                .mutate({
                  conversationId: activeId,
                  name,
                  language,
                  variables,
                  header,
                })
                .catch(refreshOnChannelState);
            } else {
              await sendWaTemplate
                .mutate({
                  conversationId: activeId,
                  name,
                  language,
                  variables,
                  header,
                })
                .catch(refreshOnChannelState);
            }
            // messageVersion bump refetches the thread via the new queryKey.
            setMessageVersion((n) => n + 1);
            convsQ.refetch();
          }}
          sending={
            sendMessage.loading ||
            sendFbMessage.loading ||
            sendIgMessage.loading ||
            sendIgLiveMessage.loading ||
            sendZernioDbMessage.loading ||
            sendWaMessage.loading ||
            sendWaTemplate.loading ||
            sendZernioDbTemplate.loading ||
            nativeSend.loading
          }
          channel={activeChannelId ? (channelById.get(activeChannelId) ?? null) : null}
          multiNumber={!!activeChannelId && numberChannels.some((c) => c.id === activeChannelId)}
          numberLabel={activeChannelId ? (numberLabels.get(activeChannelId) ?? null) : null}
          sendError={sendErrorText(
            sendMessage.error ??
              sendFbMessage.error ??
              sendIgMessage.error ??
              sendIgLiveMessage.error ??
              sendZernioDbMessage.error ??
              sendWaMessage.error ??
              sendWaTemplate.error ??
              sendZernioDbTemplate.error ??
              nativeSend.error,
            tx,
          )}
          onConvertToTicket={() => setShowConvertModal(true)}
          onConversationChanged={() => Promise.all([convsQ.refetch(), activeQ.refetch()])}
          messagesLoading={
            activeIsFb
              ? fbMsgsQ.loading
              : activeIsIg
                ? igMsgsQ.loading
                : activeQ.loading
          }
          lang={t.lang}
          tx={tx}
        />
      ) : activeQ.loading ? (
        <div
          aria-label={tx("Loading conversation", "جارٍ تحميل المحادثة")}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            padding: "24px 0",
            overflowY: "auto",
          }}
        >
          <MessageSkeleton side="left" />
          <MessageSkeleton side="right" />
          <MessageSkeleton side="left" />
          <MessageSkeleton side="right" />
          <MessageSkeleton side="left" />
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            placeItems: "center",
            padding: 24,
            color: "var(--ink-3)",
            fontSize: 13,
          }}
        >
          {activeQ.error && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                alignItems: "center",
              }}
            >
              <span style={{ color: "var(--bad)", fontSize: 12 }}>
                {activeQ.error}
              </span>
              <button className="btn sm ghost" onClick={activeQ.refetch}>
                {tx("Retry", "إعادة")}
              </button>
            </div>
          )}
          {!activeQ.error && (
            <span>{tx("Select a conversation", "اختر محادثة")}</span>
          )}
        </div>
      )}
      {view !== "list" ? null : active ? (
        <ContactRightRail
          conv={active}
          contactById={contactById}
          onContactsChanged={contactsQ.refetch}
          tx={tx}
        />
      ) : (
        <aside
          style={{
            borderInlineStart: "1px solid var(--line-soft)",
            background: "var(--bg-1)",
          }}
        />
      )}
      {showConvertModal && active && (
        <ConvertTicketModal
          conv={active}
          contact={activeContact}
          isFbConv={activeIsFb}
          onClose={() => setShowConvertModal(false)}
          onCreated={(num) => setTicketBanner({ number: num, visible: true })}
          tx={tx}
        />
      )}
    </div>
  );
}

const Inbox = memo(InboxImpl);
export default Inbox;
