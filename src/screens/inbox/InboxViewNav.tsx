import { useState, type ReactNode } from "react";
import type { Conversation, Lang } from "@/lib/types";
import type { Tx } from "@/lib/tx";
import type { InboxView } from "./inboxFilters";
import type { ViewId } from "./inboxViews";
import { AddToGroupList, groupableContactIds } from "./AddFilteredToGroup";
import { Popover } from "./Popover";

/** One entry of the views column / the view picker. */
export interface ViewEntry {
  id: ViewId;
  label: string;
  /** Omitted for views whose total is not useful (Done, All conversations). */
  count?: number;
  /** Red count (Needs reply above 0). */
  hot?: boolean;
  icon?: ReactNode;
}
export interface ViewGroup {
  /** Omitted for the first (primary) group. */
  title?: string;
  entries: ViewEntry[];
}

const ICON = { width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, "aria-hidden": true } as const;
export const ViewIcons = {
  mine: (
    <svg {...ICON}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" />
    </svg>
  ),
  needsReply: (
    <svg {...ICON}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  ),
  unassigned: (
    <svg {...ICON}>
      <circle cx="12" cy="12" r="9" strokeDasharray="3 3" />
    </svg>
  ),
  open: (
    <svg {...ICON}>
      <path d="M4 13l3-8h10l3 8v6H4z" />
    </svg>
  ),
  done: (
    <svg {...ICON}>
      <path d="M5 12l5 5L20 7" />
    </svg>
  ),
};

export const dotIcon = (color: string) => <span className="ix-vdot" style={{ background: color }} aria-hidden="true" />;
export const avatarIcon = (initials: string, ai = false) => (
  <span className={`ix-vav${ai ? " ai" : ""}`} aria-hidden="true">
    {initials}
  </span>
);

/** A view entry: a link-like button in the column (aria-current), a radio menu item in the picker. */
function Entry({ e, active, onSelect, menu = false }: { e: ViewEntry; active: boolean; onSelect: (v: ViewId) => void; menu?: boolean }) {
  return (
    <button
      type="button"
      className={`ix-vi${active ? " on" : ""}`}
      role={menu ? "menuitemradio" : undefined}
      aria-checked={menu ? active : undefined}
      aria-current={!menu && active ? "true" : undefined}
      onClick={() => onSelect(e.id)}
    >
      {e.icon}
      <span className="ix-vi-label" dir="auto">
        {e.label}
      </span>
      {e.count !== undefined ? <span className={`ix-vi-count${e.hot ? " hot" : ""}`}>{e.count}</span> : null}
    </button>
  );
}

/** The views column (xl and up), between the app sidebar and the conversation list. */
export function InboxViewsColumn({ groups, active, onSelect, tx }: { groups: ViewGroup[]; active: ViewId; onSelect: (v: ViewId) => void; tx: Tx }) {
  return (
    <nav className="ix-col-views" aria-label={tx("Inbox views", "عروض صندوق الوارد")}>
      <div className="ix-views-title">{tx("Inbox", "الرسائل")}</div>
      {groups.map((g, i) => (
        <div key={g.title ?? i} role="group" aria-label={g.title}>
          {g.title ? <div className="ix-views-h">{g.title}</div> : null}
          {g.entries.map((e) => (
            <Entry key={e.id} e={e} active={e.id === active} onSelect={onSelect} />
          ))}
        </div>
      ))}
    </nav>
  );
}

/** Below xl the column is a dropdown in the list header showing the view name and count. */
export function InboxViewPicker({
  groups,
  active,
  onSelect,
  tx,
}: {
  groups: ViewGroup[];
  active: ViewEntry;
  onSelect: (v: ViewId) => void;
  tx: Tx;
}) {
  return (
    <Popover
      trigger={
        <span className="ix-vpick-trigger">
          <span className="ix-vpick-label" dir="auto">
            {active.label}
          </span>
          {active.count !== undefined ? <span className={`ix-vi-count${active.hot ? " hot" : ""}`}>{active.count}</span> : null}
          <span aria-hidden="true">▾</span>
        </span>
      }
      triggerClassName="btn ghost ix-vpick"
      ariaLabel={tx(`View: ${active.label}`, `العرض: ${active.label}`)}
      role="menu"
      sheetOnPhone
      panelStyle={{ insetInlineEnd: "auto", insetInlineStart: 0, minWidth: 240, maxHeight: 440, padding: 6 }}
    >
      {(close) =>
        groups.map((g, i) => (
          <div key={g.title ?? i} role="group" aria-label={g.title}>
            {g.title ? <div className="ix-views-h">{g.title}</div> : null}
            {g.entries.map((e) => (
              <Entry
                key={e.id}
                e={e}
                menu
                active={e.id === active.id}
                onSelect={(v) => {
                  onSelect(v);
                  close();
                }}
              />
            ))}
          </div>
        ))
      }
    </Popover>
  );
}

/** ⋯ in the list header: List / Table / Board and "Add to group". */
export function InboxMoreMenu({
  view,
  setView,
  convs,
  tx,
  lang,
}: {
  view: InboxView;
  setView: (v: InboxView) => void;
  convs: Conversation[];
  tx: Tx;
  lang: Lang;
}) {
  const [step, setStep] = useState<"menu" | "groups">("menu");
  const canGroup = groupableContactIds(convs).length > 0;
  const item = { display: "flex", width: "100%", justifyContent: "flex-start", textAlign: "start" } as const;
  return (
    <span
      onClickCapture={(e) => {
        // Opening (the trigger) always starts on the menu.
        if ((e.target as Element).closest("[aria-haspopup]")) setStep("menu");
      }}
    >
      <Popover
        trigger={<span aria-hidden="true">⋯</span>}
        triggerClassName="btn ghost icon sm"
        title={tx("More", "المزيد")}
        ariaLabel={tx("More", "المزيد")}
        sheetOnPhone
        panelStyle={{ minWidth: 220, maxHeight: 360, padding: 4 }}
      >
        {(close) =>
          step === "groups" ? (
            <>
              <button type="button" className="btn ghost sm" style={item} onClick={() => setStep("menu")}>
                ← {tx("Back", "رجوع")}
              </button>
              <AddToGroupList convs={convs} tx={tx} lang={lang} onDone={close} />
            </>
          ) : (
            <>
              <div className="ix-views-h ix-view-btn">{tx("Show as", "العرض كـ")}</div>
              {(["list", "table", "board"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="menuitemradio"
                  aria-checked={view === v}
                  className="btn ghost ix-view-btn"
                  style={{ ...item, fontWeight: view === v ? 700 : 400 }}
                  onClick={() => {
                    setView(v);
                    close();
                  }}
                >
                  {v === "list" ? tx("List", "قائمة") : v === "table" ? tx("Table", "جدول") : tx("Board", "لوحة")}
                </button>
              ))}
              <button
                type="button"
                className="btn ghost"
                style={item}
                disabled={!canGroup}
                title={canGroup ? undefined : tx("No stored contacts in this view", "لا توجد جهات اتصال محفوظة في هذا العرض")}
                onClick={(e) => {
                  e.stopPropagation();
                  setStep("groups");
                }}
              >
                {tx("Add to group…", "إضافة إلى مجموعة…")}
              </button>
            </>
          )
        }
      </Popover>
    </span>
  );
}
