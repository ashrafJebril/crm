import {
  memo,
  useState,
  type CSSProperties,
  type ComponentType,
  type ReactNode,
} from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx, type Tx } from "@/lib/tx";
import { Badge } from "@/components/Badge";
import { Toggle } from "@/components/Toggle";
import { PhotoSlot } from "@/components/PhotoSlot";
import {
  IconBell,
  IconBolt,
  IconBook,
  IconCheckCircle,
  IconCog,
  IconLayers,
  IconMore,
  IconPlus,
  IconRoute,
  IconStar,
} from "@/icons";
import {
  API_KEYS,
  WEBHOOKS,
  NOTIF_PREFS,
  WHATSAPP_NUMBERS,
  SESSIONS,
  BRAND_COLORS,
  type ApiKey,
  type NotificationPref,
  type Webhook,
  type WhatsAppNumber,
} from "@/data/settings-extras";
import type { ConvChannel, Lang, Tweaks } from "@/lib/types";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";

/* ── Facebook integration shapes ─────────────────────────────────────────── */

interface FbStatus {
  connected: boolean;
  pageId?: string;
  pageName?: string;
  expiresAt?: string;
  lastFetchedAt?: string;
}

interface FbPageRow {
  id: string;
  name: string;
  active: boolean;
}

/* ── Inline channel glyphs (do not add to @/icons) ───────────────────────── */

interface GlyphProps {
  size?: number;
}

function WaIcon({ size = 14 }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#fff"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5 18l-1 4 4-1a8 8 0 1 0-3-3z" />
      <path d="M9 10c.5 1.5 1.5 2.5 3 3l1.5-1 2.5 1.5c0 1.5-1 2.5-2.5 2.5-3 0-6-3-6-6 0-1.5 1-2.5 2.5-2.5L11.5 10z" />
    </svg>
  );
}

function IgIcon({ size = 14 }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#fff"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.5" cy="6.5" r="0.6" fill="#fff" stroke="none" />
    </svg>
  );
}

function FbIcon({ size = 14 }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M14 8h2.5V5H14c-2 0-3.5 1.5-3.5 3.5V11H8v3h2.5v7H14v-7h2.5l.5-3H14V9c0-.6.4-1 1-1z"
        fill="#fff"
      />
    </svg>
  );
}

function WebIcon({ size = 14 }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#fff"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18" />
      <path d="M12 3a14 14 0 0 0 0 18" />
    </svg>
  );
}

function TtIcon({ size = 14 }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      {/* Cyan back-shadow note */}
      <path
        d="M14 4.6c.5 1.7 1.7 3 3.4 3.5v2.4a6.5 6.5 0 0 1-3.4-1V15a4.6 4.6 0 1 1-4.6-4.6c.3 0 .6 0 .9.1v2.5a2.2 2.2 0 1 0 1.5 2.1V4.6H14z"
        fill="#25F4EE"
        transform="translate(-1.2 1)"
      />
      {/* Magenta back-shadow note */}
      <path
        d="M14 4.6c.5 1.7 1.7 3 3.4 3.5v2.4a6.5 6.5 0 0 1-3.4-1V15a4.6 4.6 0 1 1-4.6-4.6c.3 0 .6 0 .9.1v2.5a2.2 2.2 0 1 0 1.5 2.1V4.6H14z"
        fill="#FE2C55"
        transform="translate(1.2 -0.4)"
      />
      {/* White note on top */}
      <path
        d="M14 4.6c.5 1.7 1.7 3 3.4 3.5v2.4a6.5 6.5 0 0 1-3.4-1V15a4.6 4.6 0 1 1-4.6-4.6c.3 0 .6 0 .9.1v2.5a2.2 2.2 0 1 0 1.5 2.1V4.6H14z"
        fill="#fff"
      />
    </svg>
  );
}

const CHANNEL_BG: Record<ConvChannel, string> = {
  whatsapp: "#25D366",
  instagram:
    "linear-gradient(135deg, #f09433 0%, #e6683c 25%, #dc2743 50%, #cc2366 75%, #bc1888 100%)",
  facebook: "#1877F2",
  tiktok: "#000000",
  webchat: "var(--info)",
};

function ChannelMark({
  channel,
  size = 44,
}: {
  channel: ConvChannel;
  size?: number;
}) {
  const glyphSize = Math.round(size * 0.46);
  const Glyph =
    channel === "whatsapp"
      ? WaIcon
      : channel === "instagram"
        ? IgIcon
        : channel === "facebook"
          ? FbIcon
          : channel === "tiktok"
            ? TtIcon
            : WebIcon;
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(8, Math.round(size * 0.22)),
        background: CHANNEL_BG[channel],
        display: "grid",
        placeItems: "center",
        flex: "0 0 auto",
      }}
    >
      <Glyph size={glyphSize} />
    </span>
  );
}

type SectionId =
  | "general"
  | "workspace"
  | "whatsapp"
  | "api"
  | "webhooks"
  | "notifications"
  | "branding"
  | "security";

interface IconProps {
  w?: number;
}

interface SectionDef {
  id: SectionId;
  label: string;
  ar: string;
  Icon: ComponentType<IconProps>;
}

const SECTIONS: SectionDef[] = [
  { id: "general", label: "General", ar: "عام", Icon: IconCog },
  { id: "workspace", label: "Workspace", ar: "مساحة العمل", Icon: IconLayers },
  { id: "whatsapp", label: "Channels", ar: "القنوات", Icon: IconRoute },
  { id: "api", label: "API & Keys", ar: "المفاتيح", Icon: IconBolt },
  { id: "webhooks", label: "Webhooks", ar: "Webhooks", Icon: IconRoute },
  { id: "notifications", label: "Notifications", ar: "الإشعارات", Icon: IconBell },
  { id: "branding", label: "Branding", ar: "العلامة", Icon: IconStar },
  { id: "security", label: "Security", ar: "الأمان", Icon: IconCheckCircle },
];

const fieldStyle: CSSProperties = {
  width: "100%",
  maxWidth: 420,
  background: "var(--bg-2)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r)",
  padding: "8px 12px",
  color: "var(--ink)",
  fontSize: 13,
  outline: "none",
};

type SetTweak = <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => void;

