import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { useTweaks } from "@/tweaks/context";
import { useRoute } from "@/router";
import { makeTx } from "@/lib/tx";
import { NAV, isSection, TITLES } from "@/shell/nav";
import type { Accent, Lang, RouteId, Theme } from "@/lib/types";
import { CONTACTS, findContact } from "@/data/contacts";
import { CONVERSATIONS } from "@/data/conversations";
import { AGENTS } from "@/data/agents";
import { CAMPAIGNS } from "@/data/campaigns";
import { TEMPLATES } from "@/data/analytics";
import {
  IconBolt,
  IconBot,
  IconCampaign,
  IconInbox,
  IconLang,
  IconMoon,
  IconSearch,
  IconSparkles,
  IconSun,
  IconTemplate,
  IconUsers,
} from "@/icons";

const STYLES = `
.cmdk-back{position:fixed;inset:0;z-index:2147483646;
  background:oklch(0 0 0 / 0.5);
  -webkit-backdrop-filter:blur(8px) saturate(140%);backdrop-filter:blur(8px) saturate(140%);
  display:grid;place-items:start center;padding-top:14vh;animation:cmdk-fade .12s ease-out}
.cmdk-modal{width:min(640px,calc(100vw - 32px));max-height:480px;display:flex;flex-direction:column;
  background:var(--bg-elev);color:var(--ink);
  border:1px solid var(--line);border-radius:14px;
  box-shadow:var(--shadow-lg);overflow:hidden;
  font-family:"Geist","Inter",system-ui,sans-serif;
  animation:cmdk-pop .14s cubic-bezier(.2,.8,.2,1)}
.cmdk-search{display:flex;align-items:center;gap:10px;
  padding:14px 16px;border-bottom:1px solid var(--line-soft);
  color:var(--ink-3)}
.cmdk-search input{flex:1;appearance:none;border:0;outline:none;background:transparent;
  font:inherit;font-size:14px;color:var(--ink);letter-spacing:.005em}
.cmdk-search input::placeholder{color:var(--ink-3)}
.cmdk-kbd{font-family:var(--font-mono);font-size:10.5px;color:var(--ink-3);
  border:1px solid var(--line);border-radius:5px;padding:2px 6px;
  background:var(--bg-2,oklch(0 0 0 / 0.18))}
.cmdk-list{flex:1;overflow-y:auto;padding:6px 8px 10px;min-height:0}
.cmdk-empty{padding:32px 16px;text-align:center;color:var(--ink-3);font-size:13px}
.cmdk-sect{font-family:var(--font-mono);font-size:10px;font-weight:600;
  letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);
  padding:10px 10px 6px}
.cmdk-row{display:flex;align-items:center;gap:10px;
  padding:8px 10px;border-radius:8px;cursor:pointer;
  color:var(--ink-1);font-size:13px;line-height:1.3;
  border:1px solid transparent}
.cmdk-row:hover{background:oklch(1 0 0 / 0.04)}
.cmdk-row.active{background:var(--accent-soft);border-color:var(--accent-ring);color:var(--ink)}
.cmdk-row .ic{display:grid;place-items:center;width:22px;height:22px;
  color:var(--ink-2);flex:none}
.cmdk-row.active .ic{color:var(--accent)}
.cmdk-row .lbl{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.cmdk-row .lbl b{font-weight:500;color:inherit;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cmdk-row .lbl span{font-size:11px;color:var(--ink-3);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cmdk-row.active .lbl span{color:var(--ink-2)}
.cmdk-row .hint{font-family:var(--font-mono);font-size:10.5px;color:var(--ink-3);flex:none}
.cmdk-foot{display:flex;align-items:center;gap:14px;
  padding:8px 14px;border-top:1px solid var(--line-soft);
  font-size:11px;color:var(--ink-3)}
.cmdk-foot kbd{font-family:var(--font-mono);font-size:10px;
  border:1px solid var(--line);border-radius:4px;padding:1px 5px;
  margin-inline-end:4px;color:var(--ink-2)}
@keyframes cmdk-fade{from{opacity:0}to{opacity:1}}
@keyframes cmdk-pop{from{opacity:0;transform:translateY(-4px) scale(.98)}to{opacity:1;transform:none}}
`;

type IconCmp = ComponentType<{ w?: number }>;

interface CmdItem {
  id: string;
  label: string;
  hint?: string;
  Icon: IconCmp;
  run: () => void;
}

interface CmdSection {
  id: string;
  label: string;
  items: CmdItem[];
}

