import { useState } from "react";
import { api, ApiError } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import { Modal } from "@/components/Modal";
import { useToast } from "@/components/Toast";
import type { Tx } from "@/lib/tx";
import type { FollowUpResult, Lang, Segment, TagRow } from "@/lib/types";
import { campaignErrorText, partialGroup, partialGroupText } from "./campaignErrors";
import {
  GROUP_NAME_MAX,
  defaultGroupName,
  followUpSummary,
  followUpTarget,
  statusLabel,
  type Outcome,
} from "./campaignDetailModel";
import { INPUT_STYLE, fmtNum } from "./ui";

export type FollowUpMode = "create-group" | "add-to-group" | "tag";

interface Props {
  mode: FollowUpMode;
  campaign: { id: string; name: string };
  outcome: Outcome;
  outcomeCount: number;
  ticked: string[];
  /** Add-to-group preselects this group (after a partly finished create-group). */
  initialGroupId?: string;
  tx: Tx;
  lang: Lang;
  onClose: () => void;
  /** A create-group made the group but stopped: switch to add-to-group for it. */
  onContinueInGroup: (groupId: string) => void;
}

/** Create a group, add to a group, or tag — from the current outcome or the ticked rows. */
export function FollowUpDialog({ mode, campaign, outcome, outcomeCount, ticked, initialGroupId, tx, lang, onClose, onContinueInGroup }: Props) {
  const { toast } = useToast();
  const [scope, setScope] = useState<"outcome" | "ticked">(ticked.length ? "ticked" : "outcome");
  const [name, setName] = useState(() => defaultGroupName(campaign.name, outcome, tx));
  const [groupId, setGroupId] = useState(initialGroupId ?? "");
  const [tagId, setTagId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState<{ groupId: string; added: number } | null>(null);

  const groupsQ = useFetch<Segment[]>(mode === "add-to-group" ? "/segments" : null);
  const tagsQ = useFetch<TagRow[]>(mode === "tag" ? "/tags" : null);
  const groups = (groupsQ.data ?? []).filter((s) => s.origin === "manual");
  const tags = tagsQ.data ?? [];

  const title =
    mode === "create-group"
      ? tx("Create a group", "إنشاء مجموعة")
      : mode === "add-to-group"
        ? tx("Add to a group", "إضافة إلى مجموعة")
        : tx("Tag contacts", "وسم جهات الاتصال");

  const target = followUpTarget(scope, outcome, ticked);
  const ready =
    !!target &&
    (mode === "create-group" ? name.trim().length > 0 : mode === "add-to-group" ? !!groupId : !!tagId);

  async function submit() {
    if (!target) return;
    setBusy(true);
    setError(null);
    setPartial(null);
    const body =
      mode === "create-group" ? { ...target, name: name.trim() } : mode === "add-to-group" ? { ...target, groupId } : { ...target, tagId };
    try {
      const r = await api.post<FollowUpResult>(`/campaigns/${encodeURIComponent(campaign.id)}/follow-up/${mode}`, body);
      toast(followUpSummary(r, tx), "success");
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        toast(campaignErrorText(e, tx), "error", e);
        onClose();
        return;
      }
      const p = mode === "create-group" ? partialGroup(e) : null;
      if (p) {
        setPartial(p);
        setError(`${partialGroupText(p, tx)}. ${campaignErrorText(e, tx)}`);
      } else setError(campaignErrorText(e, tx));
    } finally {
      setBusy(false);
    }
  }

  const scopeOptions = [
    {
      id: "outcome" as const,
      label: tx(
        `Current outcome: ${statusLabel(outcome, tx)} (${fmtNum(outcomeCount)})`,
        `النتيجة الحالية: ${statusLabel(outcome, tx)} (${fmtNum(outcomeCount)})`,
      ),
      disabled: outcome === "all",
      hint: outcome === "all" ? tx("Pick an outcome chip first", "اختر نتيجة أولًا") : undefined,
    },
    {
      id: "ticked" as const,
      label: tx(`Ticked rows (${fmtNum(ticked.length)})`, `الصفوف المحددة (${fmtNum(ticked.length)})`),
      disabled: ticked.length === 0,
      hint: undefined,
    },
  ];

  return (
    <Modal onClose={onClose} label={title} width={480}>
      <div dir={lang === "ar" ? "rtl" : "ltr"} style={{ display: "grid", gap: 14 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>{title}</h3>
        <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 8 }}>
          <legend style={{ fontSize: 12, color: "var(--ink-2)", marginBottom: 6 }}>{tx("Who", "مَن")}</legend>
          {scopeOptions.map((o) => (
            <label key={o.id} title={o.hint} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, opacity: o.disabled ? 0.5 : 1 }}>
              <input
                type="radio"
                name="follow-up-scope"
                checked={scope === o.id}
                disabled={o.disabled}
                onChange={() => setScope(o.id)}
                style={{ accentColor: "var(--accent)" }}
              />
              {o.label}
            </label>
          ))}
        </fieldset>

        {mode === "create-group" && (
          <label style={{ display: "grid", gap: 6, fontSize: 12, color: "var(--ink-2)" }}>
            {tx("Group name", "اسم المجموعة")}
            <input
              dir="auto"
              value={name}
              maxLength={GROUP_NAME_MAX}
              onChange={(e) => setName(e.target.value)}
              style={INPUT_STYLE}
            />
          </label>
        )}
        {mode === "add-to-group" && (
          <label style={{ display: "grid", gap: 6, fontSize: 12, color: "var(--ink-2)" }}>
            {tx("Manual group", "مجموعة يدوية")}
            <select value={groupId} onChange={(e) => setGroupId(e.target.value)} style={INPUT_STYLE}>
              <option value="">{groupsQ.loading ? tx("Loading…", "جارٍ التحميل…") : tx("Choose a group…", "اختر مجموعة…")}</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {lang === "ar" && g.nameAr ? g.nameAr : g.name}
                </option>
              ))}
            </select>
            {!groupsQ.loading && !groupsQ.error && groups.length === 0 && (
              <span>{tx("No manual groups yet. Create one instead.", "لا توجد مجموعات يدوية بعد. أنشئ واحدة بدلًا من ذلك.")}</span>
            )}
          </label>
        )}
        {mode === "tag" && (
          <label style={{ display: "grid", gap: 6, fontSize: 12, color: "var(--ink-2)" }}>
            {tx("Tag", "الوسم")}
            <select value={tagId} onChange={(e) => setTagId(e.target.value)} style={INPUT_STYLE}>
              <option value="">{tagsQ.loading ? tx("Loading…", "جارٍ التحميل…") : tx("Choose a tag…", "اختر وسمًا…")}</option>
              {tags.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            {!tagsQ.loading && !tagsQ.error && tags.length === 0 && (
              <span>{tx("No tags yet. Create one in Contacts → Tags.", "لا توجد وسوم بعد. أنشئ وسمًا من جهات الاتصال ← الوسوم.")}</span>
            )}
          </label>
        )}
        {(groupsQ.error || tagsQ.error) && (
          <div role="alert" style={{ fontSize: 12.5, color: "var(--bad)" }}>
            {tx("Couldn't load the list. Close and try again.", "تعذّر تحميل القائمة. أغلق وحاول مجددًا.")}
          </div>
        )}

        {error && (
          <div role="alert" style={{ fontSize: 12.5, color: "var(--bad)" }}>
            {error}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button className="btn" onClick={onClose}>
            {tx("Cancel", "إلغاء")}
          </button>
          {partial ? (
            <button className="btn primary" onClick={() => onContinueInGroup(partial.groupId)}>
              {tx("Add to group", "إضافة إلى مجموعة")}
            </button>
          ) : (
            <button className="btn primary" disabled={!ready || busy} onClick={() => void submit()}>
              {busy ? tx("Working…", "جارٍ التنفيذ…") : title}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
