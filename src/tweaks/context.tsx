import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Tweaks } from "@/lib/types";

const DEFAULTS: Tweaks = {
  theme: "dark",
  accent: "green",
  density: "regular",
  lang: "en",
  collapsed: false,
  showAIPersonality: true,
};

const STORAGE_KEY = "aram.tweaks.v1";

function load(): Tweaks {
  if (typeof localStorage === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    // Always start with the sidebar expanded — the user opted out of the
    // collapsed layout and the Tweaks UI that toggled it is hidden.
    return { ...DEFAULTS, ...JSON.parse(raw), collapsed: false };
  } catch {
    return DEFAULTS;
  }
}

type SetTweak = <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => void;

interface TweaksContextValue {
  t: Tweaks;
  setTweak: SetTweak;
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
      localStorage.setItem(STORAGE_KEY, JSON.stringify(t));
    } catch {
      /* ignore quota / privacy errors */
    }
  }, [t]);

  const setTweak = useCallback<SetTweak>((key, value) => {
    setT((prev) => (prev[key] === value ? prev : { ...prev, [key]: value }));
  }, []);

  const value = useMemo(() => ({ t, setTweak }), [t, setTweak]);
  return <TweaksContext.Provider value={value}>{children}</TweaksContext.Provider>;
}

export function useTweaks() {
  const ctx = useContext(TweaksContext);
  if (!ctx) throw new Error("useTweaks must be used inside <TweaksProvider>");
  return ctx;
}
