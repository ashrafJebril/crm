import type { ReactNode } from "react";
import { useFetch } from "@/api/useFetch";
import { usePermissions } from "@/auth/usePermissions";
import { IconFilter } from "@/icons";
import type { Tx } from "@/lib/tx";
import type { AdSourceOption, ChannelDto, ConversationLabel, TagRow, TeamMember } from "@/lib/types";
import { channelLabels } from "../channels/channelModel";
import { activeFilterCount, EMPTY_FILTER, type InboxFilter } from "./inboxFilters";
import { LABEL_COLOR_VAR } from "./LabelPicker";
import { Popover } from "./Popover";

const toggle = (arr: string[], v: string) =>
  arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset style={{ border: 0, margin: "0 0 8px", padding: 0 }}>
      <legend style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-3)", padding: 0, marginBottom: 2 }}>
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

function Check({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: () => void;
  children: ReactNode;
}) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 2px", fontSize: 13, cursor: "pointer" }}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      {children}
    </label>
  );
}

function Panel({
  filter,
  onChange,
  team,
  labels,
  channels,
  tx,
}: {
  filter: InboxFilter;
  onChange: (f: InboxFilter) => void;
  team: TeamMember[];
  labels: ConversationLabel[];
  channels: ChannelDto[];
  tx: Tx;
}) {
  // Contact tags are only needed once the popover is open.
  const tagsQ = useFetch<TagRow[]>("/tags");
  const tags = tagsQ.data ?? [];
  // SP-15 "Ad source": the ads that started a conversation (conversations.view).
  const canAds = usePermissions().can("conversations.view");
  const adsQ = useFetch<{ items: AdSourceOption[] }>(canAds ? "/ad-sources" : null);
  const ads = adsQ.data?.items ?? [];
  const lifecycles: { id: string; label: string }[] = [
    { id: "lead", label: tx("Lead", "عميل محتمل") },
    { id: "customer", label: tx("Customer", "عميل") },
    { id: "churned", label: tx("Churned", "منقطع") },
  ];
  const set = (patch: Partial<InboxFilter>) => onChange({ ...filter, ...patch });
  const dateStyle = { flex: 1, minWidth: 0, boxSizing: "border-box" as const };
  const numberLabels = channelLabels(channels);
  return (
    <div style={{ minWidth: 250 }}>
      {team.length > 0 && (
        <Group title={tx("Assignee", "المسؤول")}>
          {team.map((m) => (
            <Check
              key={m.id}
              checked={filter.assigneeIds.includes(m.id)}
              onChange={() => set({ assigneeIds: toggle(filter.assigneeIds, m.id) })}
            >
              <span dir="auto">{m.name}</span>
            </Check>
          ))}
        </Group>
      )}
      {channels.length > 0 && (
        <Group title={tx("Number", "الرقم")}>
          {channels.map((c) => (
            <Check
              key={c.id}
              checked={filter.channelIds.includes(c.id)}
              onChange={() => set({ channelIds: toggle(filter.channelIds, c.id) })}
            >
              <span dir="auto">{numberLabels.get(c.id) ?? c.kind}</span>
            </Check>
          ))}
        </Group>
      )}
      {labels.length > 0 && (
        <Group title={tx("Labels", "التصنيفات")}>
          {labels.map((l) => (
            <Check
              key={l.id}
              checked={filter.labelIds.includes(l.id)}
              onChange={() => set({ labelIds: toggle(filter.labelIds, l.id) })}
            >
              <span style={{ width: 10, height: 10, borderRadius: 99, background: LABEL_COLOR_VAR[l.color] }} />
              <span dir="auto">{l.name}</span>
            </Check>
          ))}
        </Group>
      )}
      {tags.length > 0 && (
        <Group title={tx("Contact tags", "وسوم جهة الاتصال")}>
          {tags.map((t) => (
            <Check
              key={t.id}
              checked={filter.tags.includes(t.name)}
              onChange={() => set({ tags: toggle(filter.tags, t.name) })}
            >
              {t.name}
            </Check>
          ))}
        </Group>
      )}
      {canAds && (
        <Group title={tx("Ad source", "مصدر الإعلان")}>
          <Check
            checked={filter.adFilter === "any" && filter.adSourceIds.length === 0}
            onChange={() => set({ adFilter: filter.adFilter === "any" ? null : "any", adSourceIds: [] })}
          >
            {tx("Any ad", "أي إعلان")}
          </Check>
          <Check
            checked={filter.adFilter === "none" && filter.adSourceIds.length === 0}
            onChange={() => set({ adFilter: filter.adFilter === "none" ? null : "none", adSourceIds: [] })}
          >
            {tx("No ad", "بلا إعلان")}
          </Check>
          {ads.length > 0 && (
            <div style={{ maxHeight: 160, overflowY: "auto", borderTop: "1px solid var(--line-soft)", marginTop: 2, paddingTop: 2 }}>
              {ads.map((a) => (
                <Check
                  key={a.id}
                  checked={filter.adSourceIds.includes(a.id)}
                  onChange={() => set({ adSourceIds: toggle(filter.adSourceIds, a.id), adFilter: null })}
                >
                  <bdi dir="auto" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}>
                    {a.label}
                  </bdi>
                </Check>
              ))}
            </div>
          )}
        </Group>
      )}
      <Group title={tx("Lifecycle", "مرحلة العميل")}>
        {lifecycles.map((l) => (
          <Check
            key={l.id}
            checked={filter.lifecycles.includes(l.id)}
            onChange={() => set({ lifecycles: toggle(filter.lifecycles, l.id) })}
          >
            {l.label}
          </Check>
        ))}
      </Group>
      <Group title={tx("Last activity", "آخر نشاط")}>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            type="date"
            aria-label={tx("From date", "من تاريخ")}
            value={filter.from ?? ""}
            max={filter.to || undefined}
            onChange={(e) => set({ from: e.target.value || undefined })}
            style={dateStyle}
          />
          <input
            type="date"
            aria-label={tx("To date", "إلى تاريخ")}
            value={filter.to ?? ""}
            min={filter.from || undefined}
            onChange={(e) => set({ to: e.target.value || undefined })}
            style={dateStyle}
          />
        </div>
      </Group>
      <Check checked={filter.escalatedOnly} onChange={() => set({ escalatedOnly: !filter.escalatedOnly })}>
        {tx("Escalated only", "المُصعَّدة فقط")}
      </Check>
      <div style={{ borderTop: "1px solid var(--line-soft)", marginTop: 8, paddingTop: 8, display: "flex" }}>
        <button
          className="btn sm"
          style={{ marginInlineStart: "auto" }}
          disabled={activeFilterCount(filter) === 0}
          onClick={() => onChange({ ...EMPTY_FILTER, bucket: filter.bucket })}
        >
          {tx("Clear", "مسح")}
        </button>
      </div>
    </div>
  );
}

export function InboxFilterMenu({
  filter,
  onChange,
  team,
  labels,
  channels,
  tx,
}: {
  filter: InboxFilter;
  onChange: (f: InboxFilter) => void;
  team: TeamMember[];
  labels: ConversationLabel[];
  channels: ChannelDto[];
  tx: Tx;
}) {
  return (
    <Popover
      trigger={<IconFilter w={14} />}
      title={tx("Filter", "فلتر")}
      ariaLabel={tx("Filter", "فلتر")}
      role="dialog"
      badge={activeFilterCount(filter)}
      sheetOnPhone
    >
      {() => <Panel filter={filter} onChange={onChange} team={team} labels={labels} channels={channels} tx={tx} />}
    </Popover>
  );
}
