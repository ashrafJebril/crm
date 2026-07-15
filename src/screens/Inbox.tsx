import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx, type Tx } from "@/lib/tx";
import { Avatar } from "@/components/Avatar";
import { Badge, type BadgeKind } from "@/components/Badge";
import { Modal } from "@/components/Modal";
import { ConvRowSkeleton, MessageSkeleton } from "@/components/Skeleton";
import { NotesPanel } from "@/components/NotesPanel";
import {
  IconAttach,
  IconBook,
  IconCheck,
  IconChevDown,
  IconFilter,
  IconHand,
  IconMore,
  IconPause,
  IconPhone,
  IconSend,
  IconSparkles,
  IconTemplate,
  IconX,
} from "@/icons";
import { AGENTS, findAgent } from "@/data/agents";
import { API_BASE, api, tokenStore } from "@/api/client";
import { useFetch, useMutation } from "@/api/useFetch";
import { useRealtime } from "@/api/useRealtime";
import { useAuth } from "@/auth/context";
import {
  CHANNEL_LABEL,
  type Agent,
  type Contact,
  type ConvChannel,
  type Conversation,
  type Lang,
  type Message,
  type Pipeline,
  type StageColor,
  type Ticket,
  type TicketStage,
  type TicketsListPage,
} from "@/lib/types";
import { ConversationTicketsPill } from "./inbox/ConversationTicketsPill";
import { AddToPipelineButton } from "./inbox/AddToPipelineButton";
import { MediaPicker } from "@/components/MediaPicker";
import type { Media } from "@/lib/types";

type FilterId = "all" | "ai" | "human" | "unread" | "closed" | "spam";
type ConversationDetail = Conversation & { messages: Message[] };

const CHANNELS: ConvChannel[] = ["whatsapp", "instagram", "facebook", "tiktok", "webchat"];

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

interface FilterDef {
  id: FilterId;
  label: string;
  count: number;
  kind?: "ai" | "human";
}

interface InboxListProps {
  filter: FilterId;
  setFilter: (f: FilterId) => void;
  channels: Set<ConvChannel>;
  toggleChannel: (c: ConvChannel) => void;
  convs: Conversation[];
  allConvs: Conversation[];
  activeId: string | null;
  setActiveId: (id: string) => void;
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
  ) => Promise<void>;
  sending: boolean;
  sendError: string | null;
  onConvertToTicket: () => void;
  onToggleAiPaused: (paused: boolean) => Promise<void>;
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
  { id: "Bulk",      ar: "بالجملة",      kind: "ai"     },
  { id: "B2B",       ar: "شركات",        kind: "human"  },
  { id: "Wholesale", ar: "موزّع",        kind: ""       },
  { id: "Designer",  ar: "بتصميمه",      kind: ""       },
  { id: "At-risk",   ar: "في خطر",       kind: "warn"   },
  { id: "Promoter",  ar: "مروّج",        kind: "ai"     },
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

