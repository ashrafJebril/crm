// Analytics screen-specific extras: heatmap synth, stacked-bars weekly buckets,
// funnel steps, and the donut resolution mix. These are deliberately scoped to
// the Analytics screen and NOT shared via the global @/data layer.

export interface ResolutionMixItem {
  labelEn: string;
  labelAr: string;
  color: string;
  pct: number;
  count: string;
}

export const RESOLUTION_MIX: ResolutionMixItem[] = [
  { labelEn: "AI resolved",        labelAr: "حل ذاتي",       color: "var(--accent)", pct: 68, count: "5,734" },
  { labelEn: "AI + human assist",  labelAr: "ذكاء + بشري",  color: "var(--info)",   pct: 18, count: "1,517" },
  { labelEn: "Escalated to human", labelAr: "تصعيد",         color: "var(--warn)",   pct: 9,  count: "759" },
  { labelEn: "Unresolved",         labelAr: "لم يحل",        color: "var(--bad)",    pct: 5,  count: "421" },
];

export interface FunnelStep {
  labelEn: string;
  labelAr: string;
  value: number;
  width: number; // 0..1
}

export const FUNNEL: FunnelStep[] = [
  { labelEn: "Conversations started", labelAr: "بدأ المحادثة", value: 8432, width: 1.0 },
  { labelEn: "Replied to AI",         labelAr: "ردّ على الذكاء", value: 7821, width: 0.93 },
  { labelEn: "Qualified",             labelAr: "تأهّل",         value: 4218, width: 0.5 },
  { labelEn: "Booked / proposal",     labelAr: "حجز/عرض",       value: 1847, width: 0.22 },
  { labelEn: "Converted",             labelAr: "تحوّل",          value: 1142, width: 0.135 },
];

export interface WeeklyBar {
  ai: number;
  hum: number;
  esc: number;
}

export const WEEKLY_VOLUME: WeeklyBar[] = [
  { ai: 1240, hum: 420, esc: 92 },
  { ai: 1410, hum: 396, esc: 84 },
  { ai: 1612, hum: 411, esc: 78 },
  { ai: 1842, hum: 432, esc: 71 },
];

// Deterministic heatmap (no Math.random per render). 7 days × 24 hours.
export const HEATMAP: number[][] = (() => {
  const rng = mulberry32(42);
  const out: number[][] = [];
  for (let d = 0; d < 7; d++) {
    const row: number[] = [];
    for (let h = 0; h < 24; h++) {
      const peakA = Math.exp(-Math.pow((h - 13) / 4, 2)) * (d < 5 ? 1.2 : 0.9);
      const peakB = Math.exp(-Math.pow((h - 19) / 3, 2)) * (d < 5 ? 0.9 : 1.3);
      row.push(Math.round((peakA + peakB) * 80 + rng() * 12));
    }
    out.push(row);
  }
  return out;
})();

// Pre-computed leaderboard extras (resolved counts + csat for human teammates),
// kept stable so SSR & client agree and the chart doesn't churn between paints.
export interface LeaderboardExtras {
  id: string;
  resolved: number;
  csat: number;
}

export const HUMAN_LEADERBOARD: LeaderboardExtras[] = [
  { id: "u3", resolved: 86, csat: 92 },
  { id: "u4", resolved: 73, csat: 90 },
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
