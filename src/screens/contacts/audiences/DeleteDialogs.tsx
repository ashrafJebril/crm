import { useState } from "react";
import { api } from "@/api/client";
import { Modal } from "@/components/Modal";
import { useToast } from "@/components/Toast";
import { NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";
import { IconTrash } from "@/icons";
import type { Tx } from "@/lib/tx";
import type { AudienceRefAudience, AudienceRefCampaign, Campaign, Lang } from "@/lib/types";
import { campaignStatusLabel } from "../../campaigns/campaignDetailModel";
import { audienceHash } from "../contactsTab";
import {
  audienceDeleteStateFromError,
  audienceErrorText,
  isForbidden,
  tagDeleteStateFromError,
  type AudienceDeleteState,
  type TagDeleteState,
} from "./audienceErrors";
import { DANGER_BTN, segName } from "./ui";

function AudienceLinks({ tx, lang, audiences }: { tx: Tx; lang: Lang; audiences: AudienceRefAudience[] }) {
  if (!audiences.length) return null;
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <strong style={{ fontSize: 12 }}>{tx("Smart audiences that use it", "الجماهير الذكية التي تستخدمه")}</strong>
      <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 13 }}>
        {audiences.map((a) => (
          <li key={a.id}>
            <a href={audienceHash(a.id)}><bdi dir="auto">{segName(a, lang)}</bdi></a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CampaignLinks({ tx, campaigns, title }: { tx: Tx; campaigns: AudienceRefCampaign[]; title: string }) {
  if (!campaigns.length) return null;
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <strong style={{ fontSize: 12 }}>{title}</strong>
      <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 13 }}>
        {campaigns.map((c) => (
          <li key={c.id}>
            <a href={`#/campaigns?id=${encodeURIComponent(c.id)}`}><bdi dir="auto">{c.name}</bdi></a>
            <span className="muted"> · {campaignStatusLabel(c.status as Campaign["status"], tx)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Delete an audience or group (ruling 7). `in_use` lists what uses it and
 * "Delete anyway" sends `?confirm=1`; `blocked` (a scheduled or sending
 * campaign) offers no override. A 409 from the server replaces the state.
 */
export function AudienceDeleteDialog({ tx, lang, audience, initial, onClose, onDeleted }: {
  tx: Tx;
  lang: Lang;
  audience: { id: string; name: string; nameAr: string | null; origin: string };
  initial: AudienceDeleteState;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { toast } = useToast();
  const [state, setState] = useState<AudienceDeleteState>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = segName(audience, lang);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.delete(`/segments/${audience.id}${state.kind === "in_use" ? "?confirm=1" : ""}`);
      onDeleted();
    } catch (e) {
      const next = audienceDeleteStateFromError(e);
      if (next) setState(next);
      else if (isForbidden(e)) toast(tx(NO_PERMISSION_EN, NO_PERMISSION_AR), "error");
      else setError(audienceErrorText(e, tx));
    } finally {
      setBusy(false);
    }
  };

  const heading =
    state.kind === "blocked"
      ? tx("This audience can't be deleted now", "لا يمكن حذف هذا الجمهور الآن")
      : state.kind === "in_use"
        ? tx("This audience is in use", "هذا الجمهور مستخدم")
        : tx("Delete this audience?", "حذف هذا الجمهور؟");

  return (
    <Modal onClose={busy ? () => {} : onClose} width={460} label={heading}>
      <div dir={lang === "ar" ? "rtl" : "ltr"} style={{ display: "grid", gap: 12 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>{heading}</h3>
        {state.kind === "confirm" && (
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
            <bdi dir="auto" style={{ fontWeight: 600 }}>{name}</bdi>{" "}
            {audience.origin === "manual"
              ? tx("will be deleted. Its members stay in your contacts. This cannot be undone.", "سيُحذف. يبقى أعضاؤه في جهات اتصالك. لا يمكن التراجع.")
              : tx("will be deleted. This cannot be undone.", "سيُحذف. لا يمكن التراجع.")}
          </p>
        )}
        {state.kind === "in_use" && (
          <>
            <AudienceLinks tx={tx} lang={lang} audiences={state.audiences} />
            <CampaignLinks tx={tx} campaigns={state.campaigns} title={tx("Campaigns that use it", "الحملات التي تستخدمه")} />
            <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: "var(--warn)" }}>
              {tx(
                "If you delete it, the rules that use it will match nobody until you change them, and campaigns that use it can't be sent until you choose another audience.",
                "إذا حذفته، فلن تطابق الشروط التي تستخدمه أحدًا حتى تعدّلها، ولن تُرسل الحملات التي تستخدمه حتى تختار جمهورًا آخر.",
              )}
            </p>
          </>
        )}
        {state.kind === "blocked" && (
          <>
            <CampaignLinks tx={tx} campaigns={state.campaigns} title={tx("Scheduled or sending campaigns", "حملات مجدولة أو قيد الإرسال")} />
            <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5 }}>
              {tx(
                "Cancel these campaigns or wait until they finish, then try again.",
                "ألغِ هذه الحملات أو انتظر حتى تنتهي، ثم حاول مجددًا.",
              )}
            </p>
          </>
        )}
        {error && <div role="alert" style={{ fontSize: 12, color: "var(--bad)" }}>{error}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            {state.kind === "blocked" ? tx("Close", "إغلاق") : tx("Cancel", "إلغاء")}
          </button>
          {state.kind !== "blocked" && (
            <button type="button" className="btn" style={DANGER_BTN} disabled={busy} onClick={() => void run()}>
              <IconTrash w={13} />{" "}
              {busy ? tx("Deleting…", "جارٍ الحذف…") : state.kind === "in_use" ? tx("Delete anyway", "احذفه رغم ذلك") : tx("Delete", "حذف")}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/**
 * Delete a tag (Review Focus 2). With references, it lists the audiences and
 * "Delete anyway" sends `?confirm=1`; a 409 from a race shows the same dialog.
 */
export function TagDeleteDialog({ tx, lang, tag, initial, onClose, onDeleted }: {
  tx: Tx;
  lang: Lang;
  tag: { id: string; name: string; usageCount: number };
  initial: TagDeleteState;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { toast } = useToast();
  const [state, setState] = useState<TagDeleteState>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.delete(`/tags/${tag.id}${state.kind === "in_use" ? "?confirm=1" : ""}`);
      onDeleted();
    } catch (e) {
      const next = tagDeleteStateFromError(e);
      if (next) setState(next);
      else if (isForbidden(e)) toast(tx(NO_PERMISSION_EN, NO_PERMISSION_AR), "error");
      else setError(audienceErrorText(e, tx));
    } finally {
      setBusy(false);
    }
  };

  const heading = state.kind === "in_use" ? tx("Smart audiences use this tag", "تستخدم جماهير ذكية هذا الوسم") : tx("Delete this tag?", "حذف هذا الوسم؟");
  return (
    <Modal onClose={busy ? () => {} : onClose} width={420} label={heading}>
      <div dir={lang === "ar" ? "rtl" : "ltr"} style={{ display: "grid", gap: 12 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>{heading}</h3>
        <p style={{ margin: 0, fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>
          <bdi dir="auto" style={{ fontWeight: 600 }}>{tag.name}</bdi>{" "}
          {tx(
            `will be removed from ${tag.usageCount.toLocaleString("en-US")} contact(s). This cannot be undone.`,
            `سيُزال من ${tag.usageCount.toLocaleString("en-US")} جهة اتصال. لا يمكن التراجع.`,
          )}
        </p>
        {state.kind === "in_use" && (
          <>
            <AudienceLinks tx={tx} lang={lang} audiences={state.audiences} />
            <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: "var(--warn)" }}>
              {tx(
                "Rules that use this tag will match nobody until you change them",
                "الشروط التي تستخدم هذا الوسم لن تطابق أحدًا حتى تعدّلها",
              )}
            </p>
          </>
        )}
        {error && <div role="alert" style={{ fontSize: 12, color: "var(--bad)" }}>{error}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>{tx("Cancel", "إلغاء")}</button>
          <button type="button" className="btn" style={DANGER_BTN} disabled={busy} onClick={() => void run()}>
            <IconTrash w={13} />{" "}
            {busy ? tx("Deleting…", "جارٍ الحذف…") : state.kind === "in_use" ? tx("Delete anyway", "احذفه رغم ذلك") : tx("Delete", "حذف")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
