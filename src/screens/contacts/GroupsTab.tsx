import { useMemo, useState } from "react";
import type { Contact, Lang, Segment } from "@/lib/types";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import { Modal } from "@/components/Modal";
import { IconPlus, IconX } from "@/icons";

interface MemberRow {
  id: string;
  name: string;
  phone: string | null;
  source: string;
}

interface GroupsTabProps {
  tx: (en: string, ar: string) => string;
  lang: Lang;
  contacts: Contact[];
}

const hueBg = (hue: string | null | undefined, a: number) =>
  hue ? `hsl(${hue} 70% 45% / ${a})` : "var(--bg-2)";

/** Card grid of groups (manual) and smart segments (rule-based, read-only
 *  membership) + a member-management drawer for manual groups. */
export function GroupsTab({ tx, lang, contacts }: GroupsTabProps) {
  const segmentsQ = useFetch<Segment[]>("/segments");
  const [openGroup, setOpenGroup] = useState<Segment | null>(null);
  const [creating, setCreating] = useState(false);

  const rows = segmentsQ.data ?? [];
  const groups = rows.filter((s) => s.origin === "manual");
  const smart = rows.filter((s) => s.origin !== "manual");

  return (
    <div style={{ padding: "0 24px 24px", display: "grid", gap: 18 }}>
      <section>
        <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", margin: "6px 0 10px" }}>
          {tx("Your groups", "مجموعاتك")} · {groups.length}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
          <button
            type="button"
            onClick={() => setCreating(true)}
            style={{
              border: "2px dashed var(--line)", borderRadius: 14, minHeight: 110,
              background: "transparent", cursor: "pointer", display: "grid",
              placeItems: "center", color: "var(--ink-3)", fontSize: 13,
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <IconPlus w={14} /> {tx("New group", "مجموعة جديدة")}
            </span>
          </button>
          {groups.map((g) => (
            <GroupCard key={g.id} seg={g} lang={lang} tx={tx} badge={tx("manual", "يدوية")} onClick={() => setOpenGroup(g)} />
          ))}
        </div>
      </section>

      {smart.length > 0 && (
        <section>
          <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", margin: "6px 0 10px" }}>
            {tx("Smart segments", "الشرائح الذكية")} · {smart.length}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
            {smart.map((g) => (
              <GroupCard key={g.id} seg={g} lang={lang} tx={tx} badge={tx("smart", "ذكية")} />
            ))}
          </div>
        </section>
      )}

      {segmentsQ.error && (
        <div style={{ fontSize: 12, color: "var(--bad)" }}>{tx("Couldn't load groups.", "تعذر تحميل المجموعات.")}</div>
      )}

      {creating && (
        <CreateGroupModal
          tx={tx}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            segmentsQ.refetch();
          }}
        />
      )}

      {openGroup && (
        <GroupMembersModal
          tx={tx}
          lang={lang}
          group={openGroup}
          contacts={contacts}
          onClose={() => setOpenGroup(null)}
          onChanged={() => segmentsQ.refetch()}
        />
      )}
    </div>
  );
}

