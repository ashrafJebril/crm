// Glyphs this screen needs that the shared set (@/icons) doesn't carry —
// ported verbatim from the source design's inline SVGs so the platform row and
// tip cards look the same. Everything else here reuses the house icons
// (IconSparkles, IconSearch, IconCheck, IconBook, IconBolt).
//
// All of them paint with `currentColor`, so colour comes from the CSS class
// that wraps them — never a hardcoded hex.

interface GlyphProps {
  size?: number;
}

// ── UI glyphs ───────────────────────────────────────────────────────────────
export const IcLock = ({ size = 15 }: GlyphProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" strokeWidth="1.6" />
    <path d="M8 11V8a4 4 0 018 0v3" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);

export const IcCopy = ({ size = 17 }: GlyphProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <rect x="8" y="8" width="12" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
    <path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);

// Filled triangle — the house IconPlay is an outline, which reads as an empty
// shape at 17px inside the gold run button.
export const IcPlay = ({ size = 17 }: GlyphProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M8 5.5v13a1 1 0 001.54.84l10-6.5a1 1 0 000-1.68l-10-6.5A1 1 0 008 5.5z" />
  </svg>
);

// ── Platform glyphs ─────────────────────────────────────────────────────────
export const IcMeta = ({ size = 17 }: GlyphProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M4 15c0-4 1.6-7 4-7 1.7 0 2.8 1.5 4 4 1.2-2.5 2.3-4 4-4 2.4 0 4 3 4 7 0 2-.9 3-2.2 3-1.5 0-2.3-1.4-3.4-3.4C15 12.9 14.3 11.6 12 11.6S9 12.9 7.6 14.6C6.5 16.6 5.7 18 4.2 18 2.9 18 2 17 2 15"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const IcGoogle = ({ size = 16 }: GlyphProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M20.5 12.2c0-.6-.05-1.2-.15-1.7H12v3.3h4.8a4.1 4.1 0 01-1.8 2.7v2.2h2.9c1.7-1.6 2.6-3.9 2.6-6.5z" fill="currentColor" />
    <path d="M12 21c2.4 0 4.5-.8 6-2.2l-2.9-2.2c-.8.55-1.9.9-3.1.9-2.4 0-4.4-1.6-5.1-3.8H3.9v2.3A9 9 0 0012 21z" fill="currentColor" opacity=".75" />
    <path d="M6.9 13.7a5.4 5.4 0 010-3.4V8H3.9a9 9 0 000 8l3-2.3z" fill="currentColor" opacity=".55" />
    <path d="M12 6.6c1.3 0 2.5.45 3.4 1.35l2.6-2.6A9 9 0 003.9 8l3 2.3C7.6 8.15 9.6 6.6 12 6.6z" fill="currentColor" opacity=".9" />
  </svg>
);

export const IcTiktok = ({ size = 15 }: GlyphProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M14 3c.3 2.4 1.7 4 4 4.3v3c-1.5 0-2.9-.4-4-1.1v6.2A5.8 5.8 0 118 9.7v3.1a2.8 2.8 0 103 2.7V3h3z" fill="currentColor" />
  </svg>
);

export const IcSnap = ({ size = 16 }: GlyphProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M12 3c2.5 0 4 1.9 4 4.3 0 .9-.1 1.7-.1 2.2.5.3 1.1.2 1.7 0 .8-.2 1.2.7.6 1.2-.5.4-1.4.6-1.9.9-.4.9 1.6 3.3 3.4 3.7.5.1.5.7 0 .9-.6.3-1.5.2-1.8.9-.2.5.1 1-.5 1.1-.7.1-1.4-.5-2.3-.2-.8.3-1.5 1.3-3.3 1.3s-2.5-1-3.3-1.3c-.9-.3-1.6.3-2.3.2-.6-.1-.3-.6-.5-1.1-.3-.7-1.2-.6-1.8-.9-.5-.2-.5-.8 0-.9 1.8-.4 3.8-2.8 3.4-3.7-.5-.3-1.4-.5-1.9-.9-.6-.5-.2-1.4.6-1.2.6.2 1.2.3 1.7 0 0-.5-.1-1.3-.1-2.2C8 4.9 9.5 3 12 3z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
  </svg>
);

export const IcAnalytics = ({ size = 16 }: GlyphProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <rect x="4" y="12" width="4" height="8" rx="1.5" fill="currentColor" opacity=".6" />
    <rect x="10" y="7" width="4" height="13" rx="1.5" fill="currentColor" opacity=".8" />
    <rect x="16" y="4" width="4" height="16" rx="1.5" fill="currentColor" />
  </svg>
);

// ── Tip-card glyphs ─────────────────────────────────────────────────────────
export const IcTarget = ({ size = 18 }: GlyphProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.7" />
    <circle cx="12" cy="12" r="3.6" stroke="currentColor" strokeWidth="1.7" />
    <circle cx="12" cy="12" r="1" fill="currentColor" />
  </svg>
);

export const IcRefresh = ({ size = 18 }: GlyphProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M20 11a8 8 0 00-14-4M4 5v4h4M4 13a8 8 0 0014 4m2 2v-4h-4"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const IcBolt = ({ size = 18 }: GlyphProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" fill="currentColor" />
  </svg>
);
