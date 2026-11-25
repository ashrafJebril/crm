import { useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import type { Tx } from "@/lib/tx";
import type { ChannelDto } from "@/lib/types";
import { IconPlus, IconX } from "@/icons";
import { channelErrorText, errorField } from "./channelErrors";
import {
  MAX_ALLOWED_ORIGINS,
  MAX_GREETING,
  validateWebchatForm,
  webchatFormFrom,
  type WebchatForm,
} from "./channelModel";
import { ErrorText, LabeledField, ORIGIN_OPTS, fieldInput, fieldLabel } from "./channelUi";

/**
 * Website chat settings: allowed websites, greeting EN/AR, colour, position,
 * ask-for-name and language. Validated on the client with the same table as
 * the backend's `validateWebchatConfig`; a server `invalid_config {field}` is
 * mapped back onto its input.
 */
export function WebchatSettingsForm({
  channel,
  tx,
  canEdit,
  onSaved,
}: {
  channel: ChannelDto;
  tx: Tx;
  canEdit: boolean;
  onSaved: (c: ChannelDto) => void;
}) {
  const [form, setForm] = useState<WebchatForm>(() => withBlankOrigin(webchatFormFrom(channel.config)));
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<{ text: string; field: string | null } | null>(null);
  const [saved, setSaved] = useState(false);

  // A realtime refresh of another edit replaces the form only while it is untouched.
  useEffect(() => {
    if (!touched) setForm(withBlankOrigin(webchatFormFrom(channel.config)));
  }, [channel.config, touched]);

  useEffect(() => {
    if (!saved) return;
    const t = window.setTimeout(() => setSaved(false), 2200);
    return () => window.clearTimeout(t);
  }, [saved]);

  const { config, errors } = useMemo(() => validateWebchatForm(form, ORIGIN_OPTS), [form]);
  const invalid = Object.keys(errors).length > 0;

  const update = <K extends keyof WebchatForm>(k: K, v: WebchatForm[K]) => {
    setTouched(true);
    setServerError(null);
    setForm((f) => ({ ...f, [k]: v }));
  };

  const save = async () => {
    if (invalid || !canEdit) return;
    setSaving(true);
    setServerError(null);
    try {
      const next = await api.patch<ChannelDto>(`/channels/${encodeURIComponent(channel.id)}`, { config });
      setTouched(false);
      setSaved(true);
      onSaved(next);
    } catch (e) {
      setServerError({ text: channelErrorText(e, tx), field: errorField(e) });
    } finally {
      setSaving(false);
    }
  };

  const fieldErr = (f: keyof WebchatForm) => serverError?.field === f;
  const originErr = errors.allowedOrigins;
  const badIndex = originErr && originErr !== true ? originErr.index : -1;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "grid", gap: 6 }}>
        <span style={fieldLabel}>{tx("Allowed websites", "المواقع المسموح بها")}</span>
        <span className="muted" style={{ fontSize: 11.5, lineHeight: 1.45 }}>
          {tx(
            "The chat opens only on these sites. Use the exact address, like https://shop.example, or https://*.shop.example for every subdomain. No paths.",
            "تفتح المحادثة على هذه المواقع فقط. استخدم العنوان الدقيق مثل https://shop.example، أو https://*.shop.example لكل النطاقات الفرعية. بدون مسارات.",
          )}
        </span>
        {form.allowedOrigins.map((o, i) => (
          <div key={i} style={{ display: "flex", gap: 6 }}>
            <input
              dir="ltr"
              value={o}
              disabled={!canEdit}
              onChange={(e) => {
                const list = [...form.allowedOrigins];
                list[i] = e.target.value;
                update("allowedOrigins", list);
              }}
              placeholder="https://shop.example"
              aria-invalid={i === badIndex || undefined}
              aria-label={tx(`Website ${i + 1}`, `الموقع ${i + 1}`)}
              style={{
                ...fieldInput,
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                borderColor: i === badIndex || fieldErr("allowedOrigins") ? "var(--bad)" : "var(--line)",
              }}
            />
            {canEdit && (
              <button
                type="button"
                className="btn ghost icon"
                aria-label={tx("Remove website", "إزالة الموقع")}
                onClick={() => {
                  const list = form.allowedOrigins.filter((_, j) => j !== i);
                  update("allowedOrigins", list.length ? list : [""]);
                }}
              >
                <IconX w={13} />
              </button>
            )}
          </div>
        ))}
        {originErr && (
          <span role="alert" style={{ fontSize: 11.5, color: "var(--bad)" }}>
            {originErr === true
              ? tx(`At most ${MAX_ALLOWED_ORIGINS} websites.`, `${MAX_ALLOWED_ORIGINS} موقعًا كحد أقصى.`)
              : tx(
                  "Use https://host or https://*.host with no path (http://localhost only while testing).",
                  "استخدم https://host أو https://*.host بدون مسار (http://localhost للاختبار فقط).",
                )}
          </span>
        )}
        {canEdit && form.allowedOrigins.length < MAX_ALLOWED_ORIGINS && (
          <button
            type="button"
            className="btn ghost sm"
            style={{ justifySelf: "start" }}
            onClick={() => update("allowedOrigins", [...form.allowedOrigins, ""])}
          >
            <IconPlus w={12} />
            {tx("Add website", "إضافة موقع")}
          </button>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <LabeledField
          label={tx("Greeting (English)", "الترحيب (بالإنجليزية)")}
          error={errors.greeting || fieldErr("greeting") ? tx(`At most ${MAX_GREETING} characters.`, `${MAX_GREETING} حرفًا كحد أقصى.`) : null}
        >
          <textarea
            dir="ltr"
            rows={3}
            value={form.greeting}
            disabled={!canEdit}
            onChange={(e) => update("greeting", e.target.value)}
            placeholder="Hi! How can we help?"
            style={{ ...fieldInput, height: "auto", padding: 8, resize: "vertical" }}
          />
        </LabeledField>
        <LabeledField
          label={tx("Greeting (Arabic)", "الترحيب (بالعربية)")}
          error={errors.greetingAr || fieldErr("greetingAr") ? tx(`At most ${MAX_GREETING} characters.`, `${MAX_GREETING} حرفًا كحد أقصى.`) : null}
        >
          <textarea
            dir="rtl"
            rows={3}
            value={form.greetingAr}
            disabled={!canEdit}
            onChange={(e) => update("greetingAr", e.target.value)}
            placeholder="أهلًا! كيف نقدر نساعدك؟"
            style={{ ...fieldInput, height: "auto", padding: 8, resize: "vertical" }}
          />
        </LabeledField>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <LabeledField
          label={tx("Colour", "اللون")}
          // SP-29: an empty channel colour falls back to the workspace brand colour.
          hint={form.color.trim() === "" ? tx("Uses the workspace brand colour", "يستخدم لون العلامة التجارية لمساحة العمل") : undefined}
          error={errors.color || fieldErr("color") ? tx("Use a hex colour like #22AA88.", "استخدم لونًا سداسيًا مثل ‎#22AA88.") : null}
        >
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="color"
              value={/^#[0-9a-fA-F]{6}$/.test(form.color) ? form.color : "#22aa88"}
              disabled={!canEdit}
              onChange={(e) => update("color", e.target.value)}
              aria-label={tx("Pick colour", "اختر اللون")}
              style={{ width: 40, height: 36, padding: 2, background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 8 }}
            />
            <input
              dir="ltr"
              value={form.color}
              disabled={!canEdit}
              onChange={(e) => update("color", e.target.value)}
              placeholder={tx("Default", "افتراضي")}
              style={{ ...fieldInput, fontFamily: "var(--font-mono)", fontSize: 12 }}
            />
          </div>
        </LabeledField>
        <LabeledField label={tx("Bubble position", "موضع الزر")}>
          <select
            value={form.position}
            disabled={!canEdit}
            onChange={(e) => update("position", e.target.value as "start" | "end")}
            style={fieldInput}
          >
            <option value="end">{tx("End (right in English, left in Arabic)", "النهاية (يمين بالإنجليزية، يسار بالعربية)")}</option>
            <option value="start">{tx("Start (left in English, right in Arabic)", "البداية (يسار بالإنجليزية، يمين بالعربية)")}</option>
          </select>
        </LabeledField>
        <LabeledField label={tx("Language", "اللغة")}>
          <select
            value={form.lang ?? ""}
            disabled={!canEdit}
            onChange={(e) => update("lang", (e.target.value || null) as "en" | "ar" | null)}
            style={fieldInput}
          >
            <option value="">{tx("Automatic (visitor's browser)", "تلقائي (متصفح الزائر)")}</option>
            <option value="en">English</option>
            <option value="ar">العربية</option>
          </select>
        </LabeledField>
      </div>

      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
        <input
          type="checkbox"
          checked={form.askName}
          disabled={!canEdit}
          onChange={(e) => update("askName", e.target.checked)}
        />
        {tx("Ask visitors for their name", "اطلب من الزوار أسماءهم")}
      </label>

      <ErrorText>{serverError?.text}</ErrorText>

      {canEdit && (
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
          {saved && <span style={{ fontSize: 12, color: "var(--ok)" }}>{tx("Saved", "تم الحفظ")}</span>}
          {touched && (
            <button
              type="button"
              className="btn ghost"
              disabled={saving}
              onClick={() => {
                setTouched(false);
                setServerError(null);
                setForm(withBlankOrigin(webchatFormFrom(channel.config)));
              }}
            >
              {tx("Reset", "استعادة")}
            </button>
          )}
          <button type="button" className="btn primary" disabled={saving || invalid || !touched} onClick={save}>
            {saving ? tx("Saving…", "جارٍ الحفظ…") : tx("Save settings", "حفظ الإعدادات")}
          </button>
        </div>
      )}
    </div>
  );
}

/** Always show at least one (empty) origin row to type into. */
function withBlankOrigin(f: WebchatForm): WebchatForm {
  return f.allowedOrigins.length ? f : { ...f, allowedOrigins: [""] };
}