function SettingsImpl() {
  const { t, setTweak } = useTweaks();
  const isAr = t.lang === "ar";
  const [section, setSection] = useState<SectionId>("general");
  const [revealKey, setRevealKey] = useState<number | null>(null);

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      {/* sub nav */}
      <aside
        style={{
          width: 220,
          borderInlineEnd: "1px solid var(--line-soft)",
          padding: 14,
          background: "var(--bg-1)",
          flexShrink: 0,
          overflowY: "auto",
        }}
      >
        <div
          className="mono"
          style={{
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: 0.08,
            color: "var(--ink-3)",
            padding: "6px 8px",
          }}
        >
          {isAr ? "الإعدادات" : "Settings"}
        </div>
        {SECTIONS.map((s) => {
          const active = section === s.id;
          return (
            <div
              key={s.id}
              onClick={() => setSection(s.id)}
              className="nav-item"
              style={{
                background: active ? "var(--bg-2)" : "transparent",
                color: active ? "var(--ink)" : "var(--ink-1)",
                marginBottom: 2,
              }}
            >
              <span
                className="nav-icon"
                style={{ color: active ? "var(--accent)" : "var(--ink-2)" }}
              >
                <s.Icon w={16} />
              </span>
              <span className="nav-label">{isAr ? s.ar : s.label}</span>
            </div>
          );
        })}
      </aside>

      <div style={{ flex: 1, overflow: "auto" }}>
        {section === "general" && (
          <SettingsGeneral isAr={isAr} lang={t.lang} setTweak={setTweak} />
        )}
        {section === "workspace" && <SettingsWorkspace isAr={isAr} />}
        {section === "whatsapp" && <SettingsWhatsApp isAr={isAr} />}
        {section === "api" && (
          <SettingsAPI isAr={isAr} reveal={revealKey} setReveal={setRevealKey} />
        )}
        {section === "webhooks" && <SettingsWebhooks isAr={isAr} />}
        {section === "notifications" && <SettingsNotifications isAr={isAr} />}
        {section === "branding" && <SettingsBranding isAr={isAr} />}
        {section === "security" && <SettingsSecurity isAr={isAr} />}
      </div>
    </div>
  );
}

interface SectionHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}

function SectionHeader({ title, subtitle, actions }: SectionHeaderProps) {
  return (
    <div
      style={{
        padding: "20px 24px 12px",
        borderBottom: "1px solid var(--line-soft)",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "space-between",
        gap: 16,
      }}
    >
      <div>
        <h2
          style={{ margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: "-0.02em" }}
        >
          {title}
        </h2>
        {subtitle && (
          <p style={{ margin: "4px 0 0", color: "var(--ink-2)", fontSize: 13 }}>
            {subtitle}
          </p>
        )}
      </div>
      {actions && <div style={{ display: "flex", gap: 8 }}>{actions}</div>}
    </div>
  );
}

interface FieldRowProps {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}

function FieldRow({ label, hint, children }: FieldRowProps) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "260px 1fr",
        gap: 32,
        padding: "18px 24px",
        borderBottom: "1px solid var(--line-soft)",
      }}
    >
      <div>
        <div style={{ fontWeight: 500, fontSize: 13 }}>{label}</div>
        {hint && (
          <div
            style={{
              fontSize: 12,
              color: "var(--ink-3)",
              marginTop: 2,
              lineHeight: 1.4,
            }}
          >
            {hint}
          </div>
        )}
      </div>
      <div>{children}</div>
    </div>
  );
}

/* ── General ──────────────────────────────────────────────────────────── */

interface GeneralProps {
  isAr: boolean;
  lang: Lang;
  setTweak: SetTweak;
}

function SettingsGeneral({ isAr, lang, setTweak }: GeneralProps) {
  const days = ["S", "M", "T", "W", "T", "F", "S"];
  // The prototype highlights index !== 5 (so Friday off). Preserve that exactly.
  const isWorking = (i: number) => i !== 5;
  return (
    <div>
      <SectionHeader
        title={isAr ? "إعدادات عامة" : "General"}
        subtitle={
          isAr ? "اللغة، المنطقة الزمنية، التفضيلات" : "Language, timezone, and preferences"
        }
        actions={
          <button className="btn primary">{isAr ? "حفظ" : "Save changes"}</button>
        }
      />
      <FieldRow
        label={isAr ? "اسم مساحة العمل" : "Workspace name"}
        hint={
          isAr
            ? "يظهر لفريقك وعلى الواجهة المرئية للعملاء."
            : "Visible to your team and on customer-facing branding."
        }
      >
        <input style={fieldStyle} defaultValue="Samemha" />
      </FieldRow>
      <FieldRow
        label={isAr ? "النطاق" : "Slug"}
        hint={
          isAr
            ? "يُستخدم في الروابط القابلة للمشاركة: tkana.app/yourSlug"
            : "Used in shareable links: tkana.app/yourSlug"
        }
      >
        <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
          <span
            className="mono"
            style={{
              fontSize: 12,
              padding: "9px 12px",
              background: "var(--bg-2)",
              border: "1px solid var(--line)",
              borderInlineEnd: 0,
              borderTopLeftRadius: "var(--r)",
              borderBottomLeftRadius: "var(--r)",
              color: "var(--ink-3)",
            }}
          >
            tkana.app/
          </span>
          <input
            style={{
              ...fieldStyle,
              borderTopLeftRadius: 0,
              borderBottomLeftRadius: 0,
              maxWidth: 280,
            }}
            defaultValue="samemha"
          />
        </div>
      </FieldRow>
      <FieldRow
        label={isAr ? "اللغة الافتراضية" : "Default language"}
        hint={
          isAr
            ? "لغة الواجهة للمستخدمين الجدد في مساحة عملك."
            : "The interface language for new users in your workspace."
        }
      >
        <select
          style={{ ...fieldStyle, appearance: "none" }}
          value={lang}
          onChange={(e) => setTweak("lang", e.target.value as Lang)}
        >
          <option value="en">English</option>
          <option value="ar">العربية</option>
        </select>
      </FieldRow>
      <FieldRow label={isAr ? "المنطقة الزمنية" : "Timezone"}>
        <select
          style={{ ...fieldStyle, appearance: "none" }}
          defaultValue="Asia/Riyadh"
        >
          <option value="Asia/Riyadh">Asia/Riyadh (GMT+3)</option>
          <option value="Africa/Cairo">Africa/Cairo (GMT+2)</option>
          <option value="Europe/London">Europe/London (GMT)</option>
          <option value="America/New_York">America/New_York (GMT-5)</option>
        </select>
      </FieldRow>
      <FieldRow label={isAr ? "تنسيق التاريخ" : "Date format"}>
        <div style={{ display: "flex", gap: 6 }}>
          {["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"].map((f, i) => (
            <button key={f} className={`btn sm ${i === 0 ? "primary" : ""}`.trim()}>
              {f}
            </button>
          ))}
        </div>
      </FieldRow>
      <FieldRow
        label={isAr ? "أسبوع العمل" : "Working week"}
        hint={
          isAr
            ? "يؤثر على تقويم التحليلات وقواعد ساعات العمل."
            : "Affects analytics calendar and 'business hours' rules."
        }
      >
        <div style={{ display: "flex", gap: 4 }}>
          {days.map((d, i) => {
            const on = isWorking(i);
            return (
              <span
                key={`${d}-${i}`}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 6,
                  display: "grid",
                  placeItems: "center",
                  fontSize: 12,
                  fontFamily: "var(--font-mono)",
                  background: on ? "var(--accent-soft)" : "var(--bg-2)",
                  color: on ? "var(--accent)" : "var(--ink-3)",
                  border: "1px solid var(--line-soft)",
                  cursor: "pointer",
                }}
              >
                {d}
              </span>
            );
          })}
        </div>
      </FieldRow>
    </div>
  );
}

