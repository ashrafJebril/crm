import { useState } from "react";
import type { Tx } from "@/lib/tx";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import { SettingsCard, ErrorRow, StatusToast } from "./form";
import { Badge } from "@/components/Badge";
import { Modal } from "@/components/Modal";
import { IconGlobe } from "@/icons";

interface McpTokenStatus {
  connected: boolean;
  prefix?: string;
  createdAt?: string;
}

interface McpTokenGenerated {
  token: string;
  endpointUrl: string;
}

export function McpAccessCard({ tx, canEdit }: { tx: Tx; canEdit: boolean }) {
  const statusQ = useFetch<McpTokenStatus>("/integrations/mcp/token/status");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [generated, setGenerated] = useState<McpTokenGenerated | null>(null);

  const generateMut = useMutation<Record<string, never>, McpTokenGenerated>(() =>
    api.post("/integrations/mcp/token"),
  );
  const revokeMut = useMutation<Record<string, never>, { ok: true }>(() =>
    api.delete("/integrations/mcp/token"),
  );

  const connected = statusQ.data?.connected === true;

  async function onGenerate() {
    setError(null);
    try {
      const result = await generateMut.mutate({});
      setGenerated(result);
      statusQ.refetch();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onRevoke() {
    if (
      !window.confirm(
        tx(
          "Revoke this MCP access token? Kewy AI will lose access to appointments and contacts immediately.",
          "إلغاء رمز وصول MCP هذا؟ سيفقد Kewy AI الوصول إلى المواعيد وجهات الاتصال فورًا.",
        ),
      )
    ) {
      return;
    }
    setError(null);
    try {
      await revokeMut.mutate({});
      statusQ.refetch();
      setStatus(tx("MCP token revoked.", "تم إلغاء رمز MCP."));
      window.setTimeout(() => setStatus(null), 2400);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <SettingsCard
        title={tx("Kewy AI: MCP access", "Kewy AI: وصول MCP")}
        description={tx(
          "Lets Kewy AI read and manage this workspace's appointments and contacts as tools.",
          "يتيح لـ Kewy AI قراءة وإدارة مواعيد وجهات اتصال مساحة العمل هذه كأدوات.",
        )}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 12px",
            background: "var(--bg-2)",
            borderRadius: 10,
          }}
        >
          <span
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: "var(--bg-1)",
              display: "grid",
              placeItems: "center",
              color: "var(--ink-3)",
            }}
          >
            <IconGlobe w={16} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 500, fontSize: 13 }}>{tx("Access token", "رمز الوصول")}</div>
            <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
              {connected
                ? `mcp_${statusQ.data?.prefix}_•••• · ${tx("created", "أُنشئ")} ${statusQ.data?.createdAt?.slice(0, 10) ?? ""}`
                : tx("No token generated", "لم يتم إنشاء رمز بعد")}
            </div>
          </div>
          {connected ? (
            <Badge kind="ok" dot>
              {tx("Connected", "متصل")}
            </Badge>
          ) : (
            <Badge kind="">{tx("Off", "غير مفعل")}</Badge>
          )}
        </div>

        {canEdit ? (
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn primary" onClick={onGenerate}>
              {connected ? tx("Rotate token", "تدوير الرمز") : tx("Generate token", "إنشاء رمز")}
            </button>
            {connected && (
              <button type="button" className="btn ghost" onClick={onRevoke}>
                {tx("Revoke", "إلغاء")}
              </button>
            )}
          </div>
        ) : (
          <div className="muted" style={{ fontSize: 12 }}>
            {tx("Only an owner or admin can manage this token.", "يمكن للمالك أو المسؤول فقط إدارة هذا الرمز.")}
          </div>
        )}

        <div className="muted" style={{ fontSize: 12 }}>
          {tx(
            "After generating a token, add this endpoint as a remote MCP server from the Kewy AI screen's MCP Servers tab, using the token as an Authorization: Bearer header.",
            "بعد إنشاء الرمز، أضف هذا الرابط كخادم MCP عن بُعد من تبويب خوادم MCP في شاشة Kewy AI، باستخدام الرمز كترويسة Authorization: Bearer.",
          )}
        </div>

        <ErrorRow message={statusQ.error} />
        <ErrorRow message={error} />
      </SettingsCard>

      {generated && (
        <Modal onClose={() => setGenerated(null)} label={tx("MCP access token", "رمز وصول MCP")}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="muted" style={{ fontSize: 12 }}>
              {tx("This token won't be shown again. Copy it now.", "لن يظهر هذا الرمز مرة أخرى. انسخه الآن.")}
            </div>
            <div
              className="mono"
              style={{ padding: 10, background: "var(--bg-2)", borderRadius: 8, fontSize: 12, wordBreak: "break-all" }}
            >
              {generated.token}
            </div>
            <div className="muted" style={{ fontSize: 11 }}>
              {tx("Endpoint URL", "رابط النقطة النهائية")}
            </div>
            <div
              className="mono"
              style={{ padding: 10, background: "var(--bg-2)", borderRadius: 8, fontSize: 12, wordBreak: "break-all" }}
            >
              {generated.endpointUrl}
            </div>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                void navigator.clipboard.writeText(generated.token);
                setStatus(tx("Copied to clipboard.", "تم النسخ."));
                window.setTimeout(() => setStatus(null), 2000);
              }}
            >
              {tx("Copy token", "نسخ الرمز")}
            </button>
            <button type="button" className="btn ghost" onClick={() => setGenerated(null)}>
              {tx("Done", "تم")}
            </button>
          </div>
        </Modal>
      )}

      <StatusToast message={status} />
    </>
  );
}
