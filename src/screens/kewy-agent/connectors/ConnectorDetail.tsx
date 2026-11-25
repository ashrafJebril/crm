import { useState } from "react";
import { api, ApiError } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import { useAuth } from "@/auth/context";
import { usePermissions } from "@/auth/usePermissions";
import { Badge } from "@/components/Badge";
import { Modal } from "@/components/Modal";
import { useToast } from "@/components/Toast";
import type { ConnectorActivity, ConnectorDetail as Detail, ConnectorRescanResult, ConnectorTool } from "@/lib/types";
import type { Tx } from "@/lib/tx";
import {
  flagText,
  kindBadge,
  num,
  rescanNotice,
  statusText,
  switchReasonText,
  switchState,
  writeWarning,
  type Can,
} from "./connectorModel";
import { connectorErrorKey, connectorErrorText } from "./connectorErrors";

const MONO = { fontFamily: "var(--mono)", fontSize: 12 } as const;

function time(iso: string, lang: "en" | "ar", tz?: string): string {
  try {
    return new Intl.DateTimeFormat(lang === "ar" ? "ar-SA-u-nu-latn-ca-gregory" : "en-GB", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      ...(tz ? { timeZone: tz } : {}),
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/**
 * SP-23 connector detail (dir set): account, server host, status, the agent
 * switch, tool switches (read/write badge, vendor descriptions as text,
 * removed and safety-flag notes, the write-switch confirm), re-scan with its
 * notice, recent activity, the skills that use it, and disconnect.
 */
export function ConnectorDetail({
  id,
  tx,
  lang,
  onClose,
  onChanged,
  onReconnect,
}: {
  id: string;
  tx: Tx;
  lang: "en" | "ar";
  onClose: () => void;
  onChanged: () => void;
  onReconnect: (provider: string) => void;
}) {
  const { can } = usePermissions();
  const { toast } = useToast();
  const { activeWorkspace } = useAuth();
  const q = useFetch<Detail>(`/connectors/${encodeURIComponent(id)}`);
  const act = useFetch<ConnectorActivity>(`/connectors/${encodeURIComponent(id)}/activity`);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string[] | null>(null);
  const [confirmWrite, setConfirmWrite] = useState<ConnectorTool | null>(null);
  const d = q.data;
  const perm = can as Can;

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      await q.refetch();
      onChanged();
      if (done) toast(done, "success");
    } catch (e) {
      toast(connectorErrorText(e, tx), "error");
      if (connectorErrorKey(e) === "connectors.version_conflict" || (e instanceof ApiError && e.status === 409)) await q.refetch();
    } finally {
      setBusy(false);
    }
  };

  const setAccess = (t: ConnectorTool, access: "off" | "read" | "write", kind?: "read" | "write") =>
    run(() => api.patch(`/connectors/${encodeURIComponent(id)}/tools`, { version: d?.version, tools: [{ name: t.name, access, ...(kind ? { kind } : {}) }] }));

  const toggle = (t: ConnectorTool) => {
    if (!d) return;
    const st = switchState(t, perm, d.status);
    if (st.disabled) return;
    if (st.on) return void setAccess(t, "off");
    if (st.needsConfirm) return setConfirmWrite(t);
    void setAccess(t, st.onAccess);
  };

  if (!d) {
    return (
      <Modal onClose={onClose} width={760} label={tx("Connector", "الموصل")}>
        <div className="muted" style={{ fontSize: 12.5 }}>
          {q.error ?? tx("Loading…", "جارٍ التحميل…")}
        </div>
      </Modal>
    );
  }

  const status = statusText(d.status, tx);
  const isCustom = d.provider === "custom";

  return (
    <Modal onClose={onClose} width={780} label={d.name}>
      <div dir={lang === "ar" ? "rtl" : "ltr"} style={{ display: "grid", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <h2 dir="auto" style={{ margin: 0, fontSize: 16, flex: 1 }}>
            {d.name}
          </h2>
          <Badge kind={status.tone}>{status.text}</Badge>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--ink-2)", display: "grid", gap: 2 }}>
          {d.accountLabel && (
            <span>
              {tx("Account", "الحساب")}: <bdi dir="auto">{d.accountLabel}</bdi>
            </span>
          )}
          <span>
            {tx("Server", "الخادم")}: <bdi dir="ltr" style={MONO}>{d.serverHost}</bdi>
          </span>
          {d.headers.length > 0 && (
            <span>
              {tx("Secret headers", "الترويسات السرية")}:{" "}
              {d.headers.map((h) => (
                <bdi key={h.name} dir="ltr" style={{ ...MONO, marginInlineEnd: 8 }}>
                  {h.name}: ••••
                </bdi>
              ))}
            </span>
          )}
        </div>

        {d.status === "needs_reconnect" && (
          <div role="alert" style={{ fontSize: 12.5, padding: 10, borderRadius: 8, border: "1px solid var(--bad)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ flex: 1 }}>
              {tx(
                `${d.name} needs reconnecting. Its tools are hidden from the agent until then; your switches are kept.`,
                `يحتاج ${d.name} إلى إعادة الربط. أدواته مخفية عن الوكيل حتى ذلك الحين، ومفاتيحك محفوظة.`,
              )}
            </span>
            {can("connectors.create") && !isCustom && (
              <button type="button" className="btn sm primary" onClick={() => onReconnect(d.provider)}>
                {tx("Reconnect", "إعادة الربط")}
              </button>
            )}
          </div>
        )}

        {can("connectors.update") && d.status !== "disconnected" && (
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              role="switch"
              checked={d.agentBound}
              disabled={busy}
              onChange={(e) => void run(() => api.put(`/connectors/${encodeURIComponent(id)}/agent`, { bound: e.target.checked }))}
            />
            {tx("Agent can use this", "يستطيع الوكيل استخدامه")}
          </label>
        )}

        <section aria-label={tx("Tools", "الأدوات")} style={{ display: "grid", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>
              {tx("Tools", "الأدوات")}{" "}
              <bdi className="muted" style={{ fontWeight: 400 }}>
                ({num(d.toolCounts.on)}/{num(d.toolCounts.total)})
              </bdi>
            </div>
            {can("connectors.update") && d.status === "active" && (
              <button
                type="button"
                className="btn sm ghost"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const r = await api.post<ConnectorRescanResult>(`/connectors/${encodeURIComponent(id)}/rescan`);
                    setNotice(rescanNotice(r, tx));
                  })
                }
              >
                {tx("Re-scan tools", "إعادة فحص الأدوات")}
              </button>
            )}
          </div>
          {notice && (
            <div role="status" style={{ fontSize: 12, padding: 8, borderRadius: 8, background: "var(--bg-2)", display: "grid", gap: 2 }}>
              {notice.map((l) => (
                <span key={l}>{l}</span>
              ))}
            </div>
          )}
          {d.tools.length === 0 ? (
            <div className="muted" style={{ fontSize: 12.5 }}>
              {tx("No tools found on this server.", "لا توجد أدوات على هذا الخادم.")}
            </div>
          ) : (
            d.tools.map((t) => {
              const st = switchState(t, perm, d.status);
              const badge = kindBadge(t.kind, tx);
              const why = switchReasonText(st.reason, tx);
              const flag = flagText(t.flag, tx);
              const reasonId = `tool-${id}-${t.name}-reason`.replace(/[^A-Za-z0-9_-]/g, "_");
              return (
                <div key={t.name} style={{ display: "grid", gap: 4, padding: "8px 10px", border: "1px solid var(--line-soft)", borderRadius: 8, opacity: t.removed ? 0.6 : 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={t.title ?? t.name}
                      checked={st.on}
                      disabled={st.disabled || busy}
                      aria-describedby={why && !t.removed ? reasonId : undefined}
                      onChange={() => toggle(t)}
                    />
                    <bdi dir="ltr" style={{ ...MONO, fontWeight: 600 }}>
                      {t.name}
                    </bdi>
                    <Badge kind={badge.tone}>{badge.text}</Badge>
                    {t.removed && <Badge kind="">{tx("Removed by the provider", "أزالها المزوّد")}</Badge>}
                    {isCustom && can("connectors.manage") && !t.removed && (
                      <button
                        type="button"
                        className="btn sm ghost"
                        disabled={busy}
                        onClick={() => void setAccess(t, "off", t.kind === "read" ? "write" : "read")}
                        title={tx("Your classification; the server's own hint is not trusted for custom connectors.", "تصنيفك؛ لا يُعتمد تلميح الخادم في الموصلات المخصصة.")}
                      >
                        {t.kind === "read" ? tx("Mark as making changes", "وسمها بأنها تُجري تغييرات") : tx("Mark as read-only", "وسمها للقراءة فقط")}
                      </button>
                    )}
                  </div>
                  {t.description && (
                    <div dir="auto" style={{ fontSize: 12, color: "var(--ink-2)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                      {t.description}
                    </div>
                  )}
                  {flag && (
                    <div role="note" style={{ fontSize: 11.5, color: "var(--warn)" }}>
                      {flag}
                    </div>
                  )}
                  {why && !t.removed && (
                    <div id={reasonId} style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                      {why}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </section>

        {d.usedBySkills.length > 0 && (
          <div style={{ fontSize: 12.5 }}>
            {tx("Used by skills", "تستخدمه المهارات")}: {d.usedBySkills.map((s) => tx(s.name.en, s.name.ar)).join(tx(", ", "، "))}
          </div>
        )}

        <section aria-label={tx("Recent activity", "النشاط الأخير")} style={{ display: "grid", gap: 6 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{tx("Recent activity", "النشاط الأخير")}</div>
          {(act.data?.counts7d ?? []).length > 0 && (
            <div style={{ fontSize: 12, color: "var(--ink-2)" }}>
              {tx("Last 7 days", "آخر 7 أيام")}:{" "}
              {(act.data?.counts7d ?? []).map((c) => (
                <span key={c.tool} style={{ marginInlineEnd: 10 }}>
                  <bdi dir="ltr" style={MONO}>
                    {c.tool}
                  </bdi>{" "}
                  {tx(`${num(c.ok)} ok · ${num(c.error)} failed · ${num(c.refused)} refused`, `${num(c.ok)} ناجحة · ${num(c.error)} فاشلة · ${num(c.refused)} مرفوضة`)}
                </span>
              ))}
            </div>
          )}
          {(act.data?.calls ?? []).length === 0 ? (
            <div className="muted" style={{ fontSize: 12 }}>
              {tx("No calls in the last 30 days.", "لا توجد استدعاءات خلال آخر 30 يومًا.")}
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <tbody>
                {(act.data?.calls ?? []).map((c, i) => (
                  <tr key={`${c.at}-${i}`} style={{ borderTop: "1px solid var(--line-soft)" }}>
                    <td style={{ padding: 4 }}>{time(c.at, lang, activeWorkspace?.timezone)}</td>
                    <td style={{ padding: 4 }}>
                      <bdi dir="ltr" style={MONO}>
                        {c.tool === "__probe" ? tx("account check", "فحص الحساب") : c.tool}
                      </bdi>
                    </td>
                    <td style={{ padding: 4 }}>
                      <Badge kind={c.outcome === "ok" ? "ok" : c.outcome === "error" ? "bad" : "warn"}>
                        {c.outcome === "ok" ? tx("OK", "ناجح") : c.outcome === "error" ? tx("Failed", "فشل") : tx("Refused", "مرفوض")}
                      </Badge>
                    </td>
                    <td style={{ padding: 4, color: "var(--ink-3)" }}>{c.source === "agent" ? tx("Agent", "الوكيل") : c.source === "probe" ? tx("Check", "فحص") : c.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          {can("connectors.delete") && d.status !== "disconnected" ? (
            <button
              type="button"
              className="btn ghost"
              disabled={busy}
              onClick={() => {
                if (
                  !window.confirm(
                    tx(
                      `Disconnect ${d.name}? The agent loses its tools now. Your tool switches are kept for a reconnect.`,
                      `فصل ${d.name}؟ سيفقد الوكيل أدواته الآن. تُحفظ مفاتيح الأدوات لإعادة الربط.`,
                    ),
                  )
                )
                  return;
                void run(() => api.delete(`/connectors/${encodeURIComponent(id)}`), tx("Disconnected.", "تم الفصل.")).then(onClose);
              }}
            >
              {tx("Disconnect", "فصل")}
            </button>
          ) : (
            <span />
          )}
          <button type="button" className="btn primary" onClick={onClose}>
            {tx("Close", "إغلاق")}
          </button>
        </div>
      </div>

      {confirmWrite && (
        <Modal onClose={() => setConfirmWrite(null)} width={460} label={tx("Let the agent make changes?", "السماح للوكيل بإجراء تغييرات؟")} zIndex={120}>
          <div dir={lang === "ar" ? "rtl" : "ltr"} style={{ display: "grid", gap: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{tx("Let the agent make changes?", "السماح للوكيل بإجراء تغييرات؟")}</div>
            <div style={{ fontSize: 12.5 }}>{writeWarning(d.name, tx)}</div>
            <bdi dir="ltr" style={MONO}>
              {confirmWrite.name}
            </bdi>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" className="btn ghost" onClick={() => setConfirmWrite(null)}>
                {tx("Cancel", "إلغاء")}
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  const t = confirmWrite;
                  setConfirmWrite(null);
                  void setAccess(t, "write");
                }}
              >
                {tx("Allow changes", "السماح بالتغييرات")}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </Modal>
  );
}
