import { useEffect, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { useAuth } from "@/auth/context";
import { useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import type { Workspace } from "@/lib/types";
import { ErrorRow, Field, SettingsCard, StatusToast, inputStyle } from "./form";

const COMMON_TIMEZONES = [
  "Asia/Riyadh",
  "Asia/Dubai",
  "Asia/Kuwait",
  "Asia/Amman",
  "Africa/Cairo",
  "Europe/London",
  "Europe/Istanbul",
  "America/New_York",
  "America/Los_Angeles",
];

export function WorkspaceTab() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { activeWorkspace } = useAuth();

  const canEdit = activeWorkspace?.role === "owner" || activeWorkspace?.role === "admin";

  const [name, setName] = useState(activeWorkspace?.name ?? "");
  const [timezone, setTimezone] = useState(activeWorkspace?.timezone ?? "Asia/Riyadh");
  const [lang, setLang] = useState(activeWorkspace?.lang ?? "ar");
  const [status, setStatus] = useState<string | null>(null);

  // Keep form state synced when the active workspace switches.
  useEffect(() => {
    if (activeWorkspace) {
      setName(activeWorkspace.name);
      setTimezone(activeWorkspace.timezone);
      setLang(activeWorkspace.lang);
    }
  }, [activeWorkspace]);

  const saveMut = useMutation<
    { name?: string; timezone?: string; lang?: string },
    Workspace
  >((input) =>
    api.patch<Workspace>(`/workspaces/${activeWorkspace?.id}`, input),
  );

  const submit = async () => {
    if (!activeWorkspace) return;
    const patch: { name?: string; timezone?: string; lang?: string } = {};
    if (name.trim() !== activeWorkspace.name) patch.name = name.trim();
    if (timezone !== activeWorkspace.timezone) patch.timezone = timezone;
    if (lang !== activeWorkspace.lang) patch.lang = lang;
    if (Object.keys(patch).length === 0) {
      setStatus(tx("Nothing to save.", "لا تغييرات للحفظ."));
      window.setTimeout(() => setStatus(null), 1500);
      return;
    }
    await saveMut.mutate(patch);
    setStatus(tx("Saved. Refresh to see the new name everywhere.", "تم الحفظ. حدّث الصفحة لرؤية الاسم الجديد."));
    window.setTimeout(() => setStatus(null), 2400);
  };

  if (!activeWorkspace) {
    return (
      <div className="muted" style={{ fontSize: 13 }}>
        {tx("No active workspace.", "لا توجد مساحة عمل نشطة.")}
      </div>
    );
  }

  return (
    <>
      <SettingsCard
        title={tx("Workspace details", "تفاصيل مساحة العمل")}
        description={
          canEdit
            ? tx("Edit how this workspace appears across the app.", "عدّل كيف تظهر المساحة في كل أنحاء التطبيق.")
            : tx("Only owners and admins can edit these fields.", "المالك والمشرف فقط يمكنهم التعديل.")
        }
        footer={
          canEdit ? (
            <button
              type="button"
              className="btn primary"
              onClick={submit}
              disabled={saveMut.loading}
            >
              {saveMut.loading ? tx("Saving…", "جارٍ الحفظ…") : tx("Save changes", "حفظ التغييرات")}
            </button>
          ) : null
        }
      >
        <Field label={tx("Name", "الاسم")}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!canEdit}
            style={inputStyle}
          />
        </Field>
        <Field label={tx("Slug", "المعرّف")} hint={tx("Read-only — used in URLs.", "للقراءة فقط — يستخدم في الروابط.")}>
          <input
            type="text"
            value={activeWorkspace.slug}
            disabled
            style={{ ...inputStyle, fontFamily: "var(--font-mono)", opacity: 0.7 }}
          />
        </Field>
        <Field label={tx("Default language", "اللغة الافتراضية")}>
          <select
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            disabled={!canEdit}
            style={inputStyle}
          >
            <option value="ar">العربية</option>
            <option value="en">English</option>
          </select>
        </Field>
        <Field label={tx("Timezone", "المنطقة الزمنية")}>
          <select
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            disabled={!canEdit}
            style={inputStyle}
          >
            {COMMON_TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
            {!COMMON_TIMEZONES.includes(timezone) && (
              <option value={timezone}>{timezone}</option>
            )}
          </select>
        </Field>
        <ErrorRow message={saveMut.error} />
      </SettingsCard>

      <SettingsCard
        title={tx("Plan", "الخطة")}
        description={tx(
          "Plan changes will move here when billing is wired. For now plans are set by Kewy ops.",
          "ستظهر إدارة الخطة هنا عند ربط الفوترة. حالياً تُدار من فريق كيوي.",
        )}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            style={{
              padding: "6px 12px",
              borderRadius: 999,
              background: "var(--bg-2)",
              border: "1px solid var(--line-soft)",
              fontSize: 13,
              fontWeight: 600,
              textTransform: "capitalize",
            }}
          >
            {activeWorkspace.plan}
          </span>
          <span className="muted" style={{ fontSize: 12 }}>
            {tx("Contact Kewy support to change plans.", "تواصل مع دعم كيوي لتغيير الخطة.")}
          </span>
        </div>
      </SettingsCard>

      <StatusToast message={status} />
    </>
  );
}
