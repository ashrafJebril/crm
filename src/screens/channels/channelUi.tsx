import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { API_BASE } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import { useRealtime } from "@/api/useRealtime";
import { getHashParam, setHashParam } from "@/lib/hashState";
import type { Tx } from "@/lib/tx";
import type { ChannelDto, ChannelLimits, EmbeddedSignupConfig } from "@/lib/types";
import { Modal } from "@/components/Modal";
import { IconGlobe } from "@/icons";
import { apiOriginFrom, kindLabel } from "./channelModel";

export const CHANNELS_PATH = "/channels";
export const LIMITS_PATH = "/channels/limits";
export const ES_CONFIG_PATH = "/channels/whatsapp/embedded-signup/config";

/** The backend's public origin, for the widget snippet and the hosted chat link. */
export const API_ORIGIN = apiOriginFrom(API_BASE, typeof window === "undefined" ? "http://localhost" : window.location.origin);

/** The frontend mirror of the backend's origin rule. The server stays authoritative. */
export const ORIGIN_OPTS = { production: import.meta.env.PROD === true };

/** Drop every cached `/channels…` query (list, limits, signup config). */
export function invalidateChannels(qc: QueryClient): void {
  void qc.invalidateQueries({
    predicate: (q) => typeof q.queryKey[0] === "string" && (q.queryKey[0] as string).startsWith(CHANNELS_PATH),
  });
}

/** Channel list, limits and embedded-signup availability, refreshed on `channels.updated`. */
export function useChannelsData(enabled: boolean) {
  const qc = useQueryClient();
  const listQ = useFetch<ChannelDto[]>(enabled ? CHANNELS_PATH : null);
  const limitsQ = useFetch<ChannelLimits>(enabled ? LIMITS_PATH : null);
  const esQ = useFetch<EmbeddedSignupConfig>(enabled ? ES_CONFIG_PATH : null);
  useRealtime("channels.updated", () => invalidateChannels(qc));
  const refresh = useCallback(() => invalidateChannels(qc), [qc]);
  return { listQ, limitsQ, esQ, refresh };
}

/** A hash query param (`#/channels?id=…`), kept in sync with hashchange. */
export function useHashParam(key: string): [string | null, (v: string | null) => void] {
  const [value, setValue] = useState<string | null>(() => getHashParam(window.location.hash, key));
  useEffect(() => {
    const on = () => setValue(getHashParam(window.location.hash, key));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, [key]);
  const set = useCallback(
    (v: string | null) => {
      const next = setHashParam(window.location.hash, key, v);
      if (next !== window.location.hash) window.location.hash = next;
      setValue(v);
    },
    [key],
  );
  return [value, set];
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Copy button that flips to "Copied" for a moment. */
export function CopyButton({ text, tx, primary }: { text: string; tx: Tx; primary?: boolean }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = window.setTimeout(() => setState("idle"), 1800);
    return () => window.clearTimeout(t);
  }, [state]);
  return (
    <button
      type="button"
      className={`btn sm ${primary ? "primary" : ""}`.trim()}
      onClick={async () => setState((await copyText(text)) ? "ok" : "fail")}
      aria-live="polite"
    >
      {state === "ok" ? tx("Copied", "تم النسخ") : state === "fail" ? tx("Copy failed", "تعذّر النسخ") : tx("Copy", "نسخ")}
    </button>
  );
}

export function KindMark({ kind, size = 32 }: { kind: string; size?: number }) {
  const k = kindLabel(kind);
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: 8,
        background: k.color,
        display: "grid",
        placeItems: "center",
        color: "#fff",
        flexShrink: 0,
      }}
    >
      <IconGlobe w={Math.round(size / 2)} />
    </span>
  );
}

type Tone = "warn" | "bad" | "info" | "ok";
const TONE: Record<Tone, string> = { warn: "var(--warn)", bad: "var(--bad)", info: "var(--info)", ok: "var(--ok)" };

export function Banner({ tone, title, children, action }: { tone: Tone; title?: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div
      role={tone === "bad" || tone === "warn" ? "alert" : "status"}
      style={{
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        padding: "10px 12px",
        borderRadius: 10,
        border: `1px solid color-mix(in oklch, ${TONE[tone]} 40%, transparent)`,
        background: `color-mix(in oklch, ${TONE[tone]} 10%, transparent)`,
        fontSize: 12.5,
        lineHeight: 1.5,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        {title && <div style={{ fontWeight: 600, color: TONE[tone], marginBlockEnd: children ? 2 : 0 }}>{title}</div>}
        {children}
      </div>
      {action}
    </div>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div role="alert" style={{ color: "var(--bad)", fontSize: 12, lineHeight: 1.45 }}>
      {children}
    </div>
  );
}

export const fieldInput: CSSProperties = {
  width: "100%",
  height: 36,
  padding: "0 10px",
  background: "var(--bg-2)",
  border: "1px solid var(--line)",
  borderRadius: 8,
  color: "var(--ink)",
  fontSize: 13,
  outline: "none",
};

export const fieldLabel: CSSProperties = {
  fontSize: 11,
  color: "var(--ink-3)",
  textTransform: "uppercase",
  letterSpacing: 0.06,
  fontFamily: "var(--font-mono)",
};

export function LabeledField({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label style={{ display: "grid", gap: 5 }}>
      <span style={fieldLabel}>{label}</span>
      {children}
      {hint && !error && <span className="muted" style={{ fontSize: 11.5, lineHeight: 1.45 }}>{hint}</span>}
      {error && <span role="alert" style={{ fontSize: 11.5, color: "var(--bad)" }}>{error}</span>}
    </label>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  busy,
  error,
  danger,
  tx,
  onConfirm,
  onClose,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  error?: ReactNode;
  danger?: boolean;
  tx: Tx;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal onClose={onClose} label={title} width={420} zIndex={130}>
      <div style={{ display: "grid", gap: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55 }}>{body}</div>
        <ErrorText>{error}</ErrorText>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            {tx("Cancel", "إلغاء")}
          </button>
          <button
            type="button"
            className={`btn ${danger ? "danger" : "primary"}`}
            onClick={onConfirm}
            disabled={busy}
            autoFocus
          >
            {busy ? tx("Working…", "جارٍ التنفيذ…") : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
