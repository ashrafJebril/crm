import { memo } from "react";
import type { RouteId } from "@/lib/types";
import { useTweaks } from "@/tweaks/context";
import { useAuth } from "@/auth/context";
import { TITLES } from "./nav";
import { IconMoon, IconPlus, IconSearch, IconSun, IconHand } from "@/icons";
import { Avatar } from "@/components/Avatar";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { NotificationsBell } from "./NotificationsBell";
import { openPalette } from "@/components/CommandPalette";
import { openCopilot, useCopilotAvailable } from "@/copilot/copilotApi";
import { MenuButton } from "./MenuButton";
import { useShellMode } from "./shellState";

interface TopbarProps {
  route: RouteId;
}

function TopbarImpl({ route }: TopbarProps) {
  const { t, setTweak, setLang } = useTweaks();
  const { mode } = useShellMode();
  const { user, logout, activeWorkspace } = useAuth();
  // The active workspace, never a hardcoded brand.
  const workspaceName = activeWorkspace?.name?.trim() || (t.lang === "ar" ? "نشاطك التجاري" : "Your business");
  const isAr = t.lang === "ar";
  const title = TITLES[route][t.lang];
  // SP-18: hidden when GET /copilot/status says the copilot is unavailable.
  const copilot = useCopilotAvailable();

  return (
    <div className="topbar">
      {/* SP-30: below md the sidebar is a drawer opened from here. */}
      {mode === "drawer" && <MenuButton />}
      <div className="crumbs">
        <span className="crumb-ws">
          <bdi>{workspaceName}</bdi>
        </span>
        <span className="sep">/</span>
        <span className="now">{title}</span>
      </div>
      <div className="grow" />
      {/* Below lg the search field collapses to this icon (CSS). */}
      <button
        type="button"
        className="btn ghost icon search-btn"
        aria-label={isAr ? "بحث" : "Search"}
        title={isAr ? "بحث" : "Search"}
        onClick={() => openPalette()}
      >
        <IconSearch w={16} />
      </button>
      <div
        className="search"
        onClick={() => openPalette()}
        style={{ cursor: "pointer" }}
      >
        <IconSearch w={14} />
        <input
          readOnly
          placeholder={
            isAr ? "ابحث في كل شيء…" : "Search conversations, contacts, campaigns…"
          }
          onFocus={() => openPalette()}
          onKeyDown={(e) => {
            // Any printable key opens the palette with that char pre-filled.
            if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
              e.preventDefault();
              openPalette(e.key);
            }
          }}
          style={{ cursor: "pointer" }}
        />
        <span className="kbd">⌘K</span>
      </div>
      <button
        className="btn ghost icon"
        title={t.lang === "en" ? "Switch to Arabic" : "Switch to English"}
        onClick={() => setLang(t.lang === "en" ? "ar" : "en")}
      >
        <span className="mono" style={{ fontSize: 11, fontWeight: 600 }}>
          {t.lang === "en" ? "ع" : "EN"}
        </span>
      </button>
      <button
        className="btn ghost icon tb-theme"
        title="Toggle theme"
        onClick={() => setTweak("theme", t.theme === "dark" ? "light" : "dark")}
      >
        {t.theme === "dark" ? <IconMoon w={16} /> : <IconSun w={16} />}
      </button>
      {copilot && (
        <button
          type="button"
          className="btn ghost sm tb-ask"
          title={isAr ? "اسأل كيوي (Ctrl+J)" : "Ask Kewy (Ctrl+J)"}
          aria-label={isAr ? "اسأل كيوي" : "Ask Kewy"}
          onClick={() => openCopilot()}
        >
          ✦ <span className="tb-label">{isAr ? "اسأل كيوي" : "Ask Kewy"}</span>
        </button>
      )}
      <NotificationsBell />
      <button className="btn primary tb-create" aria-label={isAr ? "إنشاء" : "Create"}>
        <IconPlus w={14} />
        <span className="tb-label">{isAr ? "إنشاء" : "Create"}</span>
      </button>
      <WorkspaceSwitcher />
      {user && (
        <div
          className="tb-user"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            paddingInlineStart: 8,
            borderInlineStart: "1px solid var(--line-soft)",
            marginInlineStart: 4,
          }}
        >
          <span className="tb-avatar">
            <Avatar name={user.name} color={user.color} />
          </span>
          <div className="tb-user-meta" style={{ minWidth: 0, lineHeight: 1.2 }}>
            <div style={{ fontSize: 12, fontWeight: 500 }}>{user.name}</div>
            <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
              {user.role}
            </div>
          </div>
          <button
            className="btn ghost icon sm"
            title={isAr ? "تسجيل الخروج" : "Sign out"}
            onClick={logout}
          >
            <IconHand w={14} />
          </button>
        </div>
      )}
    </div>
  );
}

export const Topbar = memo(TopbarImpl);
