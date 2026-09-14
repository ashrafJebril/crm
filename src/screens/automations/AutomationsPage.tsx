import { useMemo, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import type { Pipeline, TagRow } from "@/lib/types";
import { newAutomation, type Automation } from "@/lib/automations";
import { useFetch } from "@/api/useFetch";
import { PageHeader } from "@/components/PageHeader";
import { Toggle } from "@/components/Toggle";
import { Modal } from "@/components/Modal";
import { useToast } from "@/components/Toast";
import { IconBolt, IconPlus, IconTrash } from "@/icons";
import { RECIPES, summarize, type LabelContext } from "./catalog";
import { useAutomationsStore } from "./store";

/** Resolves stage and tag ids to display labels for summaries and names. */
export function useLabelContext(): LabelContext {
  const { t } = useTweaks();
  const pipelinesQ = useFetch<Pipeline[]>("/pipelines");
  const tagsQ = useFetch<TagRow[]>("/tags");
  return useMemo<LabelContext>(
    () => ({
      stageLabel: (stageId) => {
        for (const p of pipelinesQ.data ?? []) {
          const s = p.stages.find((x) => x.id === stageId);
          if (s) return t.lang === "ar" ? s.labelAr || s.label : s.label;
        }
        return undefined;
      },
      tagName: (tagId) => tagsQ.data?.find((x) => x.id === tagId)?.name,
    }),
    [pipelinesQ.data, tagsQ.data, t.lang],
  );
}

// Temporary stub, replaced by the real builder in a later task.
function AutomationBuilder({
  initial,
  onSave,
  onBack,
}: {
  initial: Automation;
  onSave: (a: Automation) => void;
  onBack: () => void;
}) {
  return (
    <div style={{ padding: 24 }}>
      <button className="btn" onClick={onBack}>Back</button>
      <button className="btn primary" onClick={() => onSave(initial)}>Save stub</button>
    </div>
  );
}

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
      <AutomationBuilder
        initial={view.draft}
        onBack={() => setView({ kind: "list" })}
        onSave={(a) => {
          store.save(a);
          toast(tx("Automation saved", "تم حفظ الأتمتة"), "success");
          setView({ kind: "list" });
        }}
      />
    );
  }

  const fmtDate = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString(t.lang === "ar" ? "ar" : "en", { month: "short", day: "numeric" }) : tx("Never", "أبداً");

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

      <div style={{ padding: "0 24px 40px", display: "grid", gap: 12 }}>
        {store.list.length === 0 ? (
          <div className="card" style={{ padding: 32 }}>
            <div style={{ textAlign: "center", marginBottom: 24 }}>
              <IconBolt w={28} />
              <h3 style={{ margin: "12px 0 4px", fontSize: 16 }}>
                {tx("Start with a recipe", "ابدأ بوصفة جاهزة")}
              </h3>
              <p style={{ color: "var(--ink-3)", fontSize: 13, margin: 0 }}>
                {tx("Pick one, tweak the message, turn it on.", "اختر واحدة، عدّل الرسالة، وفعّلها.")}
              </p>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
              {RECIPES.map((r) => (
                <button
                  key={r.id}
                  className="card"
                  style={{ padding: 16, textAlign: "start", cursor: "pointer", background: "var(--bg-2)" }}
                  onClick={() => setView({ kind: "edit", draft: r.build({ wonStageRef }) })}
                >
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{tx(r.en, r.ar)}</div>
                  <div style={{ color: "var(--ink-3)", fontSize: 12, marginTop: 6 }}>{tx(r.descEn, r.descAr)}</div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          store.list.map((a) => (
            <div
              key={a.id}
              className="card"
              style={{ padding: "14px 18px", display: "flex", alignItems: "center", gap: 16, cursor: "pointer" }}
              onClick={() => setView({ kind: "edit", draft: a })}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{a.name || tx("Untitled", "بدون اسم")}</div>
                <div style={{ color: "var(--ink-3)", fontSize: 12, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {summarize(a, t.lang, ctx)}
                </div>
              </div>
              <div className="mono" style={{ color: "var(--ink-3)", fontSize: 11, textAlign: "end", flexShrink: 0 }}>
                <div>{a.runs} {tx("runs", "تشغيل")}</div>
                <div>{tx("Last", "آخر")}: {fmtDate(a.lastRunAt)}</div>
              </div>
              <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
          ))
        )}
      </div>

      {confirmDelete && (
        <Modal onClose={() => setConfirmDelete(null)} label={tx("Delete automation", "حذف الأتمتة")}>
          <h3 style={{ marginTop: 0 }}>{tx("Delete this automation?", "حذف هذه الأتمتة؟")}</h3>
          <p style={{ color: "var(--ink-3)", fontSize: 13 }}>{confirmDelete.name}</p>
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
