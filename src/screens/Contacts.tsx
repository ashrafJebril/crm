import {
  memo,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type DragEvent,
  type FormEvent,
} from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx, type Tx } from "@/lib/tx";
import { PageHeader } from "@/components/PageHeader";
import { Avatar } from "@/components/Avatar";
import { Badge, type BadgeKind } from "@/components/Badge";
import {
  IconArchive,
  IconCampaign,
  IconFilter,
  IconMore,
  IconPlus,
  IconTag,
} from "@/icons";
import { api } from "@/api/client";
import { useFetch, useMutation } from "@/api/useFetch";
import { Modal } from "@/components/Modal";
import type { Contact, Segment, TagRow } from "@/lib/types";
import { ContactDetailDrawer } from "./contacts/ContactDetailDrawer";
import { SegmentManager } from "./contacts/SegmentManager";
import { GroupsTab } from "./contacts/GroupsTab";

type ContactsTabId = "contacts" | "groups" | "tags";

interface TagsTabProps {
  tx: Tx;
}

function TagsTab(_props: TagsTabProps) {
  return <div />;
}

type View = "table" | "pipeline";

const INPUT_STYLE: CSSProperties = {
  height: 32,
  padding: "0 10px",
  borderRadius: 8,
  background: "var(--bg-1)",
  border: "1px solid var(--line-soft)",
  color: "var(--ink)",
  fontSize: 13,
  outline: 0,
  fontFamily: "inherit",
};

const MODAL_INPUT_STYLE: CSSProperties = {
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

const MODAL_LABEL_STYLE: CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  color: "var(--ink-3)",
  marginTop: 12,
  display: "block",
};

interface ContactsTableProps {
  tx: Tx;
  contacts: Contact[];
  selected: Set<string>;
  setSelected: (next: Set<string>) => void;
  onBulkDelete: () => void;
  onBulkTag: () => void;
  bulkDeleting: boolean;
  onOpenContact: (id: string) => void;
  manualGroups: Segment[];
  onAddToGroup: (segmentId: string) => void;
  addToGroupError: string | null;
  tagColorByName: Map<string, string>;
  lang: string;
}

function tagKind(tag: string): BadgeKind {
  if (tag === "VIP") return "warn";
  if (tag === "Hot") return "bad";
  return "";
}