/* ── Workspace ─────────────────────────────────────────────────────────── */

function SettingsWorkspace({ isAr }: { isAr: boolean }) {
  return (
    <div>
      <SectionHeader
        title={isAr ? "مساحة العمل" : "Workspace"}
        subtitle={
          isAr ? "الشعار، معلومات الاتصال، المنطقة الخطرة" : "Logo, contact info, danger zone"
        }
      />
      <FieldRow
        label={isAr ? "شعار مساحة العمل" : "Workspace logo"}
        hint={
          isAr ? "PNG أو SVG مربع، ٥١٢×٥١٢ على الأقل" : "Square PNG or SVG, at least 512×512"
        }
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <PhotoSlot label="logo.svg" w={80} h={80} />
          <button className="btn">{isAr ? "رفع جديد" : "Upload new"}</button>
          <button className="btn ghost danger">{isAr ? "إزالة" : "Remove"}</button>
        </div>
      </FieldRow>
      <FieldRow label={isAr ? "القطاع" : "Industry"}>
        <select
          style={{ ...fieldStyle, appearance: "none" }}
          defaultValue="real-estate"
        >
          <option value="real-estate">Real estate</option>
          <option value="restaurant">Restaurant</option>
          <option value="ecommerce">Ecommerce</option>
          <option value="healthcare">Healthcare</option>
          <option value="saas">SaaS</option>
        </select>
      </FieldRow>
      <FieldRow label={isAr ? "حجم الشركة" : "Company size"}>
        <div style={{ display: "flex", gap: 6 }}>
          {["1-10", "11-50", "51-200", "201-1k", "1k+"].map((s, i) => (
            <button key={s} className={`btn sm ${i === 1 ? "primary" : ""}`.trim()}>
              {s}
            </button>
          ))}
        </div>
      </FieldRow>
      <FieldRow
        label={isAr ? "بريد الدعم" : "Support email"}
        hint={
          isAr
            ? "تذهب الردود التلقائية والإشعارات من هذا العنوان."
            : "Auto-replies and notifications go from this address."
        }
      >
        <input style={fieldStyle} defaultValue="hello@samemha.com" />
      </FieldRow>

      <div style={{ padding: "30px 24px" }}>
        <div
          className="card"
          style={{ borderColor: "oklch(0.7 0.22 24 / 0.3)", padding: 18 }}
        >
          <h3 style={{ margin: 0, fontSize: 14, color: "var(--bad)" }}>
            {isAr ? "المنطقة الخطرة" : "Danger zone"}
          </h3>
          <p style={{ color: "var(--ink-2)", fontSize: 13, margin: "6px 0 14px" }}>
            {isAr
              ? "هذه الإجراءات نهائية ولا يمكن التراجع عنها."
              : "These actions are permanent and cannot be undone."}
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn danger">
              {isAr ? "نقل الملكية" : "Transfer ownership"}
            </button>
            <button
              className="btn danger"
              style={{
                background: "oklch(0.7 0.22 24 / 0.12)",
                borderColor: "oklch(0.7 0.22 24 / 0.3)",
              }}
            >
              {isAr ? "حذف مساحة العمل" : "Delete workspace"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── WhatsApp ──────────────────────────────────────────────────────────── */

function SettingsWhatsApp({ isAr }: { isAr: boolean }) {
  const tx = makeTx(isAr ? "ar" : "en");
  const snippet = `<script src="https://cdn.tkana.com/chat.js" data-key="tk_live_8a4f3091d4a8c7b9"></script>`;
  const onCopy = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(snippet);
    }
    if (typeof window !== "undefined") {
      window.alert(tx("Snippet copied to clipboard", "تم نسخ الكود"));
    }
  };
  return (
    <div>
      <SectionHeader
        title={isAr ? "القنوات" : "Channels"}
        subtitle={
          isAr
            ? "اربط واتساب وفيسبوك وإنستغرام وتيك توك والشات على موقعك"
            : "Connect WhatsApp, Facebook, Instagram, TikTok, and your website chat widget"
        }
        actions={
          <button className="btn primary">
            <IconPlus w={14} />
            {isAr ? "ربط قناة" : "Connect channel"}
          </button>
        }
      />
      <div style={{ padding: 20 }}>
        {/* WhatsApp numbers (existing) */}
        <h3
          style={{
            margin: "0 0 10px",
            fontSize: 13,
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
            letterSpacing: 0.08,
            color: "var(--ink-3)",
          }}
        >
          {isAr ? "أرقام واتساب" : "WhatsApp numbers"}
        </h3>
        {WHATSAPP_NUMBERS.map((n: WhatsAppNumber) => (
          <div
            key={n.number}
            className="card"
            style={{
              padding: 16,
              marginBottom: 10,
              display: "flex",
              alignItems: "center",
              gap: 16,
            }}
          >
            <ChannelMark channel="whatsapp" size={44} />
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="mono" style={{ fontWeight: 500 }}>
                  {n.number}
                </span>
                <Badge>{n.label}</Badge>
                {n.verified && (
                  <Badge kind="ok" dot>
                    {isAr ? "موثّق" : "verified"}
                  </Badge>
                )}
              </div>
              <div
                className="mono"
                style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 4 }}
              >
                {isAr ? "الجودة" : "Quality"}:{" "}
                <span
                  style={{
                    color: n.quality === "GREEN" ? "var(--ok)" : "var(--warn)",
                  }}
                >
                  {n.quality}
                </span>
                {" · "}
                {n.msgsToday.toLocaleString()} {isAr ? "رسالة اليوم" : "msgs today"}
                {" · "}
                {isAr ? "موجّه إلى" : "routed to"} {n.agent}
              </div>
            </div>
            <button className="btn sm ghost">
              {isAr ? "إعداد" : "Configure"}
            </button>
            <button className="btn sm ghost">
              <IconMore w={14} />
            </button>
          </div>
        ))}

        {/* Facebook Pages */}
        <h3
          style={{
            margin: "24px 0 10px",
            fontSize: 13,
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
            letterSpacing: 0.08,
            color: "var(--ink-3)",
          }}
        >
          {isAr ? "صفحات فيسبوك" : "Facebook Pages"}
        </h3>
        <FacebookCard isAr={isAr} tx={tx} />

        {/* Instagram Accounts */}
        <h3
          style={{
            margin: "24px 0 10px",
            fontSize: 13,
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
            letterSpacing: 0.08,
            color: "var(--ink-3)",
          }}
        >
          {isAr ? "حسابات إنستغرام" : "Instagram Accounts"}
        </h3>
        <div
          className="card"
          style={{
            padding: 16,
            marginBottom: 10,
            display: "flex",
            alignItems: "center",
            gap: 16,
          }}
        >
          <ChannelMark channel="instagram" size={44} />
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontWeight: 500 }}>@samemha_jo</span>
              <Badge kind="ok" dot>
                {isAr ? "متّصل" : "Connected"}
              </Badge>
            </div>
            <div
              className="mono"
              style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 4 }}
            >
              instagram.com/samemha_jo · 14,209 {isAr ? "متابع" : "followers"} ·{" "}
              {isAr ? "موجّه إلى" : "routed to"} Nova
            </div>
          </div>
          <button className="btn sm ghost danger">
            {isAr ? "فصل" : "Disconnect"}
          </button>
        </div>
        <button className="btn">
          <IconPlus w={14} />
          {isAr ? "ربط حساب آخر" : "Connect another account"}
        </button>

        {/* TikTok Accounts */}
        <h3
          style={{
            margin: "24px 0 10px",
            fontSize: 13,
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
            letterSpacing: 0.08,
            color: "var(--ink-3)",
          }}
        >
          {isAr ? "حسابات تيك توك" : "TikTok Accounts"}
        </h3>
        <div
          className="card"
          style={{
            padding: 16,
            marginBottom: 10,
            display: "flex",
            alignItems: "center",
            gap: 16,
          }}
        >
          <ChannelMark channel="tiktok" size={44} />
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontWeight: 500 }}>@samemha_jo</span>
              <Badge kind="ok" dot>
                {isAr ? "متّصل" : "Connected"}
              </Badge>
            </div>
            <div
              className="mono"
              style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 4 }}
            >
              tiktok.com/@samemha_jo · 9,847 {isAr ? "متابع" : "followers"} ·{" "}
              {isAr ? "موجّه إلى" : "routed to"} Nova
            </div>
          </div>
          <button className="btn sm ghost danger">
            {isAr ? "فصل" : "Disconnect"}
          </button>
        </div>
        <button className="btn">
          <IconPlus w={14} />
          {isAr ? "ربط حساب آخر" : "Connect another account"}
        </button>

        {/* Web chat widget */}
        <h3
          style={{
            margin: "24px 0 10px",
            fontSize: 13,
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
            letterSpacing: 0.08,
            color: "var(--ink-3)",
          }}
        >
          {isAr ? "ودجة الشات على الموقع" : "Web chat widget"}
        </h3>
        <div className="card" style={{ padding: 16, marginBottom: 10 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 16,
              marginBottom: 12,
            }}
          >
            <ChannelMark channel="webchat" size={44} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 500 }}>
                {isAr ? "كود التضمين" : "Embed snippet"}
              </div>
              <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>
                {isAr
                  ? "الصق هذا الكود قبل </body> في موقعك."
                  : "Paste this snippet just before </body> on your website."}
              </div>
            </div>
            <button className="btn sm" onClick={onCopy}>
              {isAr ? "نسخ" : "Copy"}
            </button>
          </div>
          <pre
            style={{
              background: "var(--bg-1)",
              border: "1px solid var(--line-soft)",
              borderRadius: "var(--r-md)",
              padding: 14,
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              overflow: "auto",
              margin: 0,
              color: "var(--ink-1)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {snippet}
          </pre>
        </div>

        {/* Business profile (existing) */}
        <div style={{ marginTop: 24 }}>
          <h3 style={{ margin: "0 0 12px", fontSize: 14 }}>
            {isAr ? "ملف الأعمال" : "Business profile"}
          </h3>
          <div
            className="card"
            style={{
              padding: 18,
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 18,
            }}
          >
            <BizField label={isAr ? "اسم العرض" : "Display name"} value="Samemha" />
            <BizField label={isAr ? "الفئة" : "Category"} value="Real Estate" />
            <BizField label={isAr ? "الموقع" : "Website"} value="samemha.com" />
            <BizField
              label={isAr ? "نبذة" : "About"}
              value={
                isAr
                  ? "عقارات فاخرة وإدارة ممتلكات في دول الخليج."
                  : "Premium real estate & property management across the GCC."
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Facebook integration card + modals ──────────────────────────────────── */

function formatExpiry(iso: string | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  return new Date(t).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

interface FacebookCardProps {
  isAr: boolean;
  tx: Tx;
}

function FacebookCard({ isAr, tx }: FacebookCardProps) {
  const fbStatusQ = useFetch<FbStatus>("/integrations/facebook/status");
  const [showConnect, setShowConnect] = useState(false);
  const [showSwitch, setShowSwitch] = useState(false);

  const disconnectMut = useMutation<void, { ok: true }>(() =>
    api.delete<{ ok: true }>("/integrations/facebook/disconnect"),
  );

  function onDisconnect() {
    disconnectMut
      .mutate()
      .then(() => fbStatusQ.refetch())
      .catch(() => {
        /* error surfaced below */
      });
  }

  const status = fbStatusQ.data;
  const connected = status?.connected === true;

  return (
    <>
      <div
        className="card"
        style={{
          padding: 16,
          marginBottom: 10,
          display: "flex",
          alignItems: "center",
          gap: 16,
        }}
      >
        <ChannelMark channel="facebook" size={44} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <span style={{ fontWeight: 500 }}>
              {connected
                ? (status?.pageName ?? (isAr ? "صفحة فيسبوك" : "Facebook Page"))
                : isAr
                  ? "غير متّصل"
                  : "Not connected"}
            </span>
            {fbStatusQ.loading && (
              <span
                className="mono muted"
                style={{ fontSize: 11 }}
              >
                {isAr ? "تحميل…" : "loading…"}
              </span>
            )}
            {connected && (
              <Badge kind="ok" dot>
                {isAr ? "متّصل" : "Connected"}
              </Badge>
            )}
          </div>
          <div
            className="mono"
            style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 4 }}
          >
            {connected ? (
              <>
                {status?.pageId && (
                  <>
                    {isAr ? "معرّف الصفحة" : "Page ID"}: {status.pageId}
                    {" · "}
                  </>
                )}
                {isAr ? "ينتهي في" : "expires"} {formatExpiry(status?.expiresAt)}
              </>
            ) : (
              <>
                {isAr
                  ? "اربط صفحة فيسبوك لجلب المنشورات والتعليقات الحقيقية."
                  : "Connect a Facebook Page to pull real posts and comments."}
              </>
            )}
          </div>
          {fbStatusQ.error && (
            <div
              style={{
                fontSize: 11,
                color: "var(--bad)",
                marginTop: 4,
                fontFamily: "var(--font-mono)",
              }}
            >
              {fbStatusQ.error}
            </div>
          )}
          {disconnectMut.error && (
            <div
              style={{
                fontSize: 11,
                color: "var(--bad)",
                marginTop: 4,
                fontFamily: "var(--font-mono)",
              }}
            >
              {disconnectMut.error}
            </div>
          )}
        </div>
        {connected ? (
          <>
            <button
              className="btn sm ghost"
              onClick={() => setShowSwitch(true)}
              type="button"
            >
              {isAr ? "تبديل الصفحة" : "Switch page"}
            </button>
            <button
              className="btn sm ghost danger"
              onClick={onDisconnect}
              disabled={disconnectMut.loading}
              type="button"
            >
              {disconnectMut.loading
                ? isAr
                  ? "جاري الفصل…"
                  : "Disconnecting…"
                : isAr
                  ? "فصل"
                  : "Disconnect"}
            </button>
          </>
        ) : (
          <button
            className="btn primary sm"
            onClick={() => setShowConnect(true)}
            type="button"
          >
            <IconPlus w={14} />
            {isAr ? "ربط فيسبوك" : "Connect Facebook"}
          </button>
        )}
      </div>

      {showConnect && (
        <FbConnectModal
          tx={tx}
          onClose={() => setShowConnect(false)}
          onConnected={() => {
            setShowConnect(false);
            fbStatusQ.refetch();
          }}
        />
      )}
      {showSwitch && (
        <FbSwitchPageModal
          tx={tx}
          onClose={() => setShowSwitch(false)}
          onSwitched={() => {
            setShowSwitch(false);
            fbStatusQ.refetch();
          }}
        />
      )}
    </>
  );
}

interface FbConnectModalProps {
  tx: Tx;
  onClose: () => void;
  onConnected: () => void;
}

function FbConnectModal({ tx, onClose, onConnected }: FbConnectModalProps) {
  const [token, setToken] = useState("");
  const connectMut = useMutation<{ accessToken: string }, FbStatus>((input) =>
    api.post<FbStatus>("/integrations/facebook/connect", input),
  );

  function onSubmit() {
    const t = token.trim();
    if (!t) return;
    connectMut
      .mutate({ accessToken: t })
      .then(() => {
        onConnected();
      })
      .catch(() => {
        /* error rendered below */
      });
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "oklch(0 0 0 / 0.5)",
        display: "grid",
        placeItems: "center",
        zIndex: 100,
        backdropFilter: "blur(2px)",
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ width: 520, padding: 20 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: 0, fontSize: 16 }}>
          {tx("Connect Facebook Page", "ربط صفحة فيسبوك")}
        </h3>
        <p
          style={{
            margin: "4px 0 16px",
            color: "var(--ink-2)",
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          {tx(
            "Generate a Page Access Token in Meta Graph Explorer (with pages_read_engagement, pages_manage_metadata, and pages_manage_engagement scopes), then paste it below.",
            "أنشئ رمز وصول للصفحة من Meta Graph Explorer (مع صلاحيات pages_read_engagement وpages_manage_metadata وpages_manage_engagement)، ثم الصقه أدناه.",
          )}
        </p>
        <label
          className="mono"
          style={{
            fontSize: 11,
            textTransform: "uppercase",
            color: "var(--ink-3)",
            display: "block",
          }}
        >
          {tx("Page Access Token", "رمز وصول الصفحة")}
        </label>
        <textarea
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="EAAB..."
          style={{
            ...fieldStyle,
            marginTop: 6,
            maxWidth: "100%",
            minHeight: 110,
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            resize: "vertical",
          }}
        />
        {connectMut.error && (
          <div
            style={{
              marginTop: 10,
              padding: "8px 10px",
              borderRadius: "var(--r)",
              background: "oklch(0.7 0.22 24 / 0.08)",
              color: "var(--bad)",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
            }}
          >
            {connectMut.error}
          </div>
        )}
        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: 20,
          }}
        >
          <button className="btn ghost" onClick={onClose} type="button">
            {tx("Cancel", "إلغاء")}
          </button>
          <button
            className="btn primary"
            onClick={onSubmit}
            disabled={token.trim().length === 0 || connectMut.loading}
            type="button"
          >
            {connectMut.loading
              ? tx("Connecting…", "جاري الربط…")
              : tx("Connect", "اربط")}
          </button>
        </div>
      </div>
    </div>
  );
}

