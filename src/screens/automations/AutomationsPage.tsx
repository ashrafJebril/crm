import { useMemo, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import type { Pipeline } from "@/lib/types";
import { newAutomation, type Automation } from "@/lib/automations";
import { useFetch } from "@/api/useFetch";
import { PageHeader } from "@/components/PageHeader";
import { Toggle } from "@/components/Toggle";
import { Modal } from "@/components/Modal";
import { Badge } from "@/components/Badge";
import { useToast } from "@/components/Toast";
import { IconBolt, IconPlus, IconTrash } from "@/icons";
import { RECIPES, summarize } from "./catalog";
import { useAutomationsStore } from "./store";
import AutomationWizard from "./AutomationWizard";
import { useLabelContext } from "./useLabelContext";
import { CHANNEL_META, TRIGGER_ICON, TRIGGER_TINT, TintIcon } from "./triggerMeta";

type View = { kind: "list" } | { kind: "edit"; draft: Automation };

export default function AutomationsPage() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { toast } = useToast();
  const store = useAutomationsStore();
  const ctx = useLabelContext();
  const pipelinesQ = useFetch<Pipeline[]>("/pipelines");
  const [view, setView] = useState<View>({ kind: "list" });
  const [confirmDelete, setConfirmDelete] = useState<Automation | null>(null);

  const wonStageRef = useMemo(() => {
    for (const p of pipelinesQ.data ?? []) {
      const won = p.stages.find((s) => s.isWon);
      if (won) return { pipelineId: p.id, stageId: won.id };
    }
    return null;
  }, [pipelinesQ.data]);

  if (view.kind === "edit") {
    return (
      <AutomationWizard
        initial={view.draft}
        onBack={() => setView({ kind: "list" })}
        onSave={(a) => {
          store.save(a);
          toast(a.enabled ? tx("Automation is on", "الأتمتة مفعّلة") : tx("Automation saved", "تم حفظ الأتمتة"), "success");
          setView({ kind: "list" });
        }}
      />
    );
  }

  const fmtDate = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleDateString(t.lang === "ar" ? "ar" : "en", { month: "short", day: "numeric" })
      : tx("never", "أبداً");

  const recipes = (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
      {RECIPES.map((r) => {
        const preview = r.build({ wonStageRef });
        const kind = preview.trigger?.kind ?? "contact.created";
        return (
          <button
            key={r.id}
            type="button"
            className="card"
            style={{
              padding: 16,
              textAlign: "start",
              cursor: "pointer",
              display: "grid",
              gridTemplateColumns: "auto 1fr",
              gap: 14,
              alignItems: "start",
              borderColor: "var(--line-soft)",
            }}
            onClick={() => setView({ kind: "edit", draft: preview })}
          >
            <TintIcon Icon={TRIGGER_ICON[kind]} tint={TRIGGER_TINT[kind]} size={40} />
            <span style={{ display: "grid", gap: 4 }}>
              <span style={{ fontWeight: 600, fontSize: 14 }}>{tx(r.en, r.ar)}</span>
              <span style={{ color: "var(--ink-3)", fontSize: 12, lineHeight: 1.4 }}>{tx(r.descEn, r.descAr)}</span>
              <span style={{ display: "flex", gap: 6, marginTop: 4 }}>
                {preview.steps.some((s) => s.kind === "whatsapp") && <Badge kind="ok" dot>{tx("WhatsApp", "واتساب")}</Badge>}
                {preview.steps.some((s) => s.kind === "email") && <Badge kind="info" dot>{tx("Email", "بريد")}</Badge>}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div style={{ overflowY: "auto", flex: 1 }}>
      <PageHeader
        title={tx("Automations", "الأتمتة")}
        subtitle={tx(
          "When something happens, send the right message automatically.",
          "عند حدوث شيء، أرسل الرسالة المناسبة تلقائياً.",
        )}
        actions={
          <button className="btn primary" onClick={() => setView({ kind: "edit", draft: newAutomation() })}>
            <IconPlus w={14} /> {tx("New automation", "أتمتة جديدة")}
          </button>
        }
      />

      <div style={{ padding: "0 24px 40px", display: "grid", gap: 20 }}>
        {store.list.length === 0 ? (
          <div className="card" style={{ padding: 28 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 20 }}>
              <TintIcon Icon={IconBolt} tint={{ fg: "var(--accent)", bg: "var(--accent-soft)" }} size={44} />
              <div>
                <h3 style={{ margin: 0, fontSize: 16 }}>{tx("Start with a recipe", "ابدأ بوصفة جاهزة")}</h3>
                <p style={{ color: "var(--ink-3)", fontSize: 13, margin: "4px 0 0" }}>
                  {tx("Pick one, tweak the message, turn it on. Three steps.", "اختر واحدة، عدّل الرسالة، وفعّلها. ثلاث خطوات.")}
                </p>
              </div>
            </div>
            {recipes}
          </div>
        ) : (
          <>
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
              {store.list.map((a, i) => {
                const kind = a.trigger?.kind ?? "contact.created";
                const hasWa = a.steps.some((s) => s.kind === "whatsapp");
                const hasEm = a.steps.some((s) => s.kind === "email");
                return (
                  <div
                    key={a.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setView({ kind: "edit", draft: a })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setView({ kind: "edit", draft: a });
                      }
                    }}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "auto minmax(0, 1fr) auto auto",
                      alignItems: "center",
                      gap: 16,
                      padding: "14px 18px",
                      borderTop: i === 0 ? undefined : "1px solid var(--line-soft)",
                      cursor: "pointer",
                      opacity: a.enabled ? 1 : 0.7,
                    }}
                  >
                    <TintIcon Icon={TRIGGER_ICON[kind]} tint={TRIGGER_TINT[kind]} size={40} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontWeight: 600, fontSize: 14 }}>{a.name || tx("Untitled", "بدون اسم")}</span>
                        <Badge kind={a.enabled ? "ok" : ""} dot>{a.enabled ? tx("Active", "نشطة") : tx("Paused", "متوقفة")}</Badge>
                      </div>
                      <div style={{ color: "var(--ink-3)", fontSize: 12, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {summarize(a, t.lang, ctx)}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      {hasWa && (
                        <TintIcon Icon={CHANNEL_META.whatsapp.Icon} tint={CHANNEL_META.whatsapp} size={28} />
                      )}
                      {hasEm && <TintIcon Icon={CHANNEL_META.email.Icon} tint={CHANNEL_META.email} size={28} />}
                      <span className="mono" style={{ color: "var(--ink-3)", fontSize: 11, marginInlineStart: 8, whiteSpace: "nowrap" }}>
                        {a.runs} {tx("runs", "تشغيل")} · {tx("last", "آخر")} {fmtDate(a.lastRunAt)}
                      </span>
                    </div>
                    <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <Toggle on={a.enabled} onChange={(v) => store.setEnabled(a.id, v)} />
                      <button
                        className="btn"
                        aria-label={tx("Delete", "حذف")}
                        style={{ padding: 6 }}
                        onClick={() => setConfirmDelete(a)}
                      >
                        <IconTrash w={14} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div>
              <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.06, marginBottom: 10 }}>
                {tx("Add another from a recipe", "أضف أخرى من وصفة")}
              </div>
              {recipes}
            </div>
          </>
        )}
      </div>

      {confirmDelete && (
        <Modal onClose={() => setConfirmDelete(null)} label={tx("Delete automation", "حذف الأتمتة")}>
          <h3 style={{ marginTop: 0 }}>{tx("Delete this automation?", "حذف هذه الأتمتة؟")}</h3>
          <p style={{ color: "var(--ink-3)", fontSize: 13 }}>{confirmDelete.name || tx("Untitled", "بدون اسم")}</p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button className="btn" onClick={() => setConfirmDelete(null)}>{tx("Cancel", "إلغاء")}</button>
            <button
              className="btn primary"
              onClick={() => {
                store.remove(confirmDelete.id);
                setConfirmDelete(null);
                toast(tx("Automation deleted", "تم حذف الأتمتة"), "info");
              }}
            >
              {tx("Delete", "حذف")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
