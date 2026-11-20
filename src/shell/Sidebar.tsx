import { memo, useMemo } from "react";
import { WorkspaceMark } from "./WorkspaceMark";
import type { RouteId } from "@/lib/types";
import { useTweaks } from "@/tweaks/context";
import { useAuth } from "@/auth/context";
import { usePermissions } from "@/auth/usePermissions";
import { useFetch } from "@/api/useFetch";
import { NAV, isSection, type NavEntry } from "./nav";
import { Avatar } from "@/components/Avatar";
import { BrandLogo } from "@/components/BrandLogo";
import { HjzLink } from "./HjzLink";
import { IconBell, IconChev, IconChevDown, IconSearch } from "@/icons";
import { makeTx } from "@/lib/tx";
import type { ShellMode } from "@/styles/breakpoints";

interface SidebarProps {
  route: RouteId;
  setRoute: (r: RouteId) => void;
  /** SP-30: drawer (below md), rail or full. */
  mode: ShellMode;
  /** Rail ⇄ full (not shown in the drawer). */
  onToggle?: () => void;
  /** Called after a nav item is chosen (the drawer closes). */
  onNavigate?: () => void;
}

function SidebarImpl({ route, setRoute, mode, onToggle, onNavigate }: SidebarProps) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const collapsed = mode === "rail";
  const { user, activeWorkspace } = useAuth();
  const isAr = t.lang === "ar";
  const { can } = usePermissions();
  // Follow-ups needs a record permission to be of any use.
  const canFollowUps = can("contacts.view") || can("tickets.view");
  // SP-19: the channels hub needs channels.view (owner/admin/agent/viewer by default).
  const canChannels = can("channels.view");
  // SP-15: the Ads screen needs reports.view.
  const canAds = can("reports.view");

  // Live unread-count for the Inbox nav item. All channels are DB-backed now
  // (the Zernio webhook persists FB/IG/WA inbound), so one cheap DB query
  // covers the badge — the old per-15s live Zernio poll returned items with
  // no `unread` field and always contributed zero anyway.
  const inboxQ = useFetch<Array<{ unread?: number }>>("/conversations", {
    pollMs: 30000,
  });
  const inboxUnread = useMemo(
    () => (inboxQ.data ?? []).reduce((s, c) => s + (c.unread ?? 0), 0),
    [inboxQ.data],
  );

  // Filter out super-admin-only entries for normal users, then drop any
  // section header that ends up with no items beneath it.
  const visibleNav = useMemo<NavEntry[]>(() => {
    const filtered = NAV.filter(
      (n) =>
        isSection(n) ||
        ((!n.superAdminOnly || user?.isSuperAdmin) &&
          (n.id !== "followups" || canFollowUps) &&
          (n.id !== "channels" || canChannels) &&
          (n.id !== "ads" || canAds)),
    );
    const out: NavEntry[] = [];
    for (let i = 0; i < filtered.length; i++) {
      const cur = filtered[i];
      if (isSection(cur)) {
        const next = filtered[i + 1];
        if (!next || isSection(next)) continue; // drop empty section header
      }
      out.push(cur);
    }
    return out;
  }, [user?.isSuperAdmin, canFollowUps, canChannels, canAds]);

  return (
    <aside className="side">
      <div className="side-brand">
        {/* The lockup carries the wordmark, so no separate name/subtitle. */}
        <BrandLogo markOnly={collapsed} />
        {!collapsed && (
          <button
            className="btn ghost icon sm"
            title="Search"
            style={{ color: "var(--ink-3)", marginInlineStart: "auto" }}
          >
            <IconSearch w={14} />
          </button>
        )}
      </div>

      {!collapsed && activeWorkspace && (
        <div className="workspace" title="Switch workspace">
          <WorkspaceMark name={activeWorkspace.name} logoUrl={activeWorkspace.logoUrl} brandColor={activeWorkspace.brandColor} size={28} />
          <div className="ws-info">
            <div className="ws-name">{activeWorkspace.name}</div>
            <div className="ws-tier">
              {activeWorkspace.plan} · {activeWorkspace.role}
            </div>
          </div>
          <span className="ws-caret">
            <IconChevDown w={14} />
          </span>
        </div>
      )}

      <nav className="nav">
        {visibleNav.map((n, i) => {
          if (isSection(n)) {
            return (
              <div key={`s${i}`} className="nav-section">
                {n.section}
              </div>
            );
          }
          const active = route === n.id;
          const label = isAr ? n.ar : n.label;
          return (
            <button
              key={n.id}
              type="button"
              className={`nav-item ${active ? "active" : ""}`.trim()}
              onClick={() => {
                setRoute(n.id);
                onNavigate?.();
              }}
              title={label}
            >
              <span className="nav-icon">
                <n.Icon w={17} />
              </span>
              <span className="nav-label">{label}</span>
              {(() => {
                const liveBadge =
                  n.id === "inbox" && inboxUnread > 0 ? inboxUnread : undefined;
                const badge = liveBadge ?? n.badge;
                return badge ? <span className="badge-count">{badge}</span> : null;
              })()}
            </button>
          );
        })}
      </nav>

      {mode !== "drawer" && onToggle ? (
        <div className="side-toggle">
          <button
            type="button"
            className="nav-item"
            onClick={onToggle}
            aria-label={collapsed ? tx("Expand sidebar", "توسيع الشريط الجانبي") : tx("Collapse sidebar", "طي الشريط الجانبي")}
            title={`${collapsed ? tx("Expand sidebar", "توسيع الشريط الجانبي") : tx("Collapse sidebar", "طي الشريط الجانبي")} (Ctrl+B)`}
          >
            <span className="nav-icon side-toggle-icon" data-collapsed={collapsed}>
              <IconChev w={16} />
            </span>
            <span className="nav-label">{tx("Collapse sidebar", "طي الشريط الجانبي")}</span>
          </button>
        </div>
      ) : null}

      <HjzLink />

      <div className="side-foot">
        <Avatar name={user?.name ?? "?"} color={user?.color ?? "150"} />
        <div className="me">
          <div className="me-name">{user?.name ?? "—"}</div>
          <div className="me-role">
            {(activeWorkspace?.role ?? user?.role ?? "—")}
            {activeWorkspace?.name ? ` · ${activeWorkspace.name}` : ""}
          </div>
        </div>
        <button className="btn ghost icon sm" title="Notifications">
          <IconBell w={14} />
        </button>
      </div>
    </aside>
  );
}

export const Sidebar = memo(SidebarImpl);