function GroupCard({
  seg,
  lang,
  tx,
  badge,
  onClick,
}: {
  seg: Segment;
  lang: Lang;
  tx: (en: string, ar: string) => string;
  badge: string;
  onClick?: () => void;
}) {
  const name = lang === "ar" && seg.nameAr ? seg.nameAr : seg.name;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      style={{
        textAlign: "start", border: "1px solid var(--line-soft)", borderRadius: 14,
        background: "var(--bg-1)", padding: 16, cursor: onClick ? "pointer" : "default",
        display: "flex", flexDirection: "column", gap: 8, minHeight: 110,
        borderInlineStartWidth: 4,
        borderInlineStartColor: seg.color ? `hsl(${seg.color} 70% 45%)` : "var(--line)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 14, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {name}
        </span>
        <span className="mono" style={{ fontSize: 10, textTransform: "uppercase", padding: "2px 8px", borderRadius: 999, background: hueBg(seg.color, 0.15), color: "var(--ink-2)" }}>
          {badge}
        </span>
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
        {seg.count.toLocaleString()}
      </div>
      <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase" }}>
        {tx("contacts", "جهة اتصال")}
      </div>
    </button>
  );
}

function CreateGroupModal({
  tx,
  onClose,
  onCreated,
}: {
  tx: (en: string, ar: string) => string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [nameAr, setNameAr] = useState("");
  const [color, setColor] = useState("150");
  const createMut = useMutation<{ name: string; nameAr?: string; color: string; origin: "manual" }, Segment>(
    (input) => api.post("/segments", input),
  );
  const HUES = ["0", "30", "60", "90", "120", "150", "180", "210", "240", "270", "300", "330"];
  return (
    <Modal onClose={createMut.loading ? () => {} : onClose} width={420} label="New group" panelStyle={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>{tx("New group", "مجموعة جديدة")}</h3>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={tx("Group name", "اسم المجموعة")}
        style={{ height: 34, padding: "0 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg-1)", color: "var(--ink)", fontSize: 13 }}
      />
      <input
        value={nameAr}
        onChange={(e) => setNameAr(e.target.value)}
        placeholder={tx("Arabic name (optional)", "الاسم بالعربية (اختياري)")}
        dir="rtl"
        style={{ height: 34, padding: "0 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg-1)", color: "var(--ink)", fontSize: 13 }}
      />
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {HUES.map((h) => (
          <button
            key={h}
            type="button"
            onClick={() => setColor(h)}
            aria-label={`hue ${h}`}
            style={{
              width: 22, height: 22, borderRadius: "50%", cursor: "pointer",
              background: `hsl(${h} 70% 45%)`,
              border: color === h ? "2px solid var(--ink)" : "2px solid transparent",
            }}
          />
        ))}
      </div>
      {createMut.error && <div style={{ fontSize: 12, color: "var(--bad)" }}>{createMut.error}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" className="btn ghost" onClick={onClose} disabled={createMut.loading}>
          {tx("Cancel", "إلغاء")}
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={!name.trim() || createMut.loading}
          onClick={() => {
            void createMut
              .mutate({ name: name.trim(), nameAr: nameAr.trim() || undefined, color, origin: "manual" })
              .then(onCreated)
              .catch(() => {});
          }}
        >
          {createMut.loading ? tx("Creating…", "جارٍ الإنشاء…") : tx("Create group", "إنشاء المجموعة")}
        </button>
      </div>
    </Modal>
  );
}

function GroupMembersModal({
  tx,
  lang,
  group,
  contacts,
  onClose,
  onChanged,
}: {
  tx: (en: string, ar: string) => string;
  lang: Lang;
  group: Segment;
  contacts: Contact[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const membersQ = useFetch<MemberRow[]>(`/segments/${group.id}/members`);
  const [search, setSearch] = useState("");
  const addMut = useMutation<{ contactIds: string[] }, { added: number }>((input) =>
    api.post(`/segments/${group.id}/members`, input),
  );
  const removeMut = useMutation<{ contactId: string }, { ok: true }>(({ contactId }) =>
    api.delete(`/segments/${group.id}/members/${contactId}`),
  );

  const memberIds = useMemo(() => new Set((membersQ.data ?? []).map((m) => m.id)), [membersQ.data]);
  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return contacts.filter((c) => !memberIds.has(c.id) && c.name.toLowerCase().includes(q)).slice(0, 8);
  }, [search, contacts, memberIds]);

  const name = lang === "ar" && group.nameAr ? group.nameAr : group.name;
  const busy = addMut.loading || removeMut.loading;

  return (
    <Modal onClose={busy ? () => {} : onClose} width={520} label="Group members" panelStyle={{ display: "flex", flexDirection: "column", gap: 12, maxHeight: "80vh" }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>
        {name} <span className="mono muted" style={{ fontSize: 11 }}>· {(membersQ.data ?? []).length} {tx("members", "عضو")}</span>
      </h3>
      <div style={{ position: "relative" }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={tx("Search contacts to add…", "ابحث عن جهات لإضافتها…")}
          style={{ width: "100%", height: 34, padding: "0 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg-1)", color: "var(--ink)", fontSize: 13 }}
        />
        {candidates.length > 0 && (
          <div style={{ position: "absolute", top: 38, insetInlineStart: 0, insetInlineEnd: 0, zIndex: 5, background: "var(--bg-elev)", border: "1px solid var(--line-soft)", borderRadius: 10, boxShadow: "var(--shadow-lg)", overflow: "hidden" }}>
            {candidates.map((c) => (
              <button
                key={c.id}
                type="button"
                disabled={busy}
                onClick={() => {
                  void addMut.mutate({ contactIds: [c.id] }).then(() => {
                    setSearch("");
                    membersQ.refetch();
                    onChanged();
                  }).catch(() => {});
                }}
                style={{ display: "flex", width: "100%", gap: 8, padding: "8px 12px", background: "transparent", border: 0, cursor: "pointer", textAlign: "start", fontSize: 13 }}
              >
                <span style={{ flex: 1 }}>{c.name}</span>
                <span className="mono muted" style={{ fontSize: 11 }}>{c.phone ?? c.source}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {(addMut.error || removeMut.error) && (
        <div style={{ fontSize: 12, color: "var(--bad)" }}>{addMut.error ?? removeMut.error}</div>
      )}
      <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
        {membersQ.loading && <div className="mono muted" style={{ fontSize: 12 }}>{tx("loading…", "جارٍ التحميل…")}</div>}
        {!membersQ.loading && (membersQ.data ?? []).length === 0 && (
          <div className="mono muted" style={{ fontSize: 12, padding: 8 }}>
            {tx("No members yet — search above or bulk-add from the Contacts tab.", "لا أعضاء بعد — ابحث أعلاه أو أضف جماعيًا من تبويب جهات الاتصال.")}
          </div>
        )}
        {(membersQ.data ?? []).map((m) => (
          <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", background: "var(--bg-1)", border: "1px solid var(--line-soft)", borderRadius: 8 }}>
            <span style={{ flex: 1, fontSize: 13 }}>{m.name}</span>
            <span className="mono muted" style={{ fontSize: 11 }}>{m.phone ?? m.source}</span>
            <button
              type="button"
              className="btn ghost icon sm"
              aria-label={tx("Remove from group", "إزالة من المجموعة")}
              disabled={busy}
              onClick={() => {
                void removeMut.mutate({ contactId: m.id }).then(() => {
                  membersQ.refetch();
                  onChanged();
                }).catch(() => {});
              }}
            >
              <IconX w={12} />
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