function ContactsTable({
  tx,
  contacts,
  selected,
  setSelected,
  onBulkDelete,
  onBulkTag,
  bulkDeleting,
  onOpenContact,
  manualGroups,
  onAddToGroup,
  addToGroupError,
  tagColorByName,
  lang,
}: ContactsTableProps) {
  const [groupPick, setGroupPick] = useState("");
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      {selected.size > 0 && (
        <div
          style={{
            padding: "10px 14px",
            borderBottom: "1px solid var(--line-soft)",
            background: "var(--accent-soft)",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span style={{ fontSize: 13, color: "var(--accent)", fontWeight: 500 }}>
            {selected.size} {tx("selected", "محدد")}
          </span>
          <span style={{ flex: 1 }} />
          {addToGroupError && (
            <span style={{ fontSize: 11, color: "var(--bad)" }}>{addToGroupError}</span>
          )}
          <button className="btn sm" onClick={onBulkTag}>
            <IconTag w={12} />
            {tx("Tag", "وسم")}
          </button>
          <select
            value={groupPick}
            onChange={(e) => {
              const id = e.target.value;
              setGroupPick("");
              if (id) onAddToGroup(id);
            }}
            style={{ ...INPUT_STYLE, height: 28, width: 168 }}
          >
            <option value="">{tx("Add to group…", "أضف إلى مجموعة…")}</option>
            {manualGroups.map((g) => (
              <option key={g.id} value={g.id}>
                {lang === "ar" ? g.nameAr || g.name : g.name}
              </option>
            ))}
          </select>
          <button className="btn sm">
            <IconCampaign w={12} />
            {tx("Add to campaign", "حملة")}
          </button>
          <button
            className="btn sm"
            onClick={onBulkDelete}
            disabled={bulkDeleting}
          >
            <IconArchive w={12} />
            {bulkDeleting
              ? tx("Deleting…", "جارٍ الحذف…")
              : tx("Delete", "حذف")}
          </button>
        </div>
      )}
      <table className="tbl">
        <thead>
          <tr>
            <th style={{ width: 30 }}>
              <input type="checkbox" />
            </th>
            <th>{tx("Name", "الاسم")}</th>
            <th>{tx("Phone", "الهاتف")}</th>
            <th>{tx("Tags", "الوسوم")}</th>
            <th>{tx("Lifecycle", "المرحلة")}</th>
            <th>{tx("Source", "المصدر")}</th>
            <th>{tx("Convs", "محادثات")}</th>
            <th>{tx("Value", "القيمة")}</th>
            <th>{tx("Last seen", "آخر ظهور")}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {contacts.map((c) => (
            <tr
              key={c.id}
              className={selected.has(c.id) ? "selected" : ""}
              onClick={() => onOpenContact(c.id)}
              style={{ cursor: "pointer" }}
            >
              <td onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={selected.has(c.id)}
                  onChange={() => toggle(c.id)}
                />
              </td>
              <td>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Avatar
                    name={c.name}
                    color={String(150 + (c.id.charCodeAt(1) || 0) * 6)}
                  />
                  <div>
                    <div style={{ fontWeight: 500 }}>{c.name}</div>
                    <div className="muted" style={{ fontSize: 11 }}>
                      {c.industry}
                    </div>
                  </div>
                </div>
              </td>
              <td className="mono muted" style={{ fontSize: 12 }}>
                {c.phone}
              </td>
              <td>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {c.tags.map((tg) => {
                    const hue = tagColorByName.get(tg);
                    return hue ? (
                      <span
                        key={tg}
                        style={{
                          fontSize: 11, padding: "2px 8px", borderRadius: 999,
                          background: `hsl(${hue} 70% 45% / 0.15)`,
                          color: `hsl(${hue} 70% 35%)`,
                          border: `1px solid hsl(${hue} 70% 45% / 0.35)`,
                        }}
                      >
                        {tg}
                      </span>
                    ) : (
                      <Badge key={tg} kind={tagKind(tg)}>{tg}</Badge>
                    );
                  })}
                </div>
              </td>
              <td>
                <span className="mono" style={{ fontSize: 12 }}>
                  {c.lifecycle}
                </span>
              </td>
              <td className="muted">{c.source}</td>
              <td className="mono">{c.convs}</td>
              <td className="mono">{c.value}</td>
              <td className="mono muted">{c.lastSeen}</td>
              <td onClick={(e) => e.stopPropagation()}>
                <button className="btn ghost icon sm">
                  <IconMore w={14} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface PipelineCard {
  id: string;
  name: string;
  desc: string;
  value: string;
  days: string;
}

type StageId = "new" | "qualified" | "proposal" | "won" | "lost";

interface Stage {
  id: StageId;
  label: string;
  color: string;
  count: number;
}

interface PipelineProps {
  tx: Tx;
  contacts: Contact[];
}

function Pipeline({ tx, contacts }: PipelineProps) {
  const stages: Stage[] = useMemo(
    () => [
      { id: "new", label: tx("New", "جديد"), color: "var(--ink-3)", count: 184 },
      {
        id: "qualified",
        label: tx("Qualified", "مؤهل"),
        color: "var(--info)",
        count: 92,
      },
      { id: "proposal", label: tx("Proposal", "عرض"), color: "var(--accent)", count: 41 },
      { id: "won", label: tx("Won", "فاز"), color: "var(--ok)", count: 28 },
      { id: "lost", label: tx("Lost", "خسر"), color: "var(--bad)", count: 17 },
    ],
    [tx],
  );

  // Seed initial cards from the first ~10 fetched contacts. We bucket them by
  // lifecycle as a heuristic since the backend doesn't yet have a "stage" field.
  const initial = useMemo<Record<StageId, PipelineCard[]>>(() => {
    const empty: Record<StageId, PipelineCard[]> = {
      new: [],
      qualified: [],
      proposal: [],
      won: [],
      lost: [],
    };
    const slice = contacts.slice(0, 10);
    slice.forEach((c) => {
      const lc = c.lifecycle.toLowerCase();
      let stage: StageId = "new";
      if (lc.includes("customer") || lc.includes("patient")) stage = "won";
      else if (lc.includes("lead") && c.tags.includes("Hot")) stage = "qualified";
      else if (lc.includes("lead") && c.tags.includes("Trial")) stage = "qualified";
      else if (lc.includes("lead")) stage = "new";
      empty[stage].push({
        id: c.id,
        name: c.name,
        desc: `${c.industry} · ${c.source}`,
        value: c.value || "—",
        days: c.lastSeen || "—",
      });
    });
    return empty;
  }, [contacts]);

  const [board, setBoard] = useState<Record<StageId, PipelineCard[]>>(initial);
  const [dragging, setDragging] = useState<{ from: StageId; cardId: string } | null>(
    null,
  );
  const [over, setOver] = useState<StageId | null>(null);

  // Re-seed when the source contacts change (e.g. after refetch).
  useEffect(() => {
    setBoard(initial);
  }, [initial]);

  const onDragStart = (from: StageId, cardId: string) => () => {
    setDragging({ from, cardId });
  };

  const onDragOver = (stage: StageId) => (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (over !== stage) setOver(stage);
  };

  const onDrop = (to: StageId) => (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(null);
    if (!dragging) return;
    const { from, cardId } = dragging;
    if (from === to) {
      setDragging(null);
      return;
    }
    setBoard((prev) => {
      const card = prev[from].find((c) => c.id === cardId);
      if (!card) return prev;
      return {
        ...prev,
        [from]: prev[from].filter((c) => c.id !== cardId),
        [to]: [card, ...prev[to]],
      };
    });
    setDragging(null);
  };

  return (
    <div style={{ overflowX: "auto", paddingBottom: 12 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${stages.length}, 280px)`,
          gap: 12,
        }}
      >
        {stages.map((s) => {
          const cards = board[s.id] || [];
          const isOver = over === s.id;
          return (
            <div
              key={s.id}
              onDragOver={onDragOver(s.id)}
              onDragLeave={() => setOver((curr) => (curr === s.id ? null : curr))}
              onDrop={onDrop(s.id)}
              style={{
                background: isOver ? "var(--accent-soft)" : "var(--bg-1)",
                border: `1px solid ${isOver ? "var(--accent-ring)" : "var(--line-soft)"}`,
                borderRadius: 12,
                display: "flex",
                flexDirection: "column",
                transition: "background 0.12s, border-color 0.12s",
              }}
            >
              <div
                style={{
                  padding: "12px 14px",
                  borderBottom: "1px solid var(--line-soft)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    background: s.color,
                  }}
                />
                <span style={{ fontWeight: 500, fontSize: 13 }}>{s.label}</span>
                <span
                  className="mono"
                  style={{
                    fontSize: 11,
                    color: "var(--ink-3)",
                    marginInlineStart: "auto",
                  }}
                >
                  {cards.length || s.count}
                </span>
                <button className="btn ghost icon sm">
                  <IconPlus w={12} />
                </button>
              </div>
              <div
                style={{
                  padding: 8,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  minHeight: 200,
                }}
              >
                {cards.map((card, i) => (
                  <div
                    key={card.id}
                    draggable
                    onDragStart={onDragStart(s.id, card.id)}
                    style={{
                      background: "var(--bg-elev)",
                      border: "1px solid var(--line-soft)",
                      borderRadius: 8,
                      padding: 10,
                      cursor: "grab",
                      boxShadow: "var(--shadow-sm)",
                      opacity:
                        dragging?.from === s.id && dragging?.cardId === card.id
                          ? 0.4
                          : 1,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <Avatar
                        name={card.name}
                        color={String(120 + i * 30)}
                        size="sm"
                      />
                      <span style={{ fontWeight: 500, fontSize: 13, flex: 1 }}>
                        {card.name}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>
                      {card.desc}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        marginTop: 8,
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                      }}
                    >
                      <span style={{ color: "var(--accent)", fontWeight: 500 }}>
                        {card.value}
                      </span>
                      <span style={{ color: "var(--ink-3)" }}>{card.days}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface NewContactInput {
  name: string;
  phone: string;
  industry: string;
  lifecycle: string;
  source: string;
  value?: string;
  tags?: string[];
}

interface NewContactModalProps {
  tx: Tx;
  onClose: () => void;
  onCreated: () => void;
}

function NewContactModal({ tx, onClose, onCreated }: NewContactModalProps) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [industry, setIndustry] = useState("");
  const [lifecycle, setLifecycle] = useState("");
  const [source, setSource] = useState("");
  const [value, setValue] = useState("");
  const [tags, setTags] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!name.trim() || !phone.trim()) {
      setError(tx("Name and phone are required.", "الاسم والهاتف مطلوبان."));
      return;
    }
    const body: NewContactInput = {
      name: name.trim(),
      phone: phone.trim(),
      industry: industry.trim(),
      lifecycle: lifecycle.trim(),
      source: source.trim(),
      ...(value.trim() ? { value: value.trim() } : {}),
      tags: tags
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };
    setSubmitting(true);
    setError(null);
    const run = async () => {
      try {
        await api.post<Contact>("/contacts", body);
        onCreated();
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Request failed");
      } finally {
        setSubmitting(false);
      }
    };
    void run();
  };

  return (
    <Modal onClose={onClose} width={460} label="New contact">
      <form onSubmit={onSubmit}>
        <h3 style={{ margin: 0, fontSize: 16 }}>
          {tx("New contact", "جهة جديدة")}
        </h3>
        <p
          style={{
            margin: "4px 0 16px",
            color: "var(--ink-2)",
            fontSize: 13,
          }}
        >
          {tx(
            "Add a contact to your workspace.",
            "أضف جهة اتصال إلى مساحة العمل.",
          )}
        </p>

        <label className="mono" style={{ ...MODAL_LABEL_STYLE, marginTop: 0 }}>
          {tx("Name", "الاسم")}
        </label>
        <input
          className="input"
          style={MODAL_INPUT_STYLE}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Jane Doe"
        />

        <label className="mono" style={MODAL_LABEL_STYLE}>
          {tx("Phone", "الهاتف")}
        </label>
        <input
          className="input"
          style={MODAL_INPUT_STYLE}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+966 50 000 0000"
        />

        <label className="mono" style={MODAL_LABEL_STYLE}>
          {tx("Industry", "القطاع")}
        </label>
        <input
          className="input"
          style={MODAL_INPUT_STYLE}
          value={industry}
          onChange={(e) => setIndustry(e.target.value)}
          placeholder="real-estate"
        />

        <label className="mono" style={MODAL_LABEL_STYLE}>
          {tx("Lifecycle", "المرحلة")}
        </label>
        <input
          className="input"
          style={MODAL_INPUT_STYLE}
          value={lifecycle}
          onChange={(e) => setLifecycle(e.target.value)}
          placeholder="Lead"
        />

        <label className="mono" style={MODAL_LABEL_STYLE}>
          {tx("Source", "المصدر")}
        </label>
        <input
          className="input"
          style={MODAL_INPUT_STYLE}
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="Website"
        />

        <label className="mono" style={MODAL_LABEL_STYLE}>
          {tx("Value", "القيمة")}
        </label>
        <input
          className="input"
          style={MODAL_INPUT_STYLE}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="SAR 0"
        />

        <label className="mono" style={MODAL_LABEL_STYLE}>
          {tx("Tags (comma-separated)", "وسوم (بفواصل)")}
        </label>
        <input
          className="input"
          style={MODAL_INPUT_STYLE}
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="VIP, Riyadh"
        />

        {error && (
          <div
            style={{
              marginTop: 12,
              color: "var(--bad)",
              fontSize: 12,
            }}
          >
            {error}
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
          <button
            type="button"
            className="btn ghost"
            onClick={onClose}
            disabled={submitting}
          >
            {tx("Cancel", "إلغاء")}
          </button>
          <button type="submit" className="btn primary" disabled={submitting}>
            <IconPlus w={13} />
            {submitting ? tx("Saving…", "جارٍ الحفظ…") : tx("Create", "إنشاء")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ContactsImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const [activeTab, setActiveTab] = useState<ContactsTabId>("contacts");
  const [view, setView] = useState<View>("table");
  const [selected, setSelected] = useState<Set<string>>(new Set<string>());
  const [showNew, setShowNew] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [openContactId, setOpenContactId] = useState<string | null>(null);

  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [showSegmentManager, setShowSegmentManager] = useState(false);
  const [search, setSearch] = useState("");

  const contactsPath = activeSegmentId
    ? `/contacts?segmentId=${activeSegmentId}`
    : "/contacts";
  const { data, loading, error, refetch } = useFetch<Contact[]>(contactsPath);
  const allContacts = data ?? [];

  const {
    data: segmentsData,
    refetch: refetchSegments,
  } = useFetch<Segment[]>("/segments");
  const segments = segmentsData ?? [];
  const manualGroups = useMemo(
    () => segments.filter((s) => s.origin === "manual"),
    [segments],
  );

  const tagsQ = useFetch<TagRow[]>("/tags");
  const tagColorByName = useMemo(
    () => new Map((tagsQ.data ?? []).map((t) => [t.name, t.color])),
    [tagsQ.data],
  );

  // Total count for the "All" chip — fetched once without a segment filter so
  // the badge stays accurate even while a segment is active.
  const { data: allRowsForCount } = useFetch<Contact[]>("/contacts");
  const allCount = (allRowsForCount ?? []).length;

  // Local name-search applied on top of whatever the server returned (the
  // segment filter already narrowed by lifecycle/tags/etc).
  const contacts = useMemo(() => {
    if (!search.trim()) return allContacts;
    const q = search.trim().toLowerCase();
    return allContacts.filter((c) => c.name.toLowerCase().includes(q));
  }, [allContacts, search]);

  const showStatus = (msg: string) => {
    setStatusMsg(msg);
    window.setTimeout(() => setStatusMsg(null), 2000);
  };

  const [showBulkTag, setShowBulkTag] = useState(false);
  const [bulkTagging, setBulkTagging] = useState(false);

  const onBulkTag = () => {
    if (selected.size === 0) return;
    setShowBulkTag(true);
  };

  const applyBulkTags = (names: string[]) => {
    if (selected.size === 0 || bulkTagging) return;
    if (names.length === 0) {
      setShowBulkTag(false);
      return;
    }
    setBulkTagging(true);
    const run = async () => {
      try {
        const ids = Array.from(selected);
        await api.post<{ contactsUpdated: number }>("/tags/assign", {
          contactIds: ids,
          add: names,
        });
        setShowBulkTag(false);
        setSelected(new Set<string>());
        refetch();
        tagsQ.refetch();
        showStatus(
          tx(
            `Tagged ${ids.length} contact${ids.length === 1 ? "" : "s"}.`,
            `تم وسم ${ids.length} جهة.`,
          ),
        );
      } catch (err) {
        showStatus(
          err instanceof Error ? err.message : tx("Tag failed.", "فشل الوسم."),
        );
      } finally {
        setBulkTagging(false);
      }
    };
    void run();
  };

  const addToGroup = useMutation<
    { segmentId: string; contactIds: string[] },
    { added: number }
  >(({ segmentId, contactIds }) => api.post(`/segments/${segmentId}/members`, { contactIds }));

  const handleAddToGroup = (segmentId: string) => {
    if (selected.size === 0) return;
    void addToGroup
      .mutate({ segmentId, contactIds: Array.from(selected) })
      .then((res) => {
        setSelected(new Set<string>());
        refetchSegments();
        showStatus(
          tx(`Added ${res.added} contact${res.added === 1 ? "" : "s"} to group.`, `تمت إضافة ${res.added} جهة إلى المجموعة.`),
        );
      })
      .catch(() => {/* error surfaces via addToGroup.error; rendered in the bulk bar */});
  };

  const onBulkDelete = () => {
    if (selected.size === 0 || bulkDeleting) return;
    const ids = Array.from(selected);
    setBulkDeleting(true);
    const run = async () => {
      try {
        await Promise.all(
          ids.map((id) => api.delete<{ ok: true }>(`/contacts/${id}`)),
        );
        setSelected(new Set<string>());
        refetch();
        showStatus(
          tx(
            `Deleted ${ids.length} contact${ids.length === 1 ? "" : "s"}.`,
            `تم حذف ${ids.length} جهة.`,
          ),
        );
      } catch (err) {
        showStatus(
          err instanceof Error ? err.message : tx("Delete failed.", "فشل الحذف."),
        );
      } finally {
        setBulkDeleting(false);
      }
    };
    void run();
  };

  return (
    <div style={{ overflowY: "auto", flex: 1 }}>
      <PageHeader
        title={tx("Contacts", "جهات الاتصال")}
        subtitle={tx(
          "12,408 contacts · 2,184 leads · 9,612 customers",
          "١٢٬٤٠٨ جهة · ٢٬١٨٤ محتمل · ٩٬٦١٢ عميل",
        )}
        actions={
          <>
            <div
              style={{
                display: "flex",
                border: "1px solid var(--line)",
                borderRadius: 8,
                padding: 2,
              }}
            >
              <button
                onClick={() => setView("table")}
                style={{
                  background: view === "table" ? "var(--bg-2)" : "transparent",
                  border: 0,
                  padding: "0 10px",
                  height: 26,
                  borderRadius: 6,
                  color: "inherit",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                {tx("Table", "جدول")}
              </button>
              <button
                onClick={() => setView("pipeline")}
                style={{
                  background: view === "pipeline" ? "var(--bg-2)" : "transparent",
                  border: 0,
                  padding: "0 10px",
                  height: 26,
                  borderRadius: 6,
                  color: "inherit",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                {tx("Pipeline", "المسار")}
              </button>
            </div>
            <button className="btn primary" onClick={() => setShowNew(true)}>
              <IconPlus w={13} />
              {tx("New contact", "جهة جديدة")}
            </button>
          </>
        }
      />

      <div style={{ display: "flex", gap: 6, padding: "0 24px 10px" }}>
        {(
          [
            ["contacts", tx("Contacts", "جهات الاتصال")],
            ["groups", tx("Groups", "المجموعات")],
            ["tags", tx("Tags", "الوسوم")],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`btn sm ${activeTab === id ? "primary" : "ghost"}`.trim()}
            onClick={() => setActiveTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === "contacts" && (
      <div style={{ padding: "0 24px 24px", display: "grid", gap: 14 }}>
        <div
          style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
        >
          <SegmentChip
            label={tx("All", "الكل")}
            count={allCount}
            active={activeSegmentId === null}
            onClick={() => setActiveSegmentId(null)}
          />
          {segments.map((s) => (
            <SegmentChip
              key={s.id}
              label={t.lang === "ar" ? s.nameAr || s.name : s.name}
              count={s.count}
              active={activeSegmentId === s.id}
              color={s.color}
              onClick={() => setActiveSegmentId(s.id)}
            />
          ))}
          <span style={{ flex: 1 }} />
          <button
            className="btn ghost sm"
            onClick={() => setShowSegmentManager(true)}
          >
            <IconFilter w={12} />
            {tx("Manage segments", "إدارة الشرائح")}
          </button>
          <input
            placeholder={tx("Search contacts…", "ابحث…")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ ...INPUT_STYLE, width: 220 }}
          />
        </div>

        {statusMsg && (
          <div
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              background: "var(--accent-soft)",
              color: "var(--accent)",
              fontSize: 12,
              border: "1px solid var(--accent-ring)",
            }}
          >
            {statusMsg}
          </div>
        )}

        {error && !loading && (
          <div
            style={{
              padding: "10px 12px",
              borderRadius: 8,
              background: "color-mix(in oklch, var(--bad) 12%, transparent)",
              color: "var(--bad)",
              fontSize: 12,
              display: "flex",
              alignItems: "center",
              gap: 12,
              border: "1px solid color-mix(in oklch, var(--bad) 32%, transparent)",
            }}
          >
            <span>{error}</span>
            <button className="btn sm" onClick={refetch}>
              {tx("Retry", "إعادة")}
            </button>
          </div>
        )}

        {loading && (
          <div
            className="muted"
            style={{
              padding: "10px 12px",
              fontSize: 12,
              opacity: 0.7,
              animation: "pulse 1.2s ease-in-out infinite",
            }}
          >
            {tx("loading…", "جارٍ التحميل…")}
          </div>
        )}

        {!loading && !error && view === "table" && (
          <ContactsTable
            tx={tx}
            contacts={contacts}
            selected={selected}
            setSelected={setSelected}
            onBulkDelete={onBulkDelete}
            onBulkTag={onBulkTag}
            bulkDeleting={bulkDeleting}
            onOpenContact={setOpenContactId}
            manualGroups={manualGroups}
            onAddToGroup={handleAddToGroup}
            addToGroupError={addToGroup.error}
            tagColorByName={tagColorByName}
            lang={t.lang}
          />
        )}
        {!loading && !error && view === "pipeline" && (
          <Pipeline tx={tx} contacts={contacts} />
        )}
      </div>
      )}

      {activeTab === "groups" && <GroupsTab tx={tx} lang={t.lang} contacts={contacts} />}
      {activeTab === "tags" && <TagsTab tx={tx} />}

      {showNew && (
        <NewContactModal
          tx={tx}
          onClose={() => setShowNew(false)}
          onCreated={() => {
            refetch();
            showStatus(tx("Contact created.", "تم إنشاء جهة الاتصال."));
          }}
        />
      )}

      {showBulkTag && (
        <BulkTagModal
          tx={tx}
          count={selected.size}
          saving={bulkTagging}
          tags={tagsQ.data ?? []}
          onClose={() => setShowBulkTag(false)}
          onApply={applyBulkTags}
        />
      )}

      {openContactId && (
        <ContactDetailDrawer
          contactId={openContactId}
          onClose={() => setOpenContactId(null)}
        />
      )}

      {showSegmentManager && (
        <SegmentManager
          lang={t.lang}
          contacts={allContacts}
          segments={segments}
          onClose={() => setShowSegmentManager(false)}
          onChanged={() => {
            refetchSegments();
            // If the active segment was just edited (or deleted), refetch the
            // contacts too so the table matches the new filter / clears if it
            // was removed.
            refetch();
          }}
        />
      )}
    </div>
  );
}

/* ─── Segment chip helper ───────────────────────────────────────────── */

interface SegmentChipProps {
  label: string;
  count: number;
  active: boolean;
  color?: string | null;
  onClick: () => void;
}

function SegmentChip({ label, count, active, color, onClick }: SegmentChipProps) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 11px",
        borderRadius: 999,
        fontSize: 12,
        border: `1px solid ${active ? "var(--accent-ring)" : "var(--line-soft)"}`,
        background: active ? "var(--accent-soft)" : "transparent",
        color: active ? "var(--accent)" : "var(--ink-1)",
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      {color && (
        <span
          style={{
            display: "inline-block",
            width: 6,
            height: 6,
            borderRadius: 999,
            background: `oklch(0.7 0.15 ${color})`,
          }}
        />
      )}
      {label}
      <span
        className="mono muted"
        style={{
          fontSize: 10,
          color: active ? "var(--accent)" : "var(--ink-3)",
        }}
      >
        {count.toLocaleString()}
      </span>
    </button>
  );
}

/* ─── Bulk tag modal ─────────────────────────────────────────────────── */

interface BulkTagModalProps {
  tx: Tx;
  count: number;
  saving: boolean;
  tags: TagRow[];
  onClose: () => void;
  onApply: (selectedNames: string[]) => void;
}

function BulkTagModal({ tx, count, saving, tags, onClose, onApply }: BulkTagModalProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [customNames, setCustomNames] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const canSubmit = selected.size > 0 && !saving;

  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const addDraft = () => {
    const name = draft.trim();
    if (!name) return;
    if (!customNames.includes(name) && !tags.some((t) => t.name === name)) {
      setCustomNames((prev) => [...prev, name]);
    }
    setSelected((prev) => new Set(prev).add(name));
    setDraft("");
  };

  const chipStyle = (hue: string | null, isSelected: boolean): CSSProperties =>
    isSelected
      ? {
          background: hue ? `hsl(${hue} 70% 45%)` : "var(--accent)",
          color: "#fff",
          border: `1px solid ${hue ? `hsl(${hue} 70% 40%)` : "var(--accent)"}`,
        }
      : {
          background: hue ? `hsl(${hue} 70% 45% / 0.12)` : "transparent",
          color: hue ? `hsl(${hue} 70% 35%)` : "var(--ink-2)",
          border: `1px solid ${hue ? `hsl(${hue} 70% 45% / 0.35)` : "var(--line-soft)"}`,
        };

  return (
    <Modal onClose={onClose} width={420} label="Add tags" panelStyle={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>
            {tx("Add tags", "إضافة وسوم")}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
            {tx(
              `Add tags to ${count} contact${count === 1 ? "" : "s"}.`,
              `إضافة وسوم إلى ${count} جهة.`,
            )}
          </div>
        </div>

        <div>
          <label
            className="mono muted"
            style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.06 }}
          >
            {tx("Tags", "الوسوم")}
          </label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            {tags.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => toggle(t.name)}
                style={{
                  ...chipStyle(t.color, selected.has(t.name)),
                  fontSize: 12,
                  padding: "4px 10px",
                  borderRadius: 999,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                {t.name}
              </button>
            ))}
            {customNames.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => toggle(name)}
                style={{
                  ...chipStyle(null, selected.has(name)),
                  fontSize: 12,
                  padding: "4px 10px",
                  borderRadius: 999,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                {name}
                <span style={{ fontSize: 10, opacity: 0.75 }}>
                  {tx("new", "جديد")}
                </span>
              </button>
            ))}
            {tags.length === 0 && customNames.length === 0 && (
              <span className="muted" style={{ fontSize: 12 }}>
                {tx("No tags yet — create one below.", "لا توجد وسوم بعد — أنشئ واحدًا أدناه.")}
              </span>
            )}
          </div>
        </div>

        <div>
          <label
            className="mono muted"
            style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.06 }}
          >
            {tx("Quick-create", "إنشاء سريع")}
          </label>
          <input
            type="text"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addDraft();
              }
              if (e.key === "Escape") onClose();
            }}
            placeholder={tx("Type a name and press Enter…", "اكتب اسمًا واضغط Enter…")}
            style={{
              width: "100%",
              marginTop: 6,
              padding: "9px 11px",
              borderRadius: 8,
              border: "1px solid var(--line)",
              background: "var(--bg)",
              color: "var(--ink-1)",
              fontSize: 13,
              fontFamily: "inherit",
              outline: "none",
            }}
          />
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn" type="button" onClick={onClose} disabled={saving}>
            {tx("Cancel", "إلغاء")}
          </button>
          <button
            className="btn primary"
            type="button"
            onClick={() => onApply(Array.from(selected))}
            disabled={!canSubmit}
          >
            {saving ? tx("Applying…", "جارٍ التطبيق…") : tx("Apply", "تطبيق")}
          </button>
        </div>
    </Modal>
  );
}

const Contacts = memo(ContactsImpl);
export default Contacts;
