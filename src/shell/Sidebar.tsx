import { memo } from "react";
import type { RouteId } from "@/lib/types";
import { useTweaks } from "@/tweaks/context";
import { NAV, isSection } from "./nav";
import { Avatar } from "@/components/Avatar";
import { IconBell, IconChevDown, IconSearch } from "@/icons";

interface SidebarProps {
  route: RouteId;
  setRoute: (r: RouteId) => void;
}

function SidebarImpl({ route, setRoute }: SidebarProps) {
  const { t } = useTweaks();
  const isAr = t.lang === "ar";

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

      {!t.collapsed && (
        <div className="workspace" title="Switch workspace">
          <div className="ws-mark" />
          <div className="ws-info">
            <div className="ws-name">Samemha</div>
            <div className="ws-tier">Pro · 4 agents</div>
          </div>
          <span className="ws-caret">
            <IconChevDown w={14} />
          </span>
        </div>
      )}

      <nav className="nav">
        {NAV.map((n, i) => {
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
        <Avatar name="Yara Khaled" color="150" />
        <div className="me">
          <div className="me-name">Yara Khaled</div>
          <div className="me-role">Owner · Samemha</div>
        </div>
        <button className="btn ghost icon sm" title="Notifications">
          <IconBell w={14} />
        </button>
      </div>
    </aside>
  );
}

export const Sidebar = memo(SidebarImpl);