const STAGE_BADGE_KIND: Record<StageColor, BadgeKind> = {
  ink: "",
  info: "info",
  ok: "ok",
  warn: "warn",
  bad: "bad",
  accent: "ai",
  human: "human",
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
        lifecycle: "Lead",
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

interface ContactTicketsProps {
  contactId: string;
  tx: Tx;
}

function ContactTickets({ contactId, tx }: ContactTicketsProps) {
  const ticketsQ = useFetch<TicketsListPage>(`/tickets?contactId=${contactId}`);
  // Don't render the section on error.
  if (ticketsQ.error) return null;

  const tickets = ticketsQ.data?.items ?? [];

  return (
    <div>
      <SectionLabel>{tx("Tickets", "التذاكر")}</SectionLabel>
      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
        {ticketsQ.loading && tickets.length === 0 && (
          <div
            className="mono"
            style={{ fontSize: 11, color: "var(--ink-3)", opacity: 0.7 }}
          >
            {tx("loading…", "جارٍ التحميل…")}
          </div>
        )}
        {!ticketsQ.loading && tickets.length === 0 && (
          <div
            style={{
              padding: 12,
              borderRadius: 10,
              background: "var(--bg-2)",
              border: "1px dashed var(--line-soft)",
              fontSize: 12,
              color: "var(--ink-3)",
              textAlign: "center",
            }}
          >
            {tx("No tickets yet", "لا توجد تذاكر")}
          </div>
        )}
        {tickets.map((t) => {
          const stageColor: StageColor = t.stage?.color ?? "ink";
          const kind: BadgeKind = STAGE_BADGE_KIND[stageColor] ?? "";
          return (
            <div
              key={t.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 10px",
                borderRadius: 8,
                border: "1px solid var(--line-soft)",
                background: "var(--bg-2)",
              }}
            >
              <span
                className="mono"
                style={{ fontSize: 11, color: "var(--ink-3)", flex: "0 0 auto" }}
              >
                #{t.number}
              </span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 12,
                  color: "var(--ink-1)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={t.title}
              >
                {t.title}
              </span>
              {t.stage && (
                <Badge kind={kind} dot>
                  {t.stage.label}
                </Badge>
              )}
              {typeof t.value === "number" && (
                <span
                  className="mono"
                  style={{ fontSize: 11, color: "var(--ink-2)", flex: "0 0 auto" }}
                >
                  {t.currency} {t.value.toLocaleString()}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface BubbleProps {
  m: Message;
  agent: Agent | undefined;
}

function InboxList({
  filter,
  setFilter,
  channels,
  toggleChannel,
  convs,
  allConvs,
  activeId,
  setActiveId,
  contactById,
  loading,
  error,
  onRetry,
  tx,
}: InboxListProps) {
  // Count all six buckets in a single pass, memoized on the conversation list.
  // Previously this ran six full allConvs.filter() scans on every render — and
  // InboxList re-renders on every 30s poll and realtime bump.
  const counts = useMemo(() => {
    let ai = 0, human = 0, unread = 0, closed = 0, spam = 0;
    for (const c of allConvs) {
      if (c.status === "ai") ai++;
      else if (c.status === "human") human++;
      else if (c.status === "closed") closed++;
      else if (c.status === "spam") spam++;
      if (c.unread > 0) unread++;
    }
    return { all: allConvs.length, ai, human, unread, closed, spam };
  }, [allConvs]);

  // During the unified initial load the skeleton stands in for the rows —
  // rendering partial rows underneath would reintroduce per-channel pop-in.
  const visibleConvs = loading ? [] : convs;

  const filters: FilterDef[] = [
    { id: "all", label: tx("All", "الكل"), count: counts.all },
    { id: "ai", label: tx("AI handled", "ذكاء"), count: counts.ai, kind: "ai" },
    { id: "human", label: tx("Assigned", "معيّنة"), count: counts.human, kind: "human" },
    { id: "unread", label: tx("Unread", "غير مقروءة"), count: counts.unread },
    { id: "closed", label: tx("Closed", "مغلقة"), count: counts.closed },
    { id: "spam", label: tx("Spam", "مزعجة"), count: counts.spam },
  ];

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        borderInlineEnd: "1px solid var(--line-soft)",
        minHeight: 0,
      }}
    >
      <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line-soft)" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 10,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{tx("Inbox", "الرسائل")}</h2>
          <div style={{ display: "flex", gap: 4 }}>
            <button className="btn ghost icon sm" title={tx("Filter", "فلتر")}>
              <IconFilter w={14} />
            </button>
            <button className="btn ghost icon sm" title={tx("Sort", "ترتيب")}>
              <IconMore w={14} />
            </button>
          </div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginBottom: 8,
          }}
        >
          {CHANNELS.map((ch) => {
            const active = channels.has(ch);
            return (
              <button
                key={ch}
                type="button"
                className={`ch-toggle ${active ? "active" : ""}`.trim()}
                onClick={() => toggleChannel(ch)}
                title={CHANNEL_LABEL[ch]}
                aria-pressed={active}
              >
                <ChannelMark channel={ch} size={16} />
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {filters.map((f) => (
            <button
              key={f.id}
              className={`chip ${filter === f.id ? "active" : ""}`.trim()}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
              <span className="ct">{f.count}</span>
            </button>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
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
        {visibleConvs.map((c) => {
          const contact = contactById.get(c.contactId);
          const agent = findAgent(c.agent);
          return (
            <div
              key={c.id}
              className={`conv-row ${activeId === c.id ? "active" : ""}`.trim()}
              onClick={() => setActiveId(c.id)}
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
                  <ChannelMark channel={c.channel} size={14} />
                </span>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span
                    style={{
                      fontWeight: c.unread ? 600 : 500,
                      fontSize: 13,
                      flex: 1,
                      minWidth: 0,
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                    }}
                  >
                    {contact?.name}
                  </span>
                  <span
                    className="mono"
                    style={{
                      fontSize: 10,
                      color: c.unread ? "var(--accent)" : "var(--ink-3)",
                    }}
                  >
                    {c.lastAt}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: c.unread ? "var(--ink-1)" : "var(--ink-3)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    marginTop: 2,
                  }}
                >
                  {c.lastFrom === "ai" && <span style={{ color: "var(--accent)" }}>↳ </span>}
                  {c.lastFrom === "human" && <span style={{ color: "var(--human)" }}>↳ </span>}
                  {c.preview}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
                  {c.status === "ai" && agent && (
                    <Badge kind="ai" dot>
                      {agent.name}
                    </Badge>
                  )}
                  {c.status === "human" && (
                    <Badge kind="human" dot>
                      Human
                    </Badge>
                  )}
                  {c.status === "closed" && (
                    <Badge kind="ok" dot>
                      closed
                    </Badge>
                  )}
                  {c.status === "spam" && (
                    <Badge kind="bad" dot>
                      spam
                    </Badge>
                  )}
                  {c.escalated && (
                    <Badge kind="warn" dot>
                      escalated
                    </Badge>
                  )}
                  {c.unread > 0 && (
                    <span
                      style={{
                        marginInlineStart: "auto",
                        fontFamily: "var(--font-mono)",
                        fontSize: 10,
                        background: "var(--accent)",
                        color: "var(--accent-ink)",
                        padding: "1px 6px",
                        borderRadius: 999,
                      }}
                    >
                      {c.unread}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <style>{`
        .chip { display: inline-flex; align-items: center; gap: 5px;
          padding: 4px 9px; border-radius: 999px; border: 1px solid var(--line-soft);
          background: transparent; color: var(--ink-2); font-size: 11px;
          font-family: var(--font-mono); cursor: pointer; }
        .chip:hover { color: var(--ink); border-color: var(--line); }
        .chip.active { background: var(--accent-soft); color: var(--accent); border-color: var(--accent-ring); }
        .chip .ct { color: var(--ink-3); font-size: 10px; }
        .chip.active .ct { color: var(--accent); }

        .ch-toggle { display: inline-flex; align-items: center; justify-content: center;
          width: 26px; height: 26px; padding: 0; border-radius: 8px;
          border: 1px solid var(--line-soft); background: transparent;
          cursor: pointer; opacity: 0.55; transition: opacity .15s, border-color .15s; }
        .ch-toggle:hover { opacity: 0.85; }
        .ch-toggle.active { opacity: 1; border-color: var(--accent-ring);
          background: var(--accent-soft); }

        .conv-row { display: flex; gap: 10px; padding: 12px 14px;
          border-bottom: 1px solid var(--line-soft); cursor: pointer; }
        .conv-row:hover { background: var(--bg-1); }
        .conv-row.active { background: var(--bg-2); border-inline-start: 2px solid var(--accent); padding-inline-start: 12px; }

        .pulse { animation: pulse 1.2s ease-in-out infinite; }
        @keyframes pulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
      `}</style>
    </div>
  );
}

function Bubble({ m, agent }: BubbleProps) {
  const isOut = m.from === "ai" || m.from === "human";
  const isAI = m.from === "ai";
  const { user } = useAuth();
  const humanName = user?.name ?? "You";
  const humanColor = user?.color ?? "150";
  return (
    <div style={{ display: "flex", justifyContent: isOut ? "flex-end" : "flex-start", gap: 8 }}>
      {!isOut && <div style={{ width: 24 }} />}
      <div style={{ maxWidth: "62%" }}>
        {isOut && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginBottom: 4,
              justifyContent: "flex-end",
            }}
          >
            {isAI ? (
              <>
                {agent && <Avatar agent={agent} ai size="sm" />}
                <span style={{ fontSize: 11, color: "var(--accent)", fontWeight: 500 }}>
                  {agent?.name}
                </span>
                <Badge kind="ai">AI</Badge>
              </>
            ) : (
              <>
                <Avatar name={humanName} color={humanColor} size="sm" />
                <span style={{ fontSize: 11, fontWeight: 500 }}>{humanName}</span>
                <Badge kind="human">Human</Badge>
              </>
            )}
          </div>
        )}
        <div
          style={{
            padding: "8px 12px",
            borderRadius: isOut ? "12px 12px 4px 12px" : "12px 12px 12px 4px",
            background: isOut ? "var(--bubble-out)" : "var(--bubble-in)",
            border: `1px solid ${isOut ? "var(--bubble-out-line)" : "var(--bubble-in-line)"}`,
            color: "var(--ink)",
            fontSize: 13.5,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
          }}
        >
          {m.body}
          {m.attach && <MessageAttachment value={m.attach} />}
        </div>
        <div
          className="mono"
          style={{
            fontSize: 10,
            color: "var(--ink-3)",
            marginTop: 3,
            textAlign: isOut ? "end" : "start",
          }}
        >
          {m.t}
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
  sending,
  sendError,
  onConvertToTicket,
  onToggleAiPaused,
  messagesLoading,
  lang,
  tx,
}: ConversationPaneProps) {
  const contact = contactById.get(conv.contactId);
  const agent = findAgent(conv.agent);
  const { user } = useAuth();
  const [draft, setDraft] = useState<string>("");
  const [attachedMedia, setAttachedMedia] = useState<Media | null>(null);
  const [pickerOpen, setPickerOpen] = useState<boolean>(false);
  const [templatePickerOpen, setTemplatePickerOpen] = useState<boolean>(false);

  // WhatsApp 24-hour customer-service window. Backend computes `waWindowOpen`
  // on the conversation payload (true when the last inbound message landed
  // within 24h). Outside the window, free-form text/image sends are blocked
  // by Meta — only approved templates work.
  const isWhatsApp = conv.channel === "whatsapp";
  const waWindowOpen = conv.waWindowOpen !== false;
  const waBlocked = isWhatsApp && !waWindowOpen;

  // Auto-scroll the thread to the latest message — but only when the user is
  // already near the bottom. Standard chat UX: if they've scrolled up to
  // read history, a new inbound shouldn't yank them back down.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const wasAtBottomRef = useRef<boolean>(true);
  const prevConvIdRef = useRef<string | null>(null);

  const messages: Message[] =
    conv.messages.length > 0
      ? conv.messages
      : messagesLoading
      ? []
      : [
          { from: "them", t: "10:42", body: conv.preview },
          {
            from: "ai",
            t: "10:43",
            body: tx("On it — let me check the latest for you.", "حسنًا، دعيني أتحقق."),
            agent: conv.agent,
          },
          { from: "them", t: "10:44", body: tx("Thanks!", "شكراً!") },
        ];

  const handleSend = () => {
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
          height: 56,
          padding: "0 18px",
          borderBottom: "1px solid var(--line-soft)",
          display: "flex",
          alignItems: "center",
          gap: 12,
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
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 600 }}>{contact?.name}</span>
            <Badge kind="ok" dot>
              online
            </Badge>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "2px 8px 2px 4px",
                borderRadius: 999,
                border: "1px solid var(--line-soft)",
                background: "var(--bg-1)",
                fontSize: 11,
                color: "var(--ink-2)",
                fontFamily: "var(--font-mono)",
              }}
            >
              <ChannelMark channel={conv.channel} size={14} />
              {tx("via", "عبر")} {CHANNEL_LABEL[conv.channel]}
            </span>
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--ink-3)",
              display: "flex",
              gap: 6,
              fontFamily: "var(--font-mono)",
            }}
          >
            <span>{contact?.phone}</span>
            <span>·</span>
            <span>{contact?.industry}</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {agent && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 10px 4px 4px",
                border: "1px solid var(--accent-ring)",
                background: "var(--accent-soft)",
                borderRadius: 999,
              }}
            >
              <Avatar agent={agent} ai size="sm" />
              <span style={{ fontSize: 12, color: "var(--accent)", fontWeight: 500 }}>
                {agent.name} {tx("is replying", "يردّ")}
              </span>
            </div>
          )}
          <button className="btn" onClick={onConvertToTicket}>
            <IconCheck w={13} />
            {tx("Convert to ticket", "إلى تذكرة")}
          </button>
          {conv.aiPaused ? (
            <button
              className="btn primary"
              onClick={() => onToggleAiPaused(false)}
              title={tx("Resume AI auto-reply", "استئناف الرد التلقائي")}
            >
              <IconSparkles w={13} />
              {tx("Resume AI", "استئناف الذكاء")}
            </button>
          ) : (
            <button
              className="btn"
              onClick={() => onToggleAiPaused(true)}
              title={tx("Pause AI and handle this thread yourself", "أوقف الذكاء وتولَّ هذه المحادثة")}
            >
              <IconHand w={14} />
              {tx("Take over", "تولّى")}
            </button>
          )}
          <ConversationTicketsPill
            conversationId={conv.id}
            lang={lang}
            onClick={(t) => {
              window.location.hash = `#/pipeline?openTicket=${encodeURIComponent(t.id)}`;
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

      {conv.status === "ai" && agent && (
        <div
          style={{
            padding: "8px 18px",
            display: "flex",
            gap: 12,
            alignItems: "center",
            borderBottom: "1px solid var(--line-soft)",
            fontSize: 12,
            color: "var(--ink-2)",
            background: "var(--bg-1)",
          }}
        >
          <IconSparkles w={14} stroke={1.5} />
          <span>
            <strong style={{ color: "var(--accent)" }}>{agent.name}</strong>{" "}
            {tx("is handling this conversation", "تتولى هذه المحادثة")}.
          </span>
          <span className="muted" style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
            {tx("intent", "نية")}: <span style={{ color: "var(--ink-1)" }}>{conv.intent}</span>
          </span>
          <span className="muted" style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
            {tx("confidence", "ثقة")}:{" "}
            <span style={{ color: "var(--ok)" }}>
              {Math.round((conv.confidence || 0.9) * 100)}%
            </span>
          </span>
          <span style={{ marginInlineStart: "auto", display: "flex", gap: 6 }}>
            <button className="btn sm ghost">
              <IconPause w={11} />
              {tx("Pause AI", "إيقاف الذكاء")}
            </button>
          </span>
        </div>
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
          padding: "20px 24px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          backgroundImage: "radial-gradient(circle, var(--line-soft) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
          backgroundPosition: "0 0",
        }}
      >
        <div className="day-divider">
          <span>{tx("Today", "اليوم")}</span>
        </div>
        {messagesLoading && messages.length === 0 ? (
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
        ) : (
          messages.map((m, i) => (
            <Bubble key={`${conv.id}-${i}`} m={m} agent={agent} />
          ))
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

      {conv.suggested && (
        <div
          style={{
            padding: "10px 18px",
            borderTop: "1px solid var(--line-soft)",
            background: "var(--bg-1)",
            display: "flex",
            gap: 12,
            alignItems: "flex-start",
          }}
        >
          <IconSparkles w={14} />
          <div style={{ flex: 1, fontSize: 13 }}>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                color: "var(--accent)",
                marginBottom: 2,
                textTransform: "uppercase",
                letterSpacing: 0.06,
              }}
            >
              {tx("AI suggestion", "اقتراح ذكي")}
            </div>
            <div style={{ color: "var(--ink-1)" }}>{conv.suggested}</div>
          </div>
          <button className="btn sm primary">
            <IconCheck w={11} />
            {tx("Use", "استخدم")}
          </button>
          <button className="btn sm ghost">{tx("Edit", "تعديل")}</button>
        </div>
      )}

      <div style={{ padding: 14, borderTop: "1px solid var(--line-soft)" }}>
        <div
          style={{
            border: "1px solid var(--line)",
            borderRadius: 12,
            background: "var(--bg-1)",
            padding: 10,
          }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (waBlocked) return;
              // Enter sends, Shift+Enter inserts a newline (standard chat UX).
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                handleSend();
              }
            }}
            disabled={waBlocked}
            placeholder={
              waBlocked
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
              >
                {tx("Use template", "استخدم قالبًا")}
              </button>
            </div>
          )}
          {attachedMedia && (
            <AttachmentPreview
              media={attachedMedia}
              onRemove={() => setAttachedMedia(null)}
              label={tx("Attached", "مرفق")}
            />
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
            <button
              type="button"
              className="btn ghost icon sm"
              onClick={() => setPickerOpen(true)}
              title={tx("Attach image", "إرفاق صورة")}
              aria-label={tx("Attach image", "إرفاق صورة")}
              style={{
                color: attachedMedia ? "var(--accent)" : undefined,
              }}
            >
              <IconAttach w={14} />
            </button>
            <button className="btn ghost icon sm">
              <IconTemplate w={14} />
            </button>
            <button className="btn ghost sm">
              <IconSparkles w={12} />
              {tx("Improve", "حسّن")}
            </button>
            <span
              className="muted mono"
              style={{ fontSize: 11, marginInlineStart: "auto" }}
            >
              {tx("Replying as", "يرد بصفة")}:{" "}
              <strong style={{ color: "var(--ink-1)" }}>
                {user?.name ?? tx("you", "أنت")}
              </strong>
            </span>
            <button
              className="btn primary"
              onClick={handleSend}
              disabled={
                sending ||
                waBlocked ||
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
        <WhatsAppTemplatePicker
          open={templatePickerOpen}
          onClose={() => setTemplatePickerOpen(false)}
          onSend={async (name, language, variables) => {
            await onSendTemplate(name, language, variables);
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

function MessageAttachment({ value }: { value: string }) {
  const isUrl = /^https?:\/\//i.test(value);
  if (isUrl) {
    return (
      <a
        href={value}
        target="_blank"
        rel="noreferrer"
        style={{ display: "block", marginTop: 6 }}
      >
        <img
          src={value}
          alt="attachment"
          style={{
            maxWidth: 260,
            maxHeight: 260,
            borderRadius: 8,
            display: "block",
          }}
        />
      </a>
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
    <img
      src={src}
      alt={alt}
      style={{
        maxWidth: 260,
        maxHeight: 260,
        borderRadius: 8,
        display: "block",
      }}
    />
  );
}

interface ApprovedTemplate {
  id: string;
  name: string;
  lang: string;
  category: string;
  status: string;
  body?: string | null;
}

/**
 * Modal that lists APPROVED WhatsApp templates and lets the operator fill the
 * BODY component's {{1}}, {{2}}, … placeholders before sending. Only templates
 * with status === "approved" can actually be delivered; we filter the list
 * accordingly so the user can't pick a pending/rejected one and get a Meta
 * error at send time.
 */
function WhatsAppTemplatePicker({
  open,
  onClose,
  onSend,
}: {
  open: boolean;
  onClose: () => void;
  onSend: (name: string, language: string, variables: string[]) => Promise<void>;
}) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const listQ = useFetch<ApprovedTemplate[]>(open ? "/templates" : null);
  const items = (listQ.data ?? []).filter((tpl) => tpl.status === "approved");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [vars, setVars] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = items.find((tpl) => tpl.id === selectedId) ?? null;

  // Parse {{1}}, {{2}}, … placeholders out of the body so we know how many
  // variable inputs to show. Returns the highest index seen.
  const variableCount = useMemo(() => {
    if (!selected?.body) return 0;
    const matches = selected.body.matchAll(/\{\{(\d+)\}\}/g);
    let max = 0;
    for (const m of matches) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
    return max;
  }, [selected]);

  useEffect(() => {
    // Reset variable inputs when a different template is picked.
    setVars(Array.from({ length: variableCount }, () => ""));
    setError(null);
  }, [selectedId, variableCount]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !sending) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, sending, onClose]);

  if (!open) return null;

  const canSend =
    selected !== null &&
    !sending &&
    vars.slice(0, variableCount).every((v) => v.trim().length > 0);

  const handleSend = async () => {
    if (!selected) return;
    setSending(true);
    setError(null);
    try {
      await onSend(
        selected.name,
        selected.lang,
        vars.slice(0, variableCount).map((v) => v.trim()),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSending(false);
    }
  };

  // Live preview of what the customer will see, with variables substituted.
  const preview = useMemo(() => {
    if (!selected?.body) return "";
    return selected.body.replace(/\{\{(\d+)\}\}/g, (_, idx) => {
      const i = parseInt(idx, 10) - 1;
      const v = vars[i]?.trim();
      return v || `{{${idx}}}`;
    });
  }, [selected, vars]);

  return (
    <Modal
      onClose={sending ? () => {} : onClose}
      width={640}
      label={tx("Send a WhatsApp template", "أرسل قالب واتساب")}
      panelStyle={{
        padding: 0,
        maxHeight: "min(640px, 88vh)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
        <div
          style={{
            padding: "14px 16px",
            borderBottom: "1px solid var(--line-soft)",
          }}
        >
          <h3 style={{ margin: 0, fontSize: 15 }}>
            {tx("Send a WhatsApp template", "أرسل قالب واتساب")}
          </h3>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>
            {tx(
              "Templates must be APPROVED by Meta. Submit new ones from the Templates screen.",
              "يجب أن تكون القوالب معتمدة من Meta. أضف قوالب جديدة من شاشة القوالب.",
            )}
          </div>
        </div>

        <div
          style={{
            flex: 1,
            display: "grid",
            gridTemplateColumns: "minmax(180px, 220px) 1fr",
            minHeight: 0,
          }}
        >
          {/* Template list */}
          <div
            style={{
              borderInlineEnd: "1px solid var(--line-soft)",
              overflowY: "auto",
              padding: 8,
            }}
          >
            {listQ.loading && items.length === 0 ? (
              <div className="mono muted" style={{ fontSize: 11, padding: 8 }}>
                {tx("loading…", "جارٍ التحميل…")}
              </div>
            ) : items.length === 0 ? (
              <div className="mono muted" style={{ fontSize: 11, padding: 8 }}>
                {tx(
                  "No approved templates yet.",
                  "لا توجد قوالب معتمدة بعد.",
                )}
              </div>
            ) : (
              items.map((tpl) => {
                const isActive = selectedId === tpl.id;
                return (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => setSelectedId(tpl.id)}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "start",
                      padding: "8px 10px",
                      borderRadius: 8,
                      background: isActive ? "var(--accent-soft)" : "transparent",
                      border: isActive
                        ? "1px solid var(--accent-ring)"
                        : "1px solid transparent",
                      cursor: "pointer",
                      marginBottom: 2,
                      fontFamily: "inherit",
                      color: "var(--ink)",
                    }}
                  >
                    <div style={{ fontSize: 12, fontWeight: 500 }}>
                      {tpl.name}
                    </div>
                    <div
                      className="mono"
                      style={{
                        fontSize: 10,
                        color: "var(--ink-3)",
                        marginTop: 2,
                      }}
                    >
                      {tpl.lang.toUpperCase()} · {tpl.category.toLowerCase()}
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {/* Preview + variables */}
          <div style={{ overflowY: "auto", padding: 16 }}>
            {!selected ? (
              <div
                className="mono muted"
                style={{ fontSize: 12, opacity: 0.7 }}
              >
                {tx(
                  "Pick a template on the left.",
                  "اختر قالبًا من القائمة.",
                )}
              </div>
            ) : (
              <>
                <div
                  className="mono"
                  style={{
                    fontSize: 10,
                    color: "var(--ink-3)",
                    textTransform: "uppercase",
                    letterSpacing: 0.06,
                  }}
                >
                  {tx("Preview", "معاينة")}
                </div>
                <div
                  style={{
                    marginTop: 6,
                    padding: 10,
                    background: "var(--bg-2)",
                    border: "1px solid var(--line-soft)",
                    borderRadius: 8,
                    fontSize: 13,
                    lineHeight: 1.5,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {preview || (
                    <span className="muted">
                      {tx("(empty body)", "(بدون نص)")}
                    </span>
                  )}
                </div>

                {variableCount > 0 && (
                  <>
                    <div
                      className="mono"
                      style={{
                        fontSize: 10,
                        color: "var(--ink-3)",
                        textTransform: "uppercase",
                        letterSpacing: 0.06,
                        marginTop: 16,
                      }}
                    >
                      {tx("Variables", "المتغيرات")}
                    </div>
                    <div
                      style={{
                        marginTop: 6,
                        display: "flex",
                        flexDirection: "column",
                        gap: 6,
                      }}
                    >
                      {Array.from({ length: variableCount }, (_, i) => (
                        <label
                          key={i}
                          style={{ display: "flex", flexDirection: "column", gap: 2 }}
                        >
                          <span
                            className="mono"
                            style={{ fontSize: 10, color: "var(--ink-3)" }}
                          >
                            {`{{${i + 1}}}`}
                          </span>
                          <input
                            value={vars[i] ?? ""}
                            onChange={(e) => {
                              const next = [...vars];
                              next[i] = e.target.value;
                              setVars(next);
                            }}
                            placeholder={tx(
                              `Value for {{${i + 1}}}`,
                              `قيمة {{${i + 1}}}`,
                            )}
                            style={{
                              height: 30,
                              padding: "0 10px",
                              background: "var(--bg-1)",
                              border: "1px solid var(--line)",
                              borderRadius: 6,
                              color: "var(--ink)",
                              fontSize: 13,
                              outline: "none",
                              fontFamily: "inherit",
                            }}
                          />
                        </label>
                      ))}
                    </div>
                  </>
                )}

                {error && (
                  <div
                    style={{
                      marginTop: 12,
                      padding: "8px 10px",
                      borderRadius: 6,
                      background: "color-mix(in oklch, var(--bad) 10%, transparent)",
                      color: "var(--bad)",
                      fontSize: 12,
                      border: "1px solid color-mix(in oklch, var(--bad) 30%, transparent)",
                    }}
                  >
                    {error}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <div
          style={{
            padding: "10px 14px",
            borderTop: "1px solid var(--line-soft)",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <button
            type="button"
            className="btn ghost"
            onClick={onClose}
            disabled={sending}
          >
            {tx("Cancel", "إلغاء")}
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={handleSend}
            disabled={!canSend}
          >
            {sending ? tx("Sending…", "جارٍ الإرسال…") : tx("Send template", "إرسال القالب")}
          </button>
        </div>
    </Modal>
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
  const agent = findAgent(conv.agent);

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
        <div style={{ fontSize: 16, fontWeight: 600 }}>{contact?.name}</div>
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
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
          {lifecycleStages.map((s, i) => (
            <div key={s} style={{ flex: 1, textAlign: "center" }}>
              <div
                style={{
                  height: 4,
                  background: i <= 2 ? "var(--accent)" : "var(--bg-2)",
                  marginInline: 1,
                  opacity: i <= 2 ? 0.4 + i * 0.2 : 1,
                }}
              />
              <div
                style={{
                  fontSize: 10,
                  marginTop: 6,
                  color: i === 2 ? "var(--accent)" : "var(--ink-3)",
                  fontWeight: i === 2 ? 600 : 400,
                }}
              >
                {s}
              </div>
            </div>
          ))}
        </div>
      </div>

      {agent && (
        <div>
          <SectionLabel>{tx("AI assignment", "الوكيل المخصص")}</SectionLabel>
          <div
            style={{
              marginTop: 8,
              padding: 10,
              borderRadius: 10,
              border: "1px solid var(--line-soft)",
              display: "flex",
              gap: 10,
              alignItems: "center",
            }}
          >
            <Avatar agent={agent} ai size="lg" />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 500 }}>{agent.name}</div>
              <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{agent.role}</div>
            </div>
            <button className="btn ghost sm">
              <IconChevDown w={12} />
            </button>
          </div>
        </div>
      )}

      {contact && contact.industry !== "facebook-dm" && (
        <ContactTickets contactId={contact.id} tx={tx} />
      )}

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

function InboxImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const [filter, setFilter] = useState<FilterId>("all");
  const [activeId, setActiveId] = useState<string | null>(null);
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

  // Reference AGENTS so the import isn't unused (keeps the relationship between
  // inbox conversations and seeded agent list explicit).
  void AGENTS;

  // ─── Data ──────────────────────────────────────────────────────────────
  // Realtime push (socket.io) keeps the inbox in sync; the polls below are a
  // slow safety net for missed events (network blip, server restart).
  const convsQ = useFetch<Conversation[]>("/conversations", { pollMs: 30000 });
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
  useRealtime<{ channel: string; conversationId?: string }>(
    "inbox.activity",
    (evt) => {
      const ch = evt.channel;
      const affectsActive =
        (ch === "whatsapp" && activeId === evt.conversationId) ||
        (ch === "facebook" && isFbConvId(activeId)) ||
        (ch === "instagram" && isIgConvId(activeId));
      if (affectsActive) setMessageVersion((v) => v + 1);
      if (ch === "facebook") fbConvsQ.refetch();
      else if (ch === "instagram") igConvsQ.refetch();
      else convsQ.refetch();
    },
  );

  // Conversations come from two sources:
  //   1. /conversations — DB rows (WhatsApp webhooks + Instagram sync + any future
  //      channel that writes to the DB).
  //   2. /integrations/facebook/conversations — Facebook DMs fetched LIVE from
  //      Graph API (not persisted to DB yet).
  // We MERGE them so all channels appear in the unified list.
  const conversations: Conversation[] = useMemo(() => {
    const dbRows = convsQ.data ?? [];
    // Drop DB rows for FB + IG so the live lists are authoritative for those
    // channels. (Old IG rows from when the inbox used DB sync stay in the DB
    // but no longer surface in the UI to avoid duplicates.)
    const nonLive = dbRows.filter(
      (c) => c.channel !== "facebook" && c.channel !== "instagram",
    );

    const fbRows: Conversation[] = fbConnected
      ? (fbConvsQ.data ?? []).map((c) => ({
          id: c.id,
          contactId: c.contactId ?? c.id,
          agent: "",
          unread: c.unread,
          pinned: false,
          lastAt: fmtCompact(c.updatedAt),
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
          lastFrom: "them",
          preview: c.snippet || "—",
          channel: "instagram",
          status: "human",
          intent: "—",
          confidence: 0,
          escalated: false,
        }))
      : [];

    // DB rows arrive ordered (pinned desc, then updatedAt desc). Live rows
    // merged in raw order; close-enough until everything lives in one store.
    return [...nonLive, ...fbRows, ...igRows];
  }, [fbConnected, convsQ.data, fbConvsQ.data, igConnected, igConvsQ.data]);

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
        lifecycle: "Lead",
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
        lifecycle: "Lead",
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
    if (activeId !== null) return;
    if (conversations.length > 0) {
      setActiveId(conversations[0]!.id);
    }
  }, [conversations, activeId]);

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

  // Mark-as-read whenever the active conversation changes.  Skip for FB
  // threads (no equivalent endpoint, and they aren't tracked in our DB).
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

  const filtered = useMemo<Conversation[]>(() => {
    let list: Conversation[];
    switch (filter) {
      case "ai":
        list = conversations.filter((c) => c.status === "ai");
        break;
      case "human":
        list = conversations.filter((c) => c.status === "human");
        break;
      case "closed":
        list = conversations.filter((c) => c.status === "closed");
        break;
      case "spam":
        list = conversations.filter((c) => c.status === "spam");
        break;
      case "unread":
        list = conversations.filter((c) => c.unread > 0);
        break;
      case "all":
      default:
        list = conversations;
        break;
    }
    if (channels.size === 0) return list;
    return list.filter((c) => channels.has(c.channel));
  }, [filter, channels, conversations]);

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
    },
    { ok: true; wamid?: string }
  >((input) =>
    api.post(
      `/integrations/whatsapp/conversations/${input.conversationId}/send-template`,
      {
        name: input.name,
        language: input.language,
        variables: input.variables,
      },
    ),
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
    // Route by channel for DB-stored conversations.
    const conv = (convsQ.data ?? []).find((c) => c.id === activeId);
    if (conv?.channel === "instagram") {
      await sendIgMessage.mutate({ conversationId: activeId, body, mediaId });
    } else if (conv?.channel === "whatsapp") {
      await sendWaMessage.mutate({ conversationId: activeId, body, mediaId });
    } else {
      // Fallback: just write to DB (web chat, etc.)
      await sendMessage.mutate({ conversationId: activeId, body });
    }
    setMessageVersion((n) => n + 1);
    convsQ.refetch();
    activeQ.refetch();
  };

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
    return activeQ.data ?? undefined;
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
      style={{
        display: "grid",
        gridTemplateColumns: "320px 1fr 340px",
        flex: 1,
        minHeight: 0,
        position: "relative",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateRows: "auto 1fr",
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
          channels={channels}
          toggleChannel={toggleChannel}
          convs={filtered}
          allConvs={conversations}
          activeId={activeId}
          setActiveId={setActiveId}
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
      {active ? (
        <ConversationPane
          conv={active}
          contactById={contactById}
          onSend={handleSend}
          onSendTemplate={async (name, language, variables) => {
            if (!activeId) return;
            await sendWaTemplate.mutate({
              conversationId: activeId,
              name,
              language,
              variables,
            });
            setMessageVersion((n) => n + 1);
            convsQ.refetch();
            activeQ.refetch();
          }}
          sending={
            sendMessage.loading ||
            sendFbMessage.loading ||
            sendIgMessage.loading ||
            sendIgLiveMessage.loading ||
            sendWaMessage.loading ||
            sendWaTemplate.loading
          }
          sendError={
            sendMessage.error ??
            sendFbMessage.error ??
            sendIgMessage.error ??
            sendIgLiveMessage.error ??
            sendWaMessage.error ??
            sendWaTemplate.error
          }
          onConvertToTicket={() => setShowConvertModal(true)}
          onToggleAiPaused={async (paused) => {
            if (!active) return;
            if (paused) {
              await api.post(`/conversations/${active.id}/ai/pause`);
            } else {
              await api.delete(`/conversations/${active.id}/ai/pause`);
            }
            activeQ.refetch();
            convsQ.refetch();
          }}
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
      {active ? (
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
