import { useState } from "react";
import { api } from "@/api/client";
import { useAuth } from "@/auth/context";
import { useFetch } from "@/api/useFetch";
import { Badge } from "@/components/Badge";
import { Modal } from "@/components/Modal";
import type { ApiKey } from "@/lib/types";
import type { Tx } from "@/lib/tx";
import { ErrorRow, Field, SettingsCard, StatusToast, inputStyle } from "../form";
import {
  KEY_ACTIONS,
  KEY_RESOURCES,
  actionLabel,
  emptyMatrix,
  expiryInstant,
  keyStatus,
  keyStatusLabel,
  matrixToScopes,
  resourceLabel,
  scopeSummary,
  shortDate,
  toggleRow,
  toggleScope,
  type ScopeMatrix,
} from "./apiModel";
import { developerErrorText } from "./developerErrors";
import { ShownOnce } from "./ShownOnce";
import { SHOWN_ONCE_CLOSE_CONFIRM, guardedClose, modalDismissible } from "./shownOnceGuard";

const MONO = { fontFamily: "var(--mono)", fontSize: 12 } as const;

/**
 * SP-27 API keys: list (prefix, scopes, creator, last used, status), create
 * with a scope matrix and optional expiry (the key is shown once), revoke
 * with a confirm. Create is hidden without api_keys.create and while
 * impersonating (the server refuses it too); revoke needs api_keys.delete.
 */