const NAV_ICONS: Partial<Record<RouteId, IconCmp>> = {};
for (const n of NAV) {
  if (!isSection(n)) NAV_ICONS[n.id] = n.Icon;
}

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function matches(query: string, ...fields: Array<string | undefined>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = fields.filter(Boolean).join(" ").toLowerCase();
  if (haystack.includes(q)) return true;
  const qs = tokens(q);
  if (!qs.length) return true;
  const hs = haystack;
  return qs.every((t) => hs.includes(t));
}

const ACCENT_CYCLE: Accent[] = ["green", "indigo", "amber", "magenta"];

export function CommandPalette() {
  const { t, setTweak } = useTweaks();
  const [, setRoute] = useRoute();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const tx = makeTx(t.lang);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActive(0);
  }, []);

  // Toggle on Cmd/Ctrl+K
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((o) => !o);
        setQuery("");
        setActive(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Build sections (only when open, to avoid wasted work)
  const sections = useMemo<CmdSection[]>(() => {
    if (!open) return [];

    // Navigation
    const navItems: CmdItem[] = NAV.filter((n) => !isSection(n))
      .map((n) => {
        if (isSection(n)) return null;
        const id = n.id;
        const labelEn = TITLES[id]?.en ?? n.label;
        const labelAr = TITLES[id]?.ar ?? n.ar;
        const label = tx(labelEn, labelAr);
        const Icon = NAV_ICONS[id] ?? n.Icon;
        const item: CmdItem = {
          id: `nav-${id}`,
          label,
          hint: tx("Go to", "اذهب إلى"),
          Icon,
          run: () => setRoute(id),
        };
        return item;
      })
      .filter((x): x is CmdItem => x !== null)
      .filter((it) => matches(query, it.label, it.id));

    // Contacts
    const contactItems: CmdItem[] = CONTACTS.filter((c) =>
      matches(query, c.name, c.phone, c.industry, c.lifecycle, ...c.tags),
    ).map((c) => ({
      id: `contact-${c.id}`,
      label: c.name,
      hint: c.phone,
      Icon: IconUsers,
      run: () => setRoute("contacts"),
    }));

    // Conversations (top 10 by recency = first 10 in source order, which is recency-ordered)
    const convItems: CmdItem[] = CONVERSATIONS.slice(0, 10)
      .map((c) => {
        const contact = findContact(c.contactId);
        const contactName = contact?.name ?? c.contactId;
        const label = `${c.intent} · ${contactName}`;
        return {
          id: `conv-${c.id}`,
          label,
          hint: c.preview,
          Icon: IconInbox,
          contactName,
          intent: c.intent,
          preview: c.preview,
        };
      })
      .filter((it) => matches(query, it.label, it.contactName, it.intent, it.preview))
      .map<CmdItem>((it) => ({
        id: it.id,
        label: it.label,
        hint: it.hint,
        Icon: it.Icon,
        run: () => setRoute("inbox"),
      }));

    // Agents
    const agentItems: CmdItem[] = AGENTS.filter((a) =>
      matches(query, a.name, a.role, a.id),
    ).map((a) => ({
      id: `agent-${a.id}`,
      label: a.name,
      hint: a.role,
      Icon: IconBot,
      run: () => setRoute("agents"),
    }));

    // Campaigns
    const campaignItems: CmdItem[] = CAMPAIGNS.filter((c) =>
      matches(query, c.name, c.audience, c.status, c.channel),
    ).map((c) => ({
      id: `camp-${c.id}`,
      label: c.name,
      hint: `${c.status} · ${c.audience}`,
      Icon: IconCampaign,
      run: () => setRoute("campaigns"),
    }));

    // Templates
    const templateItems: CmdItem[] = TEMPLATES.filter((tpl) =>
      matches(query, tpl.name, tpl.category, tpl.status),
    ).map((tpl) => ({
      id: `tpl-${tpl.id}`,
      label: tpl.name,
      hint: `${tpl.category.toLowerCase()} · ${tpl.lang.toUpperCase()}`,
      Icon: IconTemplate,
      run: () => setRoute("templates"),
    }));

    // Quick actions
    const nextTheme: Theme = t.theme === "dark" ? "light" : "dark";
    const nextLang: Lang = t.lang === "en" ? "ar" : "en";
    const idx = ACCENT_CYCLE.indexOf(t.accent);
    const nextAccent: Accent = ACCENT_CYCLE[(idx + 1) % ACCENT_CYCLE.length] ?? "green";

    const quickActions: CmdItem[] = [
      {
        id: "qa-theme",
        label: tx(
          `Toggle theme (switch to ${nextTheme})`,
          `تبديل المظهر (التبديل إلى ${nextTheme === "dark" ? "الداكن" : "الفاتح"})`,
        ),
        hint: tx("Appearance", "المظهر"),
        Icon: nextTheme === "dark" ? IconMoon : IconSun,
        run: () => setTweak("theme", nextTheme),
      },
      {
        id: "qa-lang",
        label:
          t.lang === "en"
            ? tx("Switch to Arabic", "التبديل إلى العربية")
            : tx("Switch to English", "التبديل إلى الإنجليزية"),
        hint: tx("Language", "اللغة"),
        Icon: IconLang,
        run: () => setTweak("lang", nextLang),
      },
      {
        id: "qa-sidebar",
        label: tx(
          t.collapsed ? "Expand sidebar" : "Collapse sidebar",
          t.collapsed ? "توسيع الشريط الجانبي" : "طي الشريط الجانبي",
        ),
        hint: tx("Layout", "التخطيط"),
        Icon: IconBolt,
        run: () => setTweak("collapsed", !t.collapsed),
      },
      {
        id: "qa-accent",
        label: tx(
          `Cycle accent color (next: ${nextAccent})`,
          `تدوير لون التمييز (التالي: ${nextAccent})`,
        ),
        hint: tx("Appearance", "المظهر"),
        Icon: IconSparkles,
        run: () => setTweak("accent", nextAccent),
      },
    ].filter((qa) => matches(query, qa.label, qa.hint));

    const all: CmdSection[] = [
      { id: "nav", label: tx("Navigation", "التنقل"), items: navItems },
      { id: "contacts", label: tx("Contacts", "جهات الاتصال"), items: contactItems },
      { id: "conv", label: tx("Conversations", "المحادثات"), items: convItems },
      { id: "agents", label: tx("Agents", "الوكلاء"), items: agentItems },
      { id: "camp", label: tx("Campaigns", "الحملات"), items: campaignItems },
      { id: "tpl", label: tx("Templates", "القوالب"), items: templateItems },
      { id: "qa", label: tx("Quick actions", "إجراءات سريعة"), items: quickActions },
    ];

    return all.filter((s) => s.items.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, t.lang, t.theme, t.accent, t.collapsed]);

  // Flat list of items for keyboard nav
  const flat = useMemo<CmdItem[]>(
    () => sections.flatMap((s) => s.items),
    [sections],
  );

  // Clamp active index when results change
  useEffect(() => {
    if (active >= flat.length) setActive(0);
  }, [flat.length, active]);

  // Focus input on open
  useEffect(() => {
    if (open) {
      // next frame so the input is mounted
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
    return;
  }, [open]);

  // Scroll active row into view
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLElement>(`[data-cmdk-idx="${active}"]`);
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  // Modal keyboard handling
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => (flat.length ? (i + 1) % flat.length : 0));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const item = flat[active];
        if (item) {
          item.run();
          close();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, flat, active, close]);

  if (!open) return null;

  // Build a map from item-id -> flat index so we can mark active row.
  const indexById = new Map<string, number>();
  flat.forEach((it, i) => indexById.set(it.id, i));

  const body: ReactNode =
    flat.length === 0 ? (
      <div className="cmdk-empty">{tx("No results", "لا توجد نتائج")}</div>
    ) : (
      sections.map((s) => {
        return (
          <div key={s.id} className="cmdk-group">
            <div className="cmdk-sect">{s.label}</div>
            {s.items.map((it) => {
              const i = indexById.get(it.id) ?? -1;
              const isActive = i === active;
              const Icon = it.Icon;
              return (
                <div
                  key={it.id}
                  data-cmdk-idx={i}
                  className={`cmdk-row${isActive ? " active" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    it.run();
                    close();
                  }}
                  role="option"
                  aria-selected={isActive}
                >
                  <span className="ic">
                    <Icon w={16} />
                  </span>
                  <span className="lbl">
                    <b>{it.label}</b>
                    {it.hint && <span>{it.hint}</span>}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })
    );

  return (
    <>
      <style>{STYLES}</style>
      <div
        className="cmdk-back"
        role="dialog"
        aria-modal="true"
        aria-label={tx("Command palette", "لوحة الأوامر")}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) close();
        }}
      >
        <div className="cmdk-modal">
          <div className="cmdk-search">
            <IconSearch w={16} />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              placeholder={tx(
                "Search or jump to…",
                "ابحث أو انتقل…",
              )}
              spellCheck={false}
              autoComplete="off"
              aria-label={tx("Search", "بحث")}
            />
            <span className="cmdk-kbd">esc</span>
          </div>
          <div className="cmdk-list" ref={listRef} role="listbox">
            {body}
          </div>
          <div className="cmdk-foot">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd>
              {tx("navigate", "تنقّل")}
            </span>
            <span>
              <kbd>↵</kbd>
              {tx("open", "فتح")}
            </span>
            <span>
              <kbd>esc</kbd>
              {tx("close", "إغلاق")}
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