interface FbSwitchPageModalProps {
  tx: Tx;
  onClose: () => void;
  onSwitched: () => void;
}

function FbSwitchPageModal({ tx, onClose, onSwitched }: FbSwitchPageModalProps) {
  const pagesQ = useFetch<FbPageRow[]>("/integrations/facebook/pages");
  const [pickedId, setPickedId] = useState<string | null>(null);
  const selectMut = useMutation<{ pageId: string }, FbStatus>((input) =>
    api.post<FbStatus>("/integrations/facebook/select-page", input),
  );

  function onSubmit() {
    if (!pickedId) return;
    selectMut
      .mutate({ pageId: pickedId })
      .then(() => onSwitched())
      .catch(() => {
        /* error rendered below */
      });
  }

  const pages = pagesQ.data ?? [];

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "oklch(0 0 0 / 0.5)",
        display: "grid",
        placeItems: "center",
        zIndex: 100,
        backdropFilter: "blur(2px)",
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ width: 480, maxHeight: "80vh", padding: 20, display: "flex", flexDirection: "column" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: 0, fontSize: 16 }}>
          {tx("Switch Facebook Page", "تبديل صفحة فيسبوك")}
        </h3>
        <p
          style={{
            margin: "4px 0 16px",
            color: "var(--ink-2)",
            fontSize: 13,
          }}
        >
          {tx(
            "Pick which page should be the active source of posts and comments.",
            "اختر الصفحة التي ستكون المصدر النشط للمنشورات والتعليقات.",
          )}
        </p>
        <div
          style={{
            border: "1px solid var(--line-soft)",
            borderRadius: "var(--r)",
            overflow: "auto",
            flex: 1,
            minHeight: 80,
          }}
        >
          {pagesQ.loading && (
            <div
              className="muted mono"
              style={{ padding: 12, fontSize: 12 }}
            >
              {tx("Loading pages…", "تحميل الصفحات…")}
            </div>
          )}
          {pagesQ.error && (
            <div
              style={{
                padding: 12,
                fontSize: 12,
                color: "var(--bad)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {pagesQ.error}
            </div>
          )}
          {!pagesQ.loading && pages.length === 0 && !pagesQ.error && (
            <div
              className="muted"
              style={{ padding: 12, fontSize: 12 }}
            >
              {tx("No pages found.", "لا توجد صفحات.")}
            </div>
          )}
          {pages.map((p) => {
            const isPicked = pickedId === p.id;
            return (
              <label
                key={p.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 12px",
                  borderBottom: "1px solid var(--line-soft)",
                  cursor: "pointer",
                  background: isPicked ? "var(--accent-soft)" : "transparent",
                }}
              >
                <input
                  type="radio"
                  name="fb-page"
                  checked={isPicked}
                  onChange={() => setPickedId(p.id)}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500, fontSize: 13 }}>{p.name}</div>
                  <div
                    className="mono"
                    style={{ fontSize: 11, color: "var(--ink-3)" }}
                  >
                    {p.id}
                  </div>
                </div>
                {p.active && (
                  <Badge kind="ok" dot>
                    {tx("active", "نشط")}
                  </Badge>
                )}
              </label>
            );
          })}
        </div>
        {selectMut.error && (
          <div
            style={{
              marginTop: 10,
              padding: "8px 10px",
              borderRadius: "var(--r)",
              background: "oklch(0.7 0.22 24 / 0.08)",
              color: "var(--bad)",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
            }}
          >
            {selectMut.error}
          </div>
        )}
        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: 16,
          }}
        >
          <button className="btn ghost" onClick={onClose} type="button">
            {tx("Cancel", "إلغاء")}
          </button>
          <button
            className="btn primary"
            onClick={onSubmit}
            disabled={!pickedId || selectMut.loading}
            type="button"
          >
            {selectMut.loading
              ? tx("Switching…", "جاري التبديل…")
              : tx("Switch page", "تبديل الصفحة")}
          </button>
        </div>
      </div>
    </div>
  );
}

