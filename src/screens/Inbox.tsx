import { memo, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx, type Tx } from "@/lib/tx";
import { Avatar } from "@/components/Avatar";
import { Badge, type BadgeKind } from "@/components/Badge";
import { ConvRowSkeleton, MessageSkeleton } from "@/components/Skeleton";
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
} from "@/icons";
import { AGENTS, findAgent } from "@/data/agents";
import { api } from "@/api/client";
import { useFetch, useMutation } from "@/api/useFetch";
import {
  CHANNEL_LABEL,
  type Agent,
  type Contact,
  type ConvChannel,
  type Conversation,
  type Message,
  type Pipeline,
  type StageColor,
  type Ticket,
  type TicketStage,
} from "@/lib/types";

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
  onSend: (body: string) => Promise<void>;
  sending: boolean;
  sendError: string | null;
  onConvertToTicket: () => void;
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
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "oklch(0 0 0 / 0.5)",
        display: "grid",
        placeItems: "center",
        zIndex: 100,
        backdropFilter: "blur(2px)",
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ width: 480, padding: 20 }}
        onClick={(e) => e.stopPropagation()}
      >
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
      </div>
    </div>
  );
}

interface ContactTicketsProps {
  contactId: string;
  tx: Tx;
}

function ContactTickets({ contactId, tx }: ContactTicketsProps) {
  const ticketsQ = useFetch<Ticket[]>(`/tickets?contactId=${contactId}`);
  // Don't render the section on error.
  if (ticketsQ.error) return null;

  const tickets = ticketsQ.data ?? [];

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
  const filters: FilterDef[] = [
    { id: "all", label: tx("All", "الكل"), count: allConvs.length },
    { id: "ai", label: tx("AI handled", "ذكاء"), count: allConvs.filter((c) => c.status === "ai").length, kind: "ai" },
    { id: "human", label: tx("Assigned", "معيّنة"), count: allConvs.filter((c) => c.status === "human").length, kind: "human" },
    { id: "unread", label: tx("Unread", "غير مقروءة"), count: allConvs.filter((c) => c.unread > 0).length },
    { id: "closed", label: tx("Closed", "مغلقة"), count: allConvs.filter((c) => c.status === "closed").length },
    { id: "spam", label: tx("Spam", "مزعجة"), count: allConvs.filter((c) => c.status === "spam").length },
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
        {loading && allConvs.length === 0 && (
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
        {convs.map((c) => {
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
                <Avatar name="Yara" color="150" size="sm" />
                <span style={{ fontSize: 11, fontWeight: 500 }}>Yara</span>
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
          {m.attach && (
            <div
              style={{
                marginTop: 6,
                padding: "8px 10px",
                border: "1px dashed var(--line)",
                borderRadius: 8,
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontFamily: "var(--font-mono)",
                fontSize: 11,
              }}
            >
              <IconBook w={12} />
              {m.attach}
            </div>
          )}
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
          {m.t} {isOut && "✓✓"}
        </div>
      </div>
    </div>
  );
}

function ConversationPane({
  conv,
  contactById,
  onSend,
  sending,
  sendError,
  onConvertToTicket,
  tx,
}: ConversationPaneProps) {
  const contact = contactById.get(conv.contactId);
  const agent = findAgent(conv.agent);
  const [draft, setDraft] = useState<string>("");

  const messages: Message[] =
    conv.messages.length > 0
      ? conv.messages
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
    if (!body || sending) return;
    onSend(body)
      .then(() => setDraft(""))
      .catch(() => {
        // error surfaced via sendError
      });
  };

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
          <button className="btn">
            <IconHand w={14} />
            {tx("Take over", "تولّى")}
          </button>
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
        {messages.map((m, i) => (
          <Bubble key={`${conv.id}-${i}`} m={m} agent={agent} />
        ))}
      </div>

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
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={tx("Type a reply…", "اكتب ردًّا…")}
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
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
            <button className="btn ghost icon sm">
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
              <strong style={{ color: "var(--ink-1)" }}>Yara</strong>
            </span>
            <button
              className="btn primary"
              onClick={handleSend}
              disabled={sending || draft.trim().length === 0}
            >
              <IconSend w={13} />
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
      `}</style>
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

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <button className="btn">
          <IconPhone w={13} />
          {tx("Call", "اتصال")}
        </button>
        <button className="btn">
          <IconBook w={13} />
          {tx("Notes", "ملاحظات")}
        </button>
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
  contactId?: string;     // FB user id of the OTHER participant
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

function InboxImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const [filter, setFilter] = useState<FilterId>("all");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [channels, setChannels] = useState<Set<ConvChannel>>(
    () => new Set<ConvChannel>(CHANNELS),
  );
  const [messageVersion, setMessageVersion] = useState<number>(0);
  const [showConvertModal, setShowConvertModal] = useState<boolean>(false);
  const [ticketBanner, setTicketBanner] = useState<{ number: number; visible: boolean } | null>(
    null,
  );

  // Reference AGENTS so the import isn't unused (keeps the relationship between
  // inbox conversations and seeded agent list explicit).
  void AGENTS;

  // ─── Data ──────────────────────────────────────────────────────────────
  const convsQ = useFetch<Conversation[]>("/conversations");
  const contactsQ = useFetch<Contact[]>("/contacts");

  // Live Facebook Messenger: only fetch when integration is connected.
  const fbStatusQ = useFetch<FbStatus>("/integrations/facebook/status");
  const fbConnected = fbStatusQ.data?.connected === true;
  const fbConvsQ = useFetch<FbConv[]>(
    fbConnected ? "/integrations/facebook/conversations" : null,
  );
  const fbMsgsQ = useFetch<FbMsg[]>(
    fbConnected && isFbConvId(activeId)
      ? `/integrations/facebook/conversations/${activeId}/messages`
      : null,
    { key: `${activeId ?? "none"}:${messageVersion}` },
  );

  // Internal active query: skip when activeId is a Facebook thread id.
  const activeQ = useFetch<ConversationDetail>(
    activeId && !isFbConvId(activeId) ? `/conversations/${activeId}` : null,
    { key: `${activeId ?? "none"}:${messageVersion}` },
  );

  // Conversations: real Facebook DMs only when the integration is connected;
  // fall back to internal /conversations rows only when FB isn't connected
  // (so the app still has something to show in that case).
  const conversations: Conversation[] = useMemo(() => {
    if (fbConnected) {
      const fb = fbConvsQ.data ?? [];
      const rows: Conversation[] = fb.map((c) => ({
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
      }));
      rows.sort((a, b) => {
        const av = fb.find((x) => x.id === a.id)?.updatedAt ?? "";
        const bv = fb.find((x) => x.id === b.id)?.updatedAt ?? "";
        return bv.localeCompare(av);
      });
      return rows;
    }
    return convsQ.data ?? [];
  }, [fbConnected, convsQ.data, fbConvsQ.data]);

  // Augment contactById with synthetic Contact entries for FB participants so
  // the existing row/header renderers can resolve their names.
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
    return map;
  }, [contactsQ.data, fbConvsQ.data]);

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
    if (isFbConvId(activeId)) return;
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
  const sendFbMessage = useMutation<{ recipientId: string; body: string }, { messageId: string }>(
    (input) =>
      api.post<{ messageId: string }>(
        `/integrations/facebook/conversations/${input.recipientId}/send`,
        { message: input.body },
      ),
  );

  const handleSend = async (body: string): Promise<void> => {
    if (!activeId) return;
    if (isFbConvId(activeId)) {
      const fbConv = (fbConvsQ.data ?? []).find((c) => c.id === activeId);
      const recipientId = fbConv?.contactId;
      if (!recipientId) return;
      await sendFbMessage.mutate({ recipientId, body });
      setMessageVersion((n) => n + 1);
      fbConvsQ.refetch();
      return;
    }
    await sendMessage.mutate({ conversationId: activeId, body });
    setMessageVersion((n) => n + 1);
    convsQ.refetch();
  };

  // Compute the active conversation: either the internal /conversations/:id
  // result, or a synthetic one assembled from live Facebook DMs.
  const active: ConversationDetail | undefined = useMemo(() => {
    if (!activeId) return undefined;
    if (isFbConvId(activeId)) {
      const fbConv = (fbConvsQ.data ?? []).find((c) => c.id === activeId);
      if (!fbConv) return undefined;
      const messages: Message[] = (fbMsgsQ.data ?? []).map((m) => ({
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
        messages,
      };
    }
    return activeQ.data ?? undefined;
  }, [activeId, fbConvsQ.data, fbMsgsQ.data, activeQ.data]);

  const activeContact = active ? contactById.get(active.contactId) : undefined;
  const activeIsFb = active ? isFbConvId(active.id) : false;

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
          loading={convsQ.loading}
          error={convsQ.error}
          onRetry={convsQ.refetch}
          tx={tx}
        />
      </div>
      {active ? (
        <ConversationPane
          conv={active}
          contactById={contactById}
          onSend={handleSend}
          sending={sendMessage.loading || sendFbMessage.loading}
          sendError={sendMessage.error ?? sendFbMessage.error}
          onConvertToTicket={() => setShowConvertModal(true)}
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
