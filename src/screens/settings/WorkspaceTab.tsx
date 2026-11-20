import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { useAuth } from "@/auth/context";
import { usePermissions } from "@/auth/usePermissions";
import { api } from "@/api/client";
import type { Workspace } from "@/lib/types";
import { brandInk, contrastRatio, normalizeBrandColor, safeBrandColor } from "@/lib/brandColor";
import { WorkspaceMark } from "@/shell/WorkspaceMark";
import { ErrorRow, Field, SaveBar, SettingsCard, inputStyle } from "./form";
import { BRAND_COLOR_COPY, DEFAULT_CHAT_COLOR, LOGO_ACCEPT, SAVED_FLASH_MS, brandErrorText, logoCheckError, validateLogoFile } from "./brand";
import { isDirty, patchOf, saveBarState, type GeneralForm } from "./saveBar";
import { removeLogo, uploadLogo } from "./brandApi";

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

const formOf = (w: Workspace | null | undefined): GeneralForm => ({
  name: w?.name ?? "",
  timezone: w?.timezone ?? "Asia/Riyadh",
  lang: w?.lang ?? "ar",
  brandColor: safeBrandColor(w?.brandColor) ?? "",
});

const labelStyle = { fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.06 } as const;

/**
 * General settings (SP-29): name, language, timezone and the brand colour
 * share one sticky save bar; the logo uploads as soon as it is chosen (R7).
 * The colour reaches a style only after the client re-validates it.
 */
