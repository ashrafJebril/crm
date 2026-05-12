import { memo } from "react";
import type { RouteId } from "@/lib/types";
import { useTweaks } from "@/tweaks/context";
import { useAuth } from "@/auth/context";
import { TITLES } from "./nav";
import { IconBell, IconMoon, IconPlus, IconSearch, IconSun, IconHand } from "@/icons";
import { Avatar } from "@/components/Avatar";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

interface TopbarProps {
  route: RouteId;
}

function TopbarImpl({ route }: TopbarProps) {
  const { t, setTweak } = useTweaks();
  const { user, logout } = useAuth();
  const isAr = t.lang === "ar";
  const title = TITLES[route][t.lang];

  return (
    <div className="topbar">
      <div className="crumbs">
        <span>Samemha</span>
        <span className="sep">/</span>
        <span className="now">{title}</span>
      </div>
      <div className="grow" />
      <div className="search">
        <IconSearch w={14} />
        <input
          placeholder={
            isAr ? "ابحث في كل شيء…" : "Search conversations, contacts, campaigns…"
          }
        />
        <span className="kbd">⌘K</span>
      </div>
      <button
        className="btn ghost icon"
        title="Toggle language"
        onClick={() => setTweak("lang", t.lang === "en" ? "ar" : "en")}
      >
        <span className="mono" style={{ fontSize: 11, fontWeight: 600 }}>
          {t.lang === "en" ? "EN" : "ع"}
        </span>
      </button>
      <button
        className="btn ghost icon"
        title="Toggle theme"
        onClick={() => setTweak("theme", t.theme === "dark" ? "light" : "dark")}
      >
        {t.theme === "dark" ? <IconMoon w={16} /> : <IconSun w={16} />}
      </button>
      <button className="btn ghost icon" title="Notifications">
        <IconBell w={16} />
        <span
          style={{
            position: "absolute",
            top: 6,
            insetInlineEnd: 6,
            width: 6,
            height: 6,
            background: "var(--accent)",
            borderRadius: "50%",
          }}
        />
      </button>
      <button className="btn primary">
        <IconPlus w={14} />
        {isAr ? "إنشاء" : "Create"}
      </button>
      <WorkspaceSwitcher />
      {user && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            paddingInlineStart: 8,
            borderInlineStart: "1px solid var(--line-soft)",
            marginInlineStart: 4,
          }}
        >
          <Avatar name={user.name} color={user.color} />
          <div style={{ minWidth: 0, lineHeight: 1.2 }}>
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
