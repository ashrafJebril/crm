import type { CSSProperties, ReactNode } from "react";
import { BrandLogo } from "@/components/BrandLogo";

/** SP-26: the centred card the sign-in and public account pages share. */
export function AuthCard({ children, dir }: { children: ReactNode; dir?: "rtl" | "ltr" }) {
  return (
    <div
      dir={dir}
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "var(--bg)",
        backgroundImage: `radial-gradient(circle at 20% 30%, var(--accent-soft), transparent 50%),
                          radial-gradient(circle at 80% 70%, oklch(0.72 0.18 268 / 0.12), transparent 60%)`,
        padding: 24,
      }}
    >
      <div
        className="card"
        style={{ width: "100%", maxWidth: 440, padding: 32, background: "var(--bg-elev)", boxShadow: "var(--shadow-lg)" }}
      >
        <div style={{ marginBottom: 24 }}>
          <BrandLogo />
        </div>
        {children}
      </div>
    </div>
  );
}

export const authFieldStyle: CSSProperties = {
  width: "100%",
  height: 38,
  paddingInline: 12,
  background: "var(--bg-2)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r)",
  color: "var(--ink)",
  fontSize: 14,
  outline: "none",
  fontFamily: "inherit",
};

export const authLabelStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--ink-3)",
  textTransform: "uppercase",
  letterSpacing: 0.06,
};

export function AuthTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <>
      <h1 style={{ margin: "0 0 4px", fontSize: 22, letterSpacing: "-0.02em" }}>{title}</h1>
      {sub && <p style={{ margin: "0 0 20px", color: "var(--ink-3)", fontSize: 13 }}>{sub}</p>}
    </>
  );
}

export function AuthField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <span className="mono" style={authLabelStyle}>
        {label}
      </span>
      {children}
    </label>
  );
}

export function AuthBanner({ message, kind = "bad" }: { message: string; kind?: "bad" | "ok" | "info" }) {
  const color = kind === "bad" ? "var(--bad)" : kind === "ok" ? "var(--ok)" : "var(--ink-2)";
  return (
    <div
      role={kind === "bad" ? "alert" : "status"}
      style={{
        padding: "10px 12px",
        borderRadius: "var(--r)",
        background: `color-mix(in oklch, ${color} 12%, transparent)`,
        color,
        fontSize: 13,
        border: `1px solid color-mix(in oklch, ${color} 35%, transparent)`,
      }}
    >
      {message}
    </div>
  );
}

/** Back to the sign-in page: drops any public fragment. */
export function goToSignIn(): void {
  window.history.replaceState(null, "", "/#/");
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}