export function WorkspaceTab() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { activeWorkspace, refreshWorkspace } = useAuth();
  const canEdit = usePermissions().can("settings.update");

  const initial = useMemo(() => formOf(activeWorkspace), [activeWorkspace]);
  const [form, setForm] = useState<GeneralForm>(initial);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Reset the form only when the workspace itself changes (a logo refresh keeps the edits).
  const wsId = activeWorkspace?.id ?? null;
  const lastId = useRef(wsId);
  useEffect(() => {
    if (lastId.current === wsId) return;
    lastId.current = wsId;
    setForm(formOf(activeWorkspace));
    setSaveError(null);
    setSavedAt(null);
  }, [wsId, activeWorkspace]);

  // "Saved" shows for SAVED_FLASH_MS, then the bar hides.
  useEffect(() => {
    if (savedAt === null) return;
    const id = window.setTimeout(() => setSavedAt(null), SAVED_FLASH_MS);
    return () => window.clearTimeout(id);
  }, [savedAt]);

  const dirty = canEdit && isDirty(form, initial);
  const barState = saveBarState({ dirty, saving, error: saveError, savedAt, now: Date.now(), readOnly: !canEdit });
  useLeaveGuard(dirty, tx("You have unsaved changes. Leave anyway?", "لديك تغييرات غير محفوظة. هل تريد المغادرة؟"));

  const set = <K extends keyof GeneralForm>(k: K, v: GeneralForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setSavedAt(null);
  };

  const colourCheck = normalizeBrandColor(form.brandColor);
  const colourInvalid = colourCheck === undefined;

  const save = async () => {
    if (!activeWorkspace || saving) return;
    if (colourInvalid) {
      setSaveError(BRAND_COLOR_COPY(tx));
      return;
    }
    const patch = patchOf(form, initial);
    if (Object.keys(patch).length === 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.patch<Workspace>(`/workspaces/${activeWorkspace.id}`, patch);
      // Show the normalised values, then pick up the saved workspace everywhere (no reload).
      setForm((f) => ({ ...f, name: f.name.trim(), brandColor: colourCheck ?? "" }));
      await refreshWorkspace().catch(() => undefined);
      setSavedAt(Date.now());
    } catch (e) {
      setSaveError(brandErrorText(e, tx));
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setForm(initial);
    setSaveError(null);
  };

  if (!activeWorkspace) {
    return (
      <div className="muted" style={{ fontSize: 13 }}>
        {tx("No active workspace.", "لا توجد مساحة عمل نشطة.")}
      </div>
    );
  }

  const swatch = safeBrandColor(form.brandColor);

  return (
    <>
      <SettingsCard
        title={tx("Workspace details", "تفاصيل مساحة العمل")}
        description={
          canEdit
            ? tx("Edit how this workspace appears across the app.", "عدّل كيف تظهر المساحة في كل أنحاء التطبيق.")
            : tx("Only owners and admins can edit these fields.", "المالك والمشرف فقط يمكنهم التعديل.")
        }
      >
        <Field label={tx("Name", "الاسم")}>
          <input type="text" value={form.name} onChange={(e) => set("name", e.target.value)} disabled={!canEdit} style={inputStyle} />
        </Field>
        <Field label={tx("Slug", "المعرّف")} hint={tx("Read-only — used in URLs.", "للقراءة فقط — يستخدم في الروابط.")}>
          <input
            type="text"
            value={activeWorkspace.slug}
            disabled
            dir="ltr"
            style={{ ...inputStyle, fontFamily: "var(--font-mono)", opacity: 0.7 }}
          />
        </Field>
        <Field label={tx("Default language", "اللغة الافتراضية")}>
          <select value={form.lang} onChange={(e) => set("lang", e.target.value)} disabled={!canEdit} style={inputStyle}>
            <option value="ar">العربية</option>
            <option value="en">English</option>
          </select>
        </Field>
        <Field label={tx("Timezone", "المنطقة الزمنية")}>
          <select value={form.timezone} onChange={(e) => set("timezone", e.target.value)} disabled={!canEdit} style={inputStyle}>
            {COMMON_TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
            {!COMMON_TIMEZONES.includes(form.timezone) && <option value={form.timezone}>{form.timezone}</option>}
          </select>
        </Field>
      </SettingsCard>

      <SettingsCard
        title={tx("Branding", "الهوية")}
        description={tx(
          "Your logo and colour mark this workspace in the sidebar, the switcher, the web chat and emails.",
          "يميّز الشعار واللون مساحة العمل في الشريط الجانبي ومبدّل المساحات والدردشة والبريد.",
        )}
      >
        <LogoField workspace={activeWorkspace} canEdit={canEdit} onChanged={refreshWorkspace} />

        <div style={{ display: "grid", gap: 6 }}>
          <label htmlFor="brand-colour-hex" className="mono" style={labelStyle}>
            {tx("Brand colour", "لون العلامة التجارية")}
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <input
              type="color"
              aria-label={tx("Pick a brand colour", "اختر لون العلامة التجارية")}
              value={swatch ?? DEFAULT_CHAT_COLOR}
              onChange={(e) => set("brandColor", e.target.value)}
              disabled={!canEdit}
              style={{
                inlineSize: 38,
                blockSize: 38,
                padding: 2,
                border: "1px solid var(--line)",
                borderRadius: 8,
                background: "var(--bg-2)",
                cursor: canEdit ? "pointer" : "default",
              }}
            />
            <input
              id="brand-colour-hex"
              type="text"
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              placeholder="#c9a55a"
              maxLength={7}
              value={form.brandColor}
              onChange={(e) => set("brandColor", e.target.value)}
              disabled={!canEdit}
              aria-invalid={colourInvalid || undefined}
              aria-describedby={colourInvalid ? "brand-colour-error" : undefined}
              style={{ ...inputStyle, inlineSize: 130, fontFamily: "var(--font-mono)", borderColor: colourInvalid ? "var(--bad)" : "var(--line)" }}
            />
            {swatch ? (
              <span
                aria-hidden="true"
                style={{ display: "inline-flex", alignItems: "center", padding: "6px 12px", borderRadius: 8, background: swatch, color: brandInk(swatch), fontSize: 12, fontWeight: 600 }}
              >
                {tx("Sample text", "نص تجريبي")}
              </span>
            ) : null}
            {swatch ? (
              <span className="muted" style={{ fontSize: 11 }}>
                {tx("Contrast", "التباين")} <bdi dir="ltr">{contrastRatio(swatch, brandInk(swatch)).toFixed(1)}:1</bdi>
              </span>
            ) : null}
            {canEdit && form.brandColor !== "" ? (
              <button type="button" className="btn ghost sm" onClick={() => set("brandColor", "")}>
                {tx("Clear", "مسح")}
              </button>
            ) : null}
          </div>
          {colourInvalid ? (
            <span id="brand-colour-error" role="alert" style={{ fontSize: 12, color: "var(--bad)" }}>
              {BRAND_COLOR_COPY(tx)}
            </span>
          ) : (
            <span className="muted" style={{ fontSize: 11 }}>
              {swatch ? (
                <>
                  {tx("Saved as ", "يُحفظ بالقيمة ")}
                  <bdi dir="ltr">{swatch}</bdi>
                  {tx(". Text on it uses the colour with the higher contrast.", ". يُكتب النص عليه باللون الأعلى تباينًا.")}
                </>
              ) : (
                tx("No colour set. The default mark is used.", "لم يُحدَّد لون. تُستخدم العلامة الافتراضية.")
              )}
            </span>
          )}
        </div>
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

      {canEdit ? (
        <SaveBar
          state={barState}
          error={saveError}
          onSave={save}
          onDiscard={discard}
          labels={{
            unsaved: tx("Unsaved changes", "تغييرات غير محفوظة"),
            discard: tx("Discard", "تجاهل"),
            save: tx("Save", "حفظ"),
            saving: tx("Saving…", "جارٍ الحفظ…"),
            saved: tx("Saved", "تم الحفظ"),
            failed: tx("Couldn't save. Your changes are kept.", "تعذّر الحفظ. تغييراتك محفوظة."),
          }}
        />
      ) : null}
    </>
  );
}

/** Logo: preview, upload on choose (with progress), remove with a confirm. */
function LogoField({ workspace, canEdit, onChanged }: { workspace: Workspace; canEdit: boolean; onChanged: () => Promise<void> }) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const busy = progress !== null || removing;

  const onFile = useCallback(
    async (file: File | null) => {
      if (inputRef.current) inputRef.current.value = "";
      setError(null);
      // Checked before any upload starts (type, SVG refusal, 2 MB).
      const check = validateLogoFile(file);
      if (check || !file) {
        setError(brandErrorText(logoCheckError(check ?? { key: "media.no_file", extra: {} }), tx));
        return;
      }
      setProgress(0);
      try {
        await uploadLogo(workspace.id, file, setProgress);
        await onChanged().catch(() => undefined);
      } catch (e) {
        setError(brandErrorText(e, tx));
      } finally {
        setProgress(null);
      }
    },
    [workspace.id, onChanged, tx],
  );

  const onRemove = async () => {
    if (!window.confirm(tx("Remove the workspace logo?", "هل تريد إزالة شعار مساحة العمل؟"))) return;
    setRemoving(true);
    setError(null);
    try {
      await removeLogo(workspace.id);
      await onChanged().catch(() => undefined);
    } catch (e) {
      setError(brandErrorText(e, tx));
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <span className="mono" style={labelStyle}>
        {tx("Logo", "الشعار")}
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ display: "inline-flex", padding: 4, border: "1px solid var(--line-soft)", borderRadius: 12, background: "var(--bg-2)" }}>
          <WorkspaceMark name={workspace.name} logoUrl={workspace.logoUrl} brandColor={workspace.brandColor} size={64} />
        </span>
        {canEdit ? (
          <div style={{ display: "grid", gap: 6 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="btn" onClick={() => inputRef.current?.click()} disabled={busy}>
                {tx("Upload logo", "رفع الشعار")}
              </button>
              {workspace.logoUrl ? (
                <button type="button" className="btn ghost danger" onClick={onRemove} disabled={busy}>
                  {tx("Remove", "إزالة")}
                </button>
              ) : null}
              <input ref={inputRef} type="file" accept={LOGO_ACCEPT} hidden onChange={(e) => void onFile(e.target.files?.[0] ?? null)} />
            </div>
            <span className="muted" style={{ fontSize: 11 }}>
              {tx("PNG, JPG or WebP, up to 2 MB", "PNG أو JPG أو WebP، حتى 2 ميغابايت")}
            </span>
            {progress !== null ? (
              <div role="status" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                <progress max={100} value={Math.round(progress * 100)} style={{ inlineSize: 140 }} />
                <bdi dir="ltr">{Math.round(progress * 100)}%</bdi>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <ErrorRow message={error} />
    </div>
  );
}

/**
 * While the form is dirty: the browser's leave prompt on unload, and a
 * confirm before any in-app route change. Routes live in the hash, so a
 * capture-phase hashchange listener (it runs before the router's) restores
 * the previous URL and stops the event when the user stays.
 */
function useLeaveGuard(dirty: boolean, message: string) {
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = message;
      return message;
    };
    const onHash = (e: HashChangeEvent) => {
      if (window.confirm(message)) return;
      e.stopImmediatePropagation();
      window.history.replaceState(window.history.state, "", e.oldURL);
    };
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("hashchange", onHash, true);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      window.removeEventListener("hashchange", onHash, true);
    };
  }, [dirty, message]);
}
