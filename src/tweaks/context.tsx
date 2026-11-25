import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { isEmbedded } from "@/embed/embed";
import { storedSkin } from "@/embed/skin";
import type { Lang, Tweaks } from "@/lib/types";
import { firstRunLang, readLangParam, withLang } from "@/lib/langParam";

const DEFAULTS: Tweaks = {
  theme: "dark",
  accent: "green",
  density: "regular",
  lang: "en",
  sidebarCollapsed: null,
  langChosen: false,
  showAIPersonality: true,
};

const STORAGE_KEY = "aram.tweaks.v1";

const currentHash = () => (typeof window === "undefined" ? "" : window.location.hash);

function load(): Tweaks {
  if (typeof localStorage === "undefined") return DEFAULTS;
  let t = DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const stored = JSON.parse(raw) as Partial<Tweaks> & { collapsed?: unknown };
      // SP-30: `collapsed` (forced off on every load before) is retired; the
      // remembered choice is `sidebarCollapsed`. A record from before
      // `langChosen` existed counts as a chosen language.
      const { collapsed: _legacy, ...rest } = stored;
      void _legacy;
      t = {
        ...DEFAULTS,
        ...rest,
        sidebarCollapsed: typeof rest.sidebarCollapsed === "boolean" ? rest.sidebarCollapsed : null,
        langChosen: (stored.lang === "ar" || stored.lang === "en") && stored.langChosen !== false,
      };
    }
  } catch {
    t = DEFAULTS;
  }
  // SP-30 (D5): a link's `?lang=` wins over the stored language, and is stored.
  const param = readLangParam(currentHash());
  if (param) t = { ...t, lang: param, langChosen: true };
  return withHostTheme(t);
}

// Embedded with a host skin: the host's mode wins, in memory only.
function withHostTheme(t: Tweaks): Tweaks {
  if (!isEmbedded()) return t;
  const mode = storedSkin()?.mode;
  return mode ? { ...t, theme: mode } : t;
}

/** Keep `?lang=` in the address bar in step with the language (app routes only). */
function writeLangParam(lang: Lang) {
  if (typeof window === "undefined") return;
  const h = window.location.hash;
  if (!h.startsWith("#/")) return;
  const next = withLang(h, lang);
  // replaceState: no hashchange, no new history entry.
  if (next !== h) window.history.replaceState(window.history.state, "", next);
}

type SetTweak = <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => void;

interface TweaksContextValue {
  t: Tweaks;
  setTweak: SetTweak;
  /** The user's language choice: stored, marked as chosen, and written to `?lang=`. */
  setLang: (lang: Lang) => void;
  /** Ruling 4: with no language chosen on this device, follow the workspace's `lang`. */
  applyWorkspaceLang: (workspaceLang: string | null | undefined) => void;
}

const TweaksContext = createContext<TweaksContextValue | null>(null);

export function TweaksProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<Tweaks>(load);

  // Sync to <html> attributes — drives every CSS variable. No React re-render
  // needed for theme switches beyond the consumers of `t` itself; the visuals
  // update via CSS attribute selectors.
  useEffect(() => {
    const html = document.documentElement;
    html.setAttribute("data-theme", t.theme);
    html.setAttribute("data-accent", t.accent);
    html.setAttribute("data-density", t.density);
    html.setAttribute("dir", t.lang === "ar" ? "rtl" : "ltr");
    html.setAttribute("lang", t.lang);
  }, [t.theme, t.accent, t.density, t.lang]);

  // Persist
  useEffect(() => {
    try {
      let out = t;
      if (isEmbedded() && storedSkin()?.mode) {
        // Don't persist the host-forced theme into the standalone CRM's prefs.
        const raw = localStorage.getItem(STORAGE_KEY);
        const prevTheme = raw ? (JSON.parse(raw) as Partial<Tweaks>).theme : undefined;
        out = { ...t, theme: prevTheme ?? DEFAULTS.theme };
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
    } catch {
      /* ignore quota / privacy errors */
    }
  }, [t]);

  // SP-30: a `?lang=` arriving later (a pasted link, Back/Forward) applies and is stored.
  useEffect(() => {
    const onHash = () => {
      const l = readLangParam(currentHash());
      if (l) setT((prev) => (prev.lang === l && prev.langChosen ? prev : { ...prev, lang: l, langChosen: true }));
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const setTweak = useCallback<SetTweak>((key, value) => {
    setT((prev) => (prev[key] === value ? prev : { ...prev, [key]: value }));
  }, []);

  const setLang = useCallback((lang: Lang) => {
    setT((prev) => (prev.lang === lang && prev.langChosen ? prev : { ...prev, lang, langChosen: true }));
    writeLangParam(lang);
  }, []);

  const applyWorkspaceLang = useCallback((workspaceLang: string | null | undefined) => {
    setT((prev) => {
      const l = firstRunLang({ lang: prev.lang, langChosen: prev.langChosen }, workspaceLang);
      return l && l !== prev.lang ? { ...prev, lang: l } : prev;
    });
  }, []);

  const value = useMemo(() => ({ t, setTweak, setLang, applyWorkspaceLang }), [t, setTweak, setLang, applyWorkspaceLang]);
  return <TweaksContext.Provider value={value}>{children}</TweaksContext.Provider>;
}

export function useTweaks() {
  const ctx = useContext(TweaksContext);
  if (!ctx) throw new Error("useTweaks must be used inside <TweaksProvider>");
  return ctx;
}
