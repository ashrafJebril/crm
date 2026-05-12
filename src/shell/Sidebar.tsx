import { memo, useMemo } from "react";
import type { RouteId } from "@/lib/types";
import { useTweaks } from "@/tweaks/context";
import { useAuth } from "@/auth/context";
import { NAV, isSection, type NavEntry } from "./nav";
import { Avatar } from "@/components/Avatar";
import { IconBell, IconChevDown, IconSearch } from "@/icons";

interface SidebarProps {
  route: RouteId;
  setRoute: (r: RouteId) => void;
}

function SidebarImpl({ route, setRoute }: SidebarProps) {
  const { t } = useTweaks();
  const { user, activeWorkspace } = useAuth();
  const isAr = t.lang === "ar";

  // Filter out super-admin-only entries for normal users, then drop any
  // section header that ends up with no items beneath it.
  const visibleNav = useMemo<NavEntry[]>(() => {
    const filtered = NAV.filter(
      (n) => isSection(n) || !n.superAdminOnly || user?.isSuperAdmin,
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
  }, [user?.isSuperAdmin]);

  return (
    <aside className="side">
      <div className="side-brand">
        <span className="brand-mark">t</span>
        {!t.collapsed && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="brand-name">
              tkana<span style={{ color: "var(--accent)" }}>.</span>
            </div>
            <div className="brand-sub">v2.4 · MENA</div>
          </div>
        )}
        {!t.collapsed && (
          <button className="btn ghost icon sm" title="Search" style={{ color: "var(--ink-3)" }}>
            <IconSearch w={14} />
          </button>
        )}
      </div>

      {!t.collapsed && activeWorkspace && (
        <div className="workspace" title="Switch workspace">
          <div className="ws-mark" />
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
              onClick={() => setRoute(n.id)}
              title={label}
            >
              <span className="nav-icon">
                <n.Icon w={17} />
              </span>
              <span className="nav-label">{label}</span>
              {n.badge && <span className="badge-count">{n.badge}</span>}
              {n.ai && !n.badge && <span className="ai-pip" />}
            </button>
          );
        })}
      </nav>

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
