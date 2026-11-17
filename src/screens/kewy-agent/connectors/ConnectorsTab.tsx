import { useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import { usePermissions } from "@/auth/usePermissions";
import { Badge } from "@/components/Badge";
import { Modal } from "@/components/Modal";
import { useToast } from "@/components/Toast";
import type { ConnectorCard, ConnectorDetail as Detail, ConnectorSummary } from "@/lib/types";
import type { Tx } from "@/lib/tx";
import {
  CONNECTORS_TAB_HREF,
  PROVIDER_MARK,
  acceptOAuthMessage,
  attentionLines,
  backendOrigin,
  cardKind,
  cardKindText,
  num,
  oauthReasonText,
  oauthResultFromHash,
  statusText,
  type OAuthResult,
} from "./connectorModel";
import { connectorErrorText } from "./connectorErrors";
import { ConnectorDetail } from "./ConnectorDetail";

const MONO = { fontFamily: "var(--mono)", fontSize: 12 } as const;

function hashParam(name: string): string | null {
  return new URLSearchParams(window.location.hash.split("?")[1] ?? "").get(name);
}

/** Drops the OAuth/deep-link params from the hash, keeping the tab. */
function clearHashParams(keys: string[]) {
  const [route, query] = window.location.hash.split("?");
  const params = new URLSearchParams(query ?? "");
  for (const k of keys) params.delete(k);
  const next = params.toString() ? `${route}?${params}` : route;
  if (window.location.hash !== next) window.history.replaceState(null, "", next || "#");
}

/**
 * SP-23 Connectors tab (connectors.view): the gallery of curated providers
 * and custom connectors, the needs-reconnect banner, OAuth connect in a
 * popup (messages accepted only from the backend origin; a blocked popup
 * offers a full-page redirect), "Add custom connector" (connectors.manage),
 * the detail sheet (`#/agent?tab=connectors&connector=<id>`), and the legacy
 * direct MCP servers under Advanced (ruling 9).
 */
export function ConnectorsTab({ tx, lang, advanced }: { tx: Tx; lang: "en" | "ar"; advanced?: React.ReactNode }) {
  const { can } = usePermissions();
  const { toast } = useToast();
  const q = useFetch<{ cards: ConnectorCard[]; attention: ConnectorSummary[] }>("/connectors");
  const [open, setOpen] = useState<string | null>(() => hashParam("connector"));
  const [blocked, setBlocked] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const origin = useRef(backendOrigin());

  const report = (r: OAuthResult) => {
    toast(r.connected ? tx("Connected.", "تم الربط.") : oauthReasonText(r.reason, tx), r.connected ? "success" : "error");
    void q.refetch();
    if (r.connected && r.connectorId) setOpen(r.connectorId);
  };

  // The popup's result (backend origin and exact shape only).
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const r = acceptOAuthMessage({ origin: ev.origin, data: ev.data }, origin.current);
      if (r) report(r);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The full-page fallback lands back here with connected=…&reason=….
  useEffect(() => {
    const r = oauthResultFromHash(window.location.hash);
    if (r) {
      report(r);
      clearHashParams(["connected", "reason"]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = async (provider: string) => {
    setBlocked(null);
    // Opened synchronously (inside the click) so popup blockers allow it.
    const popup = window.open("", "kewy-connector-oauth", "width=560,height=720");
    try {
      const { authorizeUrl } = await api.get<{ authorizeUrl: string }>(`/connectors/oauth/start?provider=${encodeURIComponent(provider)}`);
      const safe = /^https:\/\//.test(authorizeUrl) || /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(authorizeUrl);
      if (!safe) throw new Error("bad authorize url");
      if (popup && !popup.closed) popup.location.href = authorizeUrl;
      else setBlocked(authorizeUrl);
    } catch (e) {
      popup?.close();
      toast(connectorErrorText(e, tx), "error");
    }
  };

  const closeDetail = () => {
    setOpen(null);
    clearHashParams(["connector"]);
  };

  const cards = q.data?.cards ?? [];
  const attention = attentionLines(q.data?.attention ?? [], tx);

  return (
    <div style={{ display: "grid", gap: 14, alignContent: "start" }}>
      <div style={{ fontSize: 12.5, color: "var(--ink-2)", maxWidth: 680 }}>
        {tx(
          "Connect the apps your agent can use. You choose which tools it may use, and whether it may change anything.",
          "اربط التطبيقات التي يستطيع وكيلك استخدامها. أنت تختار الأدوات التي يستخدمها، وما إذا كان يستطيع تعديل أي شيء.",
        )}
      </div>

      {attention.map((a) => (
        <div key={a.id} role="alert" style={{ display: "flex", alignItems: "center", gap: 8, padding: 10, borderRadius: 10, border: "1px solid var(--bad)", fontSize: 12.5 }}>
          <span style={{ flex: 1 }}>{a.text}</span>
          {can("connectors.create") && a.provider !== "custom" && (
            <button type="button" className="btn sm primary" onClick={() => void connect(a.provider)}>
              {tx("Reconnect", "إعادة الربط")}
            </button>
          )}
          <button type="button" className="btn sm ghost" onClick={() => setOpen(a.id)}>
            {tx("Details", "التفاصيل")}
          </button>
        </div>
      ))}

      {blocked && (
        <div role="status" style={{ fontSize: 12.5, padding: 10, borderRadius: 10, background: "var(--bg-2)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ flex: 1 }}>{tx("Your browser blocked the sign-in window.", "منع متصفحك نافذة تسجيل الدخول.")}</span>
          <button type="button" className="btn sm primary" onClick={() => window.location.assign(blocked)}>
            {tx("Continue in this tab", "المتابعة في هذا التبويب")}
          </button>
        </div>
      )}

      {q.error && <div role="alert" style={{ fontSize: 12.5, color: "var(--bad)" }}>{q.error}</div>}

      {q.loading && !q.data ? (
        <div className="muted" style={{ fontSize: 12 }}>
          {tx("Loading…", "جارٍ التحميل…")}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
          {cards.map((c) => {
            const kind = cardKind(c);
            const mark = PROVIDER_MARK[c.provider] ?? { mark: "?", hue: 0 };
            const curatedRow = c.provider !== "custom" ? c.connectors[0] : undefined;
            const unavailable = cardKindText(kind, tx);
            return (
              <div key={c.provider} className="card" style={{ padding: 14, display: "grid", gap: 8, alignContent: "start", opacity: kind === "coming_soon" ? 0.7 : 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    aria-hidden="true"
                    style={{ width: 30, height: 30, borderRadius: 8, display: "grid", placeItems: "center", fontWeight: 700, fontSize: 12, background: `oklch(0.9 0.05 ${mark.hue})`, color: `oklch(0.35 0.12 ${mark.hue})` }}
                  >
                    {mark.mark}
                  </span>
                  <div style={{ fontSize: 13.5, fontWeight: 600, flex: 1 }}>{tx(c.name.en, c.name.ar)}</div>
                  {unavailable && <Badge kind="">{unavailable}</Badge>}
                  {curatedRow && <Badge kind={statusText(curatedRow.status, tx).tone}>{statusText(curatedRow.status, tx).text}</Badge>}
                </div>
                <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>{tx(c.description.en, c.description.ar)}</div>

                {c.provider === "custom"
                  ? c.connectors.map((s) => (
                      <button key={s.id} type="button" className="btn sm ghost" style={{ justifyContent: "space-between", display: "flex", gap: 6 }} onClick={() => setOpen(s.id)}>
                        <span dir="auto">{s.name}</span>
                        <Badge kind={statusText(s.status, tx).tone}>{statusText(s.status, tx).text}</Badge>
                      </button>
                    ))
                  : curatedRow && (
                      <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                        {curatedRow.accountLabel && <bdi dir="auto">{curatedRow.accountLabel} · </bdi>}
                        {tx(`${num(curatedRow.toolCounts.on)} of ${num(curatedRow.toolCounts.total)} tools on`, `${num(curatedRow.toolCounts.on)} من ${num(curatedRow.toolCounts.total)} أدوات مفعّلة`)}
                        {" · "}
                        {tx(`${num(curatedRow.calls7d)} calls in 7 days`, `${num(curatedRow.calls7d)} استدعاء خلال 7 أيام`)}
                      </div>
                    )}

                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {kind === "available" && c.provider !== "custom" && can("connectors.create") && (!curatedRow || curatedRow.status !== "active") && (
                    <button type="button" className="btn sm primary" onClick={() => void connect(c.provider)}>
                      {curatedRow?.status === "needs_reconnect" ? tx("Reconnect", "إعادة الربط") : tx("Connect", "ربط")}
                    </button>
                  )}
                  {curatedRow && (
                    <button type="button" className="btn sm ghost" onClick={() => setOpen(curatedRow.id)}>
                      {tx("Tools and activity", "الأدوات والنشاط")}
                    </button>
                  )}
                  {c.provider === "custom" && kind === "available" && can("connectors.manage") && (
                    <button type="button" className="btn sm primary" onClick={() => setAdding(true)}>
                      {tx("Add custom connector", "إضافة موصل مخصص")}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {advanced && (
        <div style={{ marginTop: 8 }}>
          <button type="button" className="btn sm ghost" aria-expanded={showAdvanced} onClick={() => setShowAdvanced((v) => !v)}>
            {showAdvanced ? "▾" : "▸"} {tx("Advanced", "متقدم")}
          </button>
          {showAdvanced && (
            <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{tx("Direct MCP servers (legacy)", "خوادم MCP المباشرة (قديمة)")}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                {tx(
                  "These servers talk to the agent directly: they bypass tool switches and recent activity. Prefer connectors.",
                  "تتواصل هذه الخوادم مع الوكيل مباشرة: فهي تتجاوز مفاتيح الأدوات والنشاط الأخير. يُفضّل استخدام الموصلات.",
                )}
              </div>
              {advanced}
            </div>
          )}
        </div>
      )}

      {open && (
        <ConnectorDetail
          id={open}
          tx={tx}
          lang={lang}
          onClose={closeDetail}
          onChanged={() => void q.refetch()}
          onReconnect={(p) => void connect(p)}
        />
      )}
      {adding && (
        <CustomConnectorDialog
          tx={tx}
          lang={lang}
          onClose={() => setAdding(false)}
          onCreated={(d) => {
            setAdding(false);
            void q.refetch();
            setOpen(d.id);
          }}
        />
      )}
    </div>
  );
}

export { CONNECTORS_TAB_HREF };

function CustomConnectorDialog({
  tx,
  lang,
  onClose,
  onCreated,
}: {
  tx: Tx;
  lang: "en" | "ar";
  onClose: () => void;
  onCreated: (d: Detail) => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState<{ name: string; value: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = name.trim().length > 0 && name.trim().length <= 60 && /^https:\/\//i.test(url.trim()) && headers.every((h) => h.name.trim() && h.value);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const d = await api.post<Detail>("/connectors/custom", {
        name: name.trim(),
        url: url.trim(),
        ...(headers.length ? { headers: headers.map((h) => ({ name: h.name.trim(), value: h.value })) } : {}),
      });
      onCreated(d);
    } catch (e) {
      setError(connectorErrorText(e, tx));
    } finally {
      setBusy(false);
    }
  };

  const input = { width: "100%", height: 36, padding: "0 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg-2)", color: "var(--ink)" } as const;

  return (
    <Modal onClose={onClose} width={560} label={tx("Add custom connector", "إضافة موصل مخصص")}>
      <div dir={lang === "ar" ? "rtl" : "ltr"} style={{ display: "grid", gap: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{tx("Custom connector", "موصل مخصص")}</div>
        <div className="muted" style={{ fontSize: 12 }}>
          {tx(
            "Any HTTPS MCP server. We check it now; every tool starts switched off, and its tools are treated as making changes until you mark them read-only.",
            "أي خادم MCP عبر HTTPS. نفحصه الآن؛ تبدأ كل الأدوات متوقفة، وتُعامل أدواته كأنها تُجري تغييرات حتى تسمها للقراءة فقط.",
          )}
        </div>
        <label style={{ display: "grid", gap: 4, fontSize: 12.5 }}>
          {tx("Name", "الاسم")}
          <input dir="auto" style={input} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 12.5 }}>
          {tx("Server URL", "رابط الخادم")}
          <input dir="ltr" style={{ ...input, ...MONO }} placeholder="https://" maxLength={2048} value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ fontSize: 12.5 }}>{tx("Secret headers (optional)", "ترويسات سرية (اختياري)")}</div>
          {headers.map((h, i) => (
            <div key={i} style={{ display: "flex", gap: 6 }}>
              <input
                dir="ltr"
                aria-label={tx("Header name", "اسم الترويسة")}
                placeholder="Authorization"
                style={{ ...input, ...MONO, flex: 1 }}
                maxLength={100}
                value={h.name}
                onChange={(e) => setHeaders((hs) => hs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              />
              <input
                dir="ltr"
                type="password"
                autoComplete="off"
                aria-label={tx("Header value", "قيمة الترويسة")}
                style={{ ...input, ...MONO, flex: 2 }}
                maxLength={4096}
                value={h.value}
                onChange={(e) => setHeaders((hs) => hs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
              />
              <button type="button" className="btn sm ghost" aria-label={tx("Remove header", "حذف الترويسة")} onClick={() => setHeaders((hs) => hs.filter((_, j) => j !== i))}>
                ×
              </button>
            </div>
          ))}
          {headers.length < 10 && (
            <button type="button" className="btn sm ghost" style={{ justifySelf: "start" }} onClick={() => setHeaders((hs) => [...hs, { name: "", value: "" }])}>
              {tx("Add header", "إضافة ترويسة")}
            </button>
          )}
          <div className="muted" style={{ fontSize: 11.5 }}>
            {tx("Header values are stored encrypted and never shown again.", "تُخزّن قيم الترويسات مشفرة ولا تُعرض مرة أخرى.")}
          </div>
        </div>
        {error && <div role="alert" style={{ fontSize: 12, color: "var(--bad)" }}>{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn ghost" onClick={onClose}>
            {tx("Cancel", "إلغاء")}
          </button>
          <button type="button" className="btn primary" disabled={!valid || busy} onClick={() => void submit()}>
            {busy ? tx("Checking…", "جارٍ الفحص…") : tx("Check and add", "فحص وإضافة")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
