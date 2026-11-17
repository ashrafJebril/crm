import { useEffect, useState } from "react";
import { api } from "@/api/client";
import { Modal } from "@/components/Modal";
import type { Tx } from "@/lib/tx";
import type { NotificationPreference } from "@/lib/types";

const TYPES: Array<{ type: string; en: string; ar: string }> = [
  { type: "assignment", en: "Assignments", ar: "الإسنادات" },
  { type: "mention", en: "Mentions", ar: "الإشارات" },
  { type: "activity_due", en: "Activities due", ar: "الأنشطة المستحقة" },
  { type: "connector_needs_attention", en: "Connections needing attention", ar: "اتصالات تحتاج انتباهًا" },
  { type: "knowledge_source_failed", en: "Knowledge source failures", ar: "إخفاق مصادر المعرفة" },
  { type: "campaign_finished", en: "Campaigns finished", ar: "انتهاء الحملات" },
  { type: "import_finished", en: "Imports finished", ar: "اكتمال الاستيراد" },
  // SP-24: in-app alerts from Automatic messages (new ticket, new lead).
  { type: "lifecycle", en: "Automatic message alerts", ar: "تنبيهات الرسائل التلقائية" },
];

type Prefs = Record<string, { inApp: boolean; sound: boolean }>;

export function NotificationPrefsDialog({ tx, onClose }: { tx: Tx; onClose: () => void }) {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .get<{ items: NotificationPreference[] } | NotificationPreference[]>("/notifications/preferences")
      .then((res) => {
        if (!alive) return;
        const list = Array.isArray(res) ? res : res.items;
        const map: Prefs = {};
        for (const t of TYPES) map[t.type] = { inApp: true, sound: true };
        for (const p of list ?? []) map[p.type] = { inApp: p.inApp, sound: p.sound };
        setPrefs(map);
      })
      .catch(() => {
        if (alive) setError(tx("Couldn't load preferences.", "تعذّر تحميل التفضيلات."));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (type: string, key: "inApp" | "sound", v: boolean) =>
    setPrefs((p) => (p ? { ...p, [type]: { ...p[type]!, [key]: v } } : p));

  const save = async () => {
    if (!prefs) return;
    setSaving(true);
    setError(null);
    try {
      await api.put("/notifications/preferences", {
        items: TYPES.map((t) => ({ type: t.type, ...prefs[t.type]! })),
      });
      onClose();
    } catch {
      setError(tx("Couldn't save preferences.", "تعذّر حفظ التفضيلات."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose} width={440} label={tx("Notification preferences", "تفضيلات الإشعارات")}>
      <h3 style={{ margin: "0 0 12px", fontSize: 15 }}>
        {tx("Notification preferences", "تفضيلات الإشعارات")}
      </h3>
      {!prefs && !error && (
        <div style={{ color: "var(--ink-3)", fontSize: 12 }}>{tx("Loading…", "جارٍ التحميل…")}</div>
      )}
      {prefs && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ color: "var(--ink-3)", fontSize: 11 }}>
              <th style={{ textAlign: "start", fontWeight: 500, paddingBottom: 6 }} />
              <th style={{ fontWeight: 500, paddingBottom: 6 }}>{tx("In-app", "داخل التطبيق")}</th>
              <th style={{ fontWeight: 500, paddingBottom: 6 }}>{tx("Sound", "الصوت")}</th>
            </tr>
          </thead>
          <tbody>
            {TYPES.map((t) => (
              <tr key={t.type} style={{ borderTop: "1px solid var(--line-soft)" }}>
                <td style={{ padding: "8px 0" }}>{tx(t.en, t.ar)}</td>
                {(["inApp", "sound"] as const).map((k) => (
                  <td key={k} style={{ textAlign: "center" }}>
                    <input
                      type="checkbox"
                      role="switch"
                      checked={prefs[t.type]![k]}
                      onChange={(e) => set(t.type, k, e.target.checked)}
                      aria-label={`${tx(t.en, t.ar)} — ${
                        k === "inApp" ? tx("In-app", "داخل التطبيق") : tx("Sound", "الصوت")
                      }`}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {error && <div style={{ color: "var(--bad)", fontSize: 12, marginTop: 8 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
        <button type="button" className="btn ghost sm" onClick={onClose}>
          {tx("Cancel", "إلغاء")}
        </button>
        <button type="button" className="btn primary sm" onClick={save} disabled={!prefs || saving}>
          {saving ? tx("Saving…", "جارٍ الحفظ…") : tx("Save", "حفظ")}
        </button>
      </div>
    </Modal>
  );
}
