import { useEffect, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { useAuth, type AuthUser } from "@/auth/context";
import { useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import { Avatar } from "@/components/Avatar";
import { ErrorRow, Field, SettingsCard, StatusToast, inputStyle } from "./form";

/* Common avatar hues. Stored as strings (the existing palette is OKLCH hue). */
const COLORS = ["150", "200", "240", "320", "60", "10", "100", "270"];

export function ProfileTab() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { user } = useAuth();

  const [name, setName] = useState(user?.name ?? "");
  const [color, setColor] = useState(user?.color ?? "200");
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (user) {
      setName(user.name);
      setColor(user.color);
    }
  }, [user]);

  const saveMut = useMutation<{ name?: string; color?: string }, AuthUser>(
    (input) => api.patch<AuthUser>("/auth/me", input),
  );

  const passMut = useMutation<
    { currentPassword: string; newPassword: string },
    { ok: true }
  >((input) => api.post("/auth/change-password", input));

  const onSaveProfile = async () => {
    if (!user) return;
    const patch: { name?: string; color?: string } = {};
    if (name.trim() && name.trim() !== user.name) patch.name = name.trim();
    if (color !== user.color) patch.color = color;
    if (Object.keys(patch).length === 0) {
      setStatus(tx("Nothing to save.", "لا تغييرات للحفظ."));
      window.setTimeout(() => setStatus(null), 1500);
      return;
    }
    await saveMut.mutate(patch);
    setStatus(tx("Profile saved.", "تم حفظ الحساب."));
    window.setTimeout(() => setStatus(null), 2400);
  };

  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);

  const onChangePassword = async () => {
    setPwError(null);
    if (newPw.length < 6) {
      setPwError(tx("New password must be at least 6 characters.", "كلمة المرور الجديدة ٦ خانات على الأقل."));
      return;
    }
    if (newPw !== confirmPw) {
      setPwError(tx("New password and confirmation don't match.", "كلمتا المرور غير متطابقتين."));
      return;
    }
    try {
      await passMut.mutate({ currentPassword: currentPw, newPassword: newPw });
      setCurrentPw("");
      setNewPw("");
      setConfirmPw("");
      setStatus(tx("Password changed.", "تم تغيير كلمة المرور."));
      window.setTimeout(() => setStatus(null), 2400);
    } catch {
      /* error stays in passMut.error */
    }
  };

  if (!user) {
    return (
      <div className="muted" style={{ fontSize: 13 }}>
        {tx("Not signed in.", "غير مسجل الدخول.")}
      </div>
    );
  }

  return (
    <>
      <SettingsCard
        title={tx("Your profile", "حسابك")}
        description={tx(
          "How you appear to your teammates across Kewy Marketing.",
          "كيف تظهر لزملائك في كيوي ماركتنج.",
        )}
        footer={
          <button
            type="button"
            className="btn primary"
            onClick={onSaveProfile}
            disabled={saveMut.loading}
          >
            {saveMut.loading ? tx("Saving…", "جارٍ الحفظ…") : tx("Save profile", "حفظ")}
          </button>
        }
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Avatar name={name || user.name} color={color} size="xl" />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 500 }}>{name || user.name}</div>
            <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
              {user.email}
            </div>
          </div>
        </div>

        <Field label={tx("Display name", "الاسم الظاهر")}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={inputStyle}
          />
        </Field>

        <Field
          label={tx("Avatar color", "لون الصورة")}
          hint={tx("Used as the background of your initials avatar.", "يُستخدم خلفية لأحرف اسمك.")}
        >
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {COLORS.map((c) => {
              const active = c === color;
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  aria-label={`hue ${c}`}
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: "50%",
                    background: `oklch(0.6 0.18 ${c})`,
                    border: active ? "2px solid var(--ink-1)" : "2px solid transparent",
                    cursor: "pointer",
                    padding: 0,
                  }}
                />
              );
            })}
          </div>
        </Field>

        <Field label={tx("Email", "البريد الإلكتروني")} hint={tx("Read-only.", "للقراءة فقط.")}>
          <input
            type="email"
            value={user.email}
            disabled
            style={{ ...inputStyle, fontFamily: "var(--font-mono)", opacity: 0.7 }}
          />
        </Field>

        <ErrorRow message={saveMut.error} />
      </SettingsCard>

      <SettingsCard
        title={tx("Change password", "تغيير كلمة المرور")}
        description={tx(
          "Choose a password at least 6 characters long.",
          "اختر كلمة مرور لا تقل عن ٦ خانات.",
        )}
        footer={
          <button
            type="button"
            className="btn primary"
            onClick={onChangePassword}
            disabled={
              passMut.loading ||
              currentPw.length < 6 ||
              newPw.length < 6 ||
              confirmPw.length < 6
            }
          >
            {passMut.loading ? tx("Updating…", "جارٍ…") : tx("Change password", "تغيير")}
          </button>
        }
      >
        <Field label={tx("Current password", "كلمة المرور الحالية")}>
          <input
            type="password"
            value={currentPw}
            onChange={(e) => setCurrentPw(e.target.value)}
            autoComplete="current-password"
            style={inputStyle}
          />
        </Field>
        <Field label={tx("New password", "كلمة المرور الجديدة")}>
          <input
            type="password"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            autoComplete="new-password"
            minLength={6}
            style={inputStyle}
          />
        </Field>
        <Field label={tx("Confirm new password", "تأكيد كلمة المرور الجديدة")}>
          <input
            type="password"
            value={confirmPw}
            onChange={(e) => setConfirmPw(e.target.value)}
            autoComplete="new-password"
            minLength={6}
            style={inputStyle}
          />
        </Field>
        <ErrorRow message={pwError ?? passMut.error} />
      </SettingsCard>

      <StatusToast message={status} />
    </>
  );
}