function BizField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        className="mono"
        style={{ fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase" }}
      >
        {label}
      </div>
      <div
        style={{
          fontWeight: 500,
          marginTop: 2,
          lineHeight: 1.4,
          fontSize: 13,
        }}
      >
        {value}
      </div>
    </div>
  );
}

/* ── API ───────────────────────────────────────────────────────────────── */

interface APIProps {
  isAr: boolean;
  reveal: number | null;
  setReveal: (v: number | null) => void;
}

const FULL_KEY_PLACEHOLDER = "tk_live_82a4f3091d4a8c7b9e5d2c91d";

function SettingsAPI({ isAr, reveal, setReveal }: APIProps) {
  return (
    <div>
      <SectionHeader
        title={isAr ? "API والمفاتيح" : "API & Keys"}
        subtitle={
          isAr
            ? "استخدم هذه المفاتيح للوصول إلى REST و WebSocket."
            : "Use these keys to call the tkana REST and WebSocket APIs"
        }
        actions={
          <button className="btn primary">
            <IconPlus w={14} />
            {isAr ? "إنشاء مفتاح" : "Generate key"}
          </button>
        }
      />
      <div style={{ padding: 20 }}>
        <div className="card">
          <table className="tbl">
            <thead>
              <tr>
                <th>{isAr ? "الاسم" : "Name"}</th>
                <th>{isAr ? "المفتاح" : "Key"}</th>
                <th>{isAr ? "الصلاحيات" : "Permissions"}</th>
                <th>{isAr ? "تاريخ الإنشاء" : "Created"}</th>
                <th>{isAr ? "آخر استخدام" : "Last used"}</th>
                <th style={{ width: 80 }} />
              </tr>
            </thead>
            <tbody>
              {API_KEYS.map((k: ApiKey, i: number) => {
                const isRevealed = reveal === i;
                return (
                  <tr key={k.name}>
                    <td style={{ fontWeight: 500 }}>{k.name}</td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      <span
                        style={{
                          background: "var(--bg-2)",
                          padding: "2px 8px",
                          borderRadius: 4,
                          border: "1px solid var(--line-soft)",
                        }}
                      >
                        {isRevealed ? FULL_KEY_PLACEHOLDER : k.key}
                      </span>
                      <button
                        className="btn sm ghost"
                        style={{ marginInlineStart: 6 }}
                        onClick={() => setReveal(isRevealed ? null : i)}
                      >
                        {isRevealed ? (isAr ? "إخفاء" : "Hide") : isAr ? "عرض" : "Reveal"}
                      </button>
                    </td>
                    <td>
                      <Badge kind={k.perms === "Read only" ? "" : "ai"}>{k.perms}</Badge>
                    </td>
                    <td className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                      {k.created}
                    </td>
                    <td className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                      {k.lastUsed}
                    </td>
                    <td>
                      <button className="btn sm ghost danger">
                        {isAr ? "إلغاء" : "Revoke"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: 20 }}>
          <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>
            {isAr ? "بداية سريعة" : "Quick start"}
          </h3>
          <pre
            style={{
              background: "var(--bg-1)",
              border: "1px solid var(--line-soft)",
              borderRadius: "var(--r-md)",
              padding: 16,
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              overflow: "auto",
              margin: 0,
              color: "var(--ink-1)",
            }}
          >
{`curl https://api.tkana.app/v2/conversations \\
  -H "Authorization: Bearer tk_live_••••••••" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "+966502348810",
    "agent": "luna",
    "message": "Welcome back, Reem!"
  }'`}
          </pre>
        </div>
      </div>
    </div>
  );
}

/* ── Webhooks ──────────────────────────────────────────────────────────── */

function SettingsWebhooks({ isAr }: { isAr: boolean }) {
  const [items, setItems] = useState<Webhook[]>(WEBHOOKS);

  const toggle = (idx: number) => {
    setItems((prev) =>
      prev.map((w, i) =>
        i === idx
          ? { ...w, status: w.status === "active" ? "paused" : "active" }
          : w,
      ),
    );
  };

  const kindFor = (s: Webhook["status"]) =>
    s === "active" ? "ok" : s === "paused" ? "warn" : "bad";

  return (
    <div>
      <SectionHeader
        title="Webhooks"
        subtitle={
          isAr
            ? "استقبل الأحداث الفورية على نقاط النهاية الخاصة بك"
            : "Receive real-time events at your endpoints"
        }
        actions={
          <button className="btn primary">
            <IconPlus w={14} />
            {isAr ? "إضافة نقطة" : "Add endpoint"}
          </button>
        }
      />
      <div style={{ padding: 20 }}>
        {items.map((w, i) => (
          <div
            key={w.url}
            className="card"
            style={{ padding: 16, marginBottom: 10 }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                marginBottom: 8,
              }}
            >
              <Badge kind={kindFor(w.status)} dot>
                {w.status}
              </Badge>
              <span
                className="mono"
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {w.url}
              </span>
              <Toggle on={w.status === "active"} onChange={() => toggle(i)} />
              <button className="btn sm ghost">
                <IconMore w={14} />
              </button>
            </div>
            <div
              style={{
                display: "flex",
                gap: 24,
                fontSize: 12,
                color: "var(--ink-3)",
                fontFamily: "var(--font-mono)",
              }}
            >
              <span>
                {w.events} {isAr ? "حدث" : "events"}
              </span>
              <span>
                {isAr ? "آخر تسليم" : "last delivery"} {w.lastDelivery}
              </span>
              <span
                style={{
                  color:
                    w.success > 95
                      ? "var(--ok)"
                      : w.success > 75
                        ? "var(--warn)"
                        : "var(--bad)",
                }}
              >
                {w.success}% {isAr ? "نجاح" : "success"}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Notifications ─────────────────────────────────────────────────────── */

type NotifChannel = "email" | "sms" | "push" | "inApp";

function SettingsNotifications({ isAr }: { isAr: boolean }) {
  const [prefs, setPrefs] = useState<NotificationPref[]>(NOTIF_PREFS);

  const toggle = (idx: number, ch: NotifChannel) => {
    setPrefs((prev) =>
      prev.map((p, i) => (i === idx ? { ...p, [ch]: !p[ch] } : p)),
    );
  };

  return (
    <div>
      <SectionHeader
        title={isAr ? "الإشعارات" : "Notifications"}
        subtitle={isAr ? "اختر طريقة تنبيهك" : "Choose how you'd like to be alerted"}
      />
      <div style={{ padding: 20 }}>
        <div className="card">
          <table className="tbl">
            <thead>
              <tr>
                <th>{isAr ? "الحدث" : "Event"}</th>
                <th style={{ textAlign: "center" }}>{isAr ? "بريد" : "Email"}</th>
                <th style={{ textAlign: "center" }}>SMS</th>
                <th style={{ textAlign: "center" }}>{isAr ? "إشعار" : "Push"}</th>
                <th style={{ textAlign: "center" }}>{isAr ? "داخل التطبيق" : "In-app"}</th>
              </tr>
            </thead>
            <tbody>
              {prefs.map((n, i) => (
                <tr key={n.area}>
                  <td style={{ fontWeight: 500 }}>{n.area}</td>
                  <td style={{ textAlign: "center" }}>
                    <CenteredToggle
                      on={n.email}
                      onChange={() => toggle(i, "email")}
                    />
                  </td>
                  <td style={{ textAlign: "center" }}>
                    <CenteredToggle on={n.sms} onChange={() => toggle(i, "sms")} />
                  </td>
                  <td style={{ textAlign: "center" }}>
                    <CenteredToggle on={n.push} onChange={() => toggle(i, "push")} />
                  </td>
                  <td style={{ textAlign: "center" }}>
                    <CenteredToggle
                      on={n.inApp}
                      onChange={() => toggle(i, "inApp")}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function CenteredToggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div style={{ display: "inline-flex" }}>
      <Toggle on={on} onChange={onChange} />
    </div>
  );
}

/* ── Branding ──────────────────────────────────────────────────────────── */

function SettingsBranding({ isAr }: { isAr: boolean }) {
  const [colorIdx, setColorIdx] = useState<number>(0);
  return (
    <div>
      <SectionHeader
        title={isAr ? "العلامة" : "Branding"}
        subtitle={
          isAr
            ? "كيف يبدو tkana لفريقك وعملائك"
            : "How tkana looks to your team and customers"
        }
      />
      <FieldRow
        label={isAr ? "لون العلامة" : "Brand color"}
        hint={
          isAr
            ? "يُستخدم في القوالب والفواتير وبريد العملاء."
            : "Used in templates, invoices, and customer emails."
        }
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {BRAND_COLORS.map((c, i) => (
            <span
              key={c}
              onClick={() => setColorIdx(i)}
              style={{
                width: 32,
                height: 32,
                borderRadius: "50%",
                background: c,
                border: i === colorIdx ? "2px solid var(--ink)" : "2px solid transparent",
                cursor: "pointer",
              }}
            />
          ))}
          <input
            className="mono"
            style={{ ...fieldStyle, maxWidth: 140, marginInlineStart: 8 }}
            defaultValue="#21D196"
          />
        </div>
      </FieldRow>
      <FieldRow label={isAr ? "الشعار (فاتح)" : "Logo (light)"}>
        <PhotoSlot label="logo-light.svg" w={180} h={64} />
      </FieldRow>
      <FieldRow label={isAr ? "الشعار (داكن)" : "Logo (dark)"}>
        <PhotoSlot label="logo-dark.svg" w={180} h={64} />
      </FieldRow>
      <FieldRow
        label={isAr ? "نطاق مخصص" : "Custom domain"}
        hint={
          isAr
            ? "وجّه CNAME من tkana.samemha.com إلى app.tkana.app."
            : "CNAME tkana.samemha.com to app.tkana.app."
        }
      >
        <input className="mono" style={fieldStyle} defaultValue="tkana.samemha.com" />
      </FieldRow>
      <FieldRow label={isAr ? "تذييل البريد" : "Email footer"}>
        <textarea
          style={{ ...fieldStyle, minHeight: 80, fontFamily: "var(--font-mono)" }}
          defaultValue="Samemha · King Fahd Rd, Riyadh · samemha.com"
        />
      </FieldRow>
    </div>
  );
}

/* ── Security ──────────────────────────────────────────────────────────── */

function SettingsSecurity({ isAr }: { isAr: boolean }) {
  const [twoFA, setTwoFA] = useState<boolean>(true);
  const tx = makeTx(isAr ? "ar" : "en");
  const sessionTimes = ["1h", "8h", "24h", "7d", "Never"];
  return (
    <div>
      <SectionHeader
        title={isAr ? "الأمان" : "Security"}
        subtitle={
          isAr
            ? "المصادقة، الجلسات، سجل التدقيق"
            : "Authentication, sessions, audit trail"
        }
      />
      <FieldRow
        label={isAr ? "المصادقة الثنائية (2FA)" : "Two-factor (2FA)"}
        hint={
          isAr
            ? "مطلوبة لجميع أعضاء مساحة العمل."
            : "Required for all members of this workspace."
        }
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Toggle on={twoFA} onChange={setTwoFA} />
          <span
            style={{
              color: "var(--ok)",
              fontSize: 12,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <IconCheckCircle w={14} />
            {isAr ? "مفروض على جميع الأعضاء" : "Enforced for all members"}
          </span>
        </div>
      </FieldRow>
      <FieldRow
        label={isAr ? "الدخول الموحّد (SSO)" : "Single sign-on (SSO)"}
        hint={
          isAr
            ? "SAML 2.0 — متاح على خطط Scale و Enterprise."
            : "SAML 2.0 — available on Scale and Enterprise plans."
        }
      >
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <Badge>SAML 2.0</Badge>
          <Badge>Okta</Badge>
          <Badge>Google</Badge>
          <button className="btn sm" style={{ marginInlineStart: 8 }}>
            {isAr ? "إعداد" : "Configure"}
          </button>
        </div>
      </FieldRow>
      <FieldRow
        label={isAr ? "مهلة الجلسة" : "Session timeout"}
        hint={
          isAr
            ? "سيتم تسجيل خروج الأعضاء بعد هذه الفترة من الخمول."
            : "Members will be signed out after this period of inactivity."
        }
      >
        <div style={{ display: "flex", gap: 6 }}>
          {sessionTimes.map((s, i) => (
            <button key={s} className={`btn sm ${i === 2 ? "primary" : ""}`.trim()}>
              {s}
            </button>
          ))}
        </div>
      </FieldRow>
      <FieldRow
        label={isAr ? "نطاقات IP المسموح بها" : "Allowed IP ranges"}
        hint={
          isAr
            ? "تقييد الوصول إلى مساحة العمل لشبكات محددة."
            : "Restrict workspace access to specific networks."
        }
      >
        <textarea
          style={{ ...fieldStyle, fontFamily: "var(--font-mono)", minHeight: 60 }}
          defaultValue={"10.0.0.0/8\n203.0.113.0/24"}
        />
      </FieldRow>
      <FieldRow label={isAr ? "الجلسات النشطة" : "Active sessions"}>
        <div style={{ display: "grid", gap: 8 }}>
          {SESSIONS.map((s) => (
            <div
              key={s.device}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 12px",
                background: "var(--bg-2)",
                borderRadius: "var(--r)",
                border: "1px solid var(--line-soft)",
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>
                  {s.device}
                  {s.current && (
                    <span
                      style={{
                        color: "var(--accent)",
                        marginInlineStart: 8,
                        fontSize: 11,
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      ● {tx("current", "حالية")}
                    </span>
                  )}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--ink-3)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {s.loc} · {s.last}
                </div>
              </div>
              {!s.current && (
                <button className="btn sm ghost danger">
                  {isAr ? "إنهاء" : "Revoke"}
                </button>
              )}
            </div>
          ))}
        </div>
      </FieldRow>
      <FieldRow
        label={isAr ? "سجل التدقيق" : "Audit log"}
        hint={
          isAr
            ? "احتفظ بسجل لكل تغيير للامتثال (١٨٠ يومًا على Pro)."
            : "Keep a record of every change for compliance (180 days retention on Pro)."
        }
      >
        <button className="btn">
          <IconBook w={14} />
          {isAr ? "عرض السجل" : "View audit log"}
        </button>
      </FieldRow>
    </div>
  );
}

const Settings = memo(SettingsImpl);
export default Settings;