export function ApiKeysSection({
  tx,
  lang,
  canCreate,
  canDelete,
}: {
  tx: Tx;
  lang: "en" | "ar";
  canCreate: boolean;
  canDelete: boolean;
}) {
  const q = useFetch<{ items: ApiKey[] }>("/api-keys");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const flash = (m: string) => {
    setToast(m);
    window.setTimeout(() => setToast(null), 2400);
  };

  const revoke = async (k: ApiKey) => {
    if (
      !window.confirm(
        tx(
          `Revoke "${k.name}"? Anything using it stops working at once.`,
          `إلغاء "${k.name}"؟ سيتوقف كل ما يستخدمه عن العمل فورًا.`,
        ),
      )
    ) {
      return;
    }
    setError(null);
    try {
      await api.delete(`/api-keys/${encodeURIComponent(k.id)}`);
      await q.refetch();
      flash(tx("Key revoked.", "تم إلغاء المفتاح."));
    } catch (e) {
      setError(developerErrorText(e, tx));
    }
  };

  const items = q.data?.items ?? [];

  return (
    <>
      <SettingsCard
        title={tx("API keys", "مفاتيح API")}
        description={tx(
          "Keys let your own tools call the CRM API. Each key acts as the person who created it, limited to the permissions you choose, and stops working if that person leaves.",
          "تتيح المفاتيح لأدواتك استدعاء واجهة CRM البرمجية. يعمل كل مفتاح باسم من أنشأه، ضمن الصلاحيات التي تختارها، ويتوقف إذا غادر ذلك الشخص.",
        )}
        footer={
          canCreate ? (
            <button type="button" className="btn primary" onClick={() => setCreating(true)}>
              {tx("Create key", "إنشاء مفتاح")}
            </button>
          ) : undefined
        }
      >
        <div role="note" style={{ fontSize: 12.5, padding: 10, borderRadius: 8, background: "var(--bg-2)" }}>
          {tx(
            "Keys keep working after a password change. Revoke keys you no longer trust.",
            "تظل المفاتيح تعمل بعد تغيير كلمة المرور. ألغِ المفاتيح التي لم تعد تثق بها.",
          )}
        </div>

        {q.loading && !q.data ? (
          <div className="muted" style={{ fontSize: 12 }}>
            {tx("Loading…", "جارٍ التحميل…")}
          </div>
        ) : items.length === 0 ? (
          <div className="muted" style={{ fontSize: 12.5 }}>
            {tx("No API keys yet.", "لا توجد مفاتيح API بعد.")}
          </div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {items.map((k) => {
              const status = keyStatus(k);
              return (
                <div
                  key={k.id}
                  style={{ display: "grid", gap: 4, padding: "10px 12px", border: "1px solid var(--line-soft)", borderRadius: 10 }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span dir="auto" style={{ fontWeight: 600, fontSize: 13 }}>
                      {k.name}
                    </span>
                    <bdi dir="ltr" style={MONO}>
                      {k.prefix}_••••
                    </bdi>
                    <Badge kind={status === "active" ? "ok" : status === "expired" ? "warn" : ""}>{keyStatusLabel(status, tx)}</Badge>
                    <span style={{ flex: 1 }} />
                    {canDelete && status !== "revoked" && (
                      <button type="button" className="btn ghost sm" onClick={() => void revoke(k)}>
                        {tx("Revoke", "إلغاء")}
                      </button>
                    )}
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--ink-2)" }}>{scopeSummary(k.scopes, tx).join(" · ")}</div>
                  <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                    {tx(`Created by ${k.createdBy?.name ?? "—"}`, `أنشأه ${k.createdBy?.name ?? "—"}`)} ·{" "}
                    {tx("Last used", "آخر استخدام")}: {k.lastUsedAt ? shortDate(k.lastUsedAt, lang) : tx("never", "لم يُستخدم")} ·{" "}
                    {tx("Expires", "ينتهي")}: {k.expiresAt ? shortDate(k.expiresAt, lang) : tx("never", "لا ينتهي")}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <ErrorRow message={q.error ?? error} />
      </SettingsCard>

      {creating && (
        <CreateApiKeyDialog
          tx={tx}
          lang={lang}
          onClose={() => setCreating(false)}
          onCreated={() => void q.refetch()}
        />
      )}
      <StatusToast message={toast} />
    </>
  );
}

function CreateApiKeyDialog({
  tx,
  lang,
  onClose,
  onCreated,
}: {
  tx: Tx;
  lang: "en" | "ar";
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [matrix, setMatrix] = useState<ScopeMatrix>(emptyMatrix);
  const [expiry, setExpiry] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { activeWorkspace } = useAuth();
  // Review M1: an uncopied key survives Escape and backdrop clicks; Done asks first.
  const guard = { secretShown: created !== null, copied };
  const close = () => guardedClose(guard, onClose, (m) => window.confirm(m), tx(...SHOWN_ONCE_CLOSE_CONFIRM));
  const scopes = matrixToScopes(matrix);
  const valid = name.trim().length > 0 && name.trim().length <= 60 && Object.keys(scopes).length > 0;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { name: name.trim(), scopes };
      // End of the chosen day in the workspace timezone (review M3).
      if (expiry) body.expiresAt = expiryInstant(expiry, activeWorkspace?.timezone);
      const res = await api.post<ApiKey & { key: string }>("/api-keys", body);
      setCreated(res.key);
      onCreated();
    } catch (e) {
      setError(developerErrorText(e, tx));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={close} dismissible={modalDismissible(guard)} width={620} label={tx("Create API key", "إنشاء مفتاح API")}>
      <div dir={lang === "ar" ? "rtl" : "ltr"} style={{ display: "grid", gap: 14 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{tx("Create API key", "إنشاء مفتاح API")}</div>
        {created ? (
          <>
            <ShownOnce value={created} tx={tx} label={tx("API key", "مفتاح API")} onCopied={() => setCopied(true)} />
            <div className="muted" style={{ fontSize: 12 }}>
              {tx("Send it as", "أرسله بالشكل")}{" "}
              <bdi dir="ltr" style={MONO}>
                Authorization: Bearer crm_…
              </bdi>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="button" className="btn primary" onClick={close}>
                {tx("Done", "تم")}
              </button>
            </div>
          </>
        ) : (
          <>
            <Field label={tx("Name", "الاسم")}>
              <input dir="auto" style={inputStyle} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <div role="group" aria-label={tx("Permissions", "الصلاحيات")} style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "start", padding: 6 }}>{tx("Resource", "المورد")}</th>
                    {KEY_ACTIONS.map((a) => (
                      <th key={a} style={{ padding: 6 }}>
                        {actionLabel(a, tx)}
                      </th>
                    ))}
                    <th style={{ padding: 6 }} />
                  </tr>
                </thead>
                <tbody>
                  {KEY_RESOURCES.map((r) => (
                    <tr key={r} style={{ borderTop: "1px solid var(--line-soft)" }}>
                      <td style={{ padding: 6 }}>{resourceLabel(r, tx)}</td>
                      {KEY_ACTIONS.map((a) => (
                        <td key={a} style={{ padding: 6, textAlign: "center" }}>
                          <input
                            type="checkbox"
                            aria-label={`${resourceLabel(r, tx)}: ${actionLabel(a, tx)}`}
                            checked={matrix[r][a]}
                            onChange={(e) => setMatrix((m) => ({ ...m, [r]: toggleScope(m[r], a, e.target.checked) }))}
                          />
                        </td>
                      ))}
                      <td style={{ padding: 6 }}>
                        <button type="button" className="btn ghost sm" onClick={() => setMatrix((m) => ({ ...m, [r]: toggleRow(m[r]) }))}>
                          {KEY_ACTIONS.every((a) => matrix[r][a]) ? tx("None", "لا شيء") : tx("All", "الكل")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
                {tx(
                  "Write includes Read. Admin includes everything. A key never gets more access than you have.",
                  "الكتابة تشمل القراءة. الإدارة الكاملة تشمل كل شيء. لا يحصل المفتاح أبدًا على صلاحيات أكثر من صلاحياتك.",
                )}
              </div>
            </div>
            <Field label={tx("Expires (optional)", "تاريخ الانتهاء (اختياري)")} hint={tx("Up to 2 years from today.", "حتى سنتين من اليوم.")}>
              <input type="date" dir="ltr" style={{ ...inputStyle, maxWidth: 220 }} value={expiry} onChange={(e) => setExpiry(e.target.value)} />
            </Field>
            <ErrorRow message={error} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" className="btn ghost" onClick={onClose}>
                {tx("Cancel", "إلغاء")}
              </button>
              <button type="button" className="btn primary" disabled={!valid || busy} onClick={() => void submit()}>
                {tx("Create key", "إنشاء مفتاح")}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
