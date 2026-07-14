import { useEffect, useMemo, useState } from "react";
import { useCreateTicket, useCreateTicketFromConversation } from "./hooks/useTicketMutations";
import { usePipelines } from "./hooks/usePipelineData";
import type { Lang, Pipeline, TicketStage } from "@/lib/types";

interface BaseProps {
  lang: Lang;
  onClose: () => void;
  onCreated?: () => void;
  /** Pre-fill the title (e.g. from the conversation context). */
  defaultTitle?: string;
  /** Preview of the conversation, shown above the form for context. Optional. */
  conversationPreview?: string;
}

type Props =
  | (BaseProps & { mode: "direct"; contactId: string; conversationId?: string })
  | (BaseProps & { mode: "from-conversation"; conversationId: string });

const LAST_USED_KEY = "pipeline:lastUsed";

export function NewTicketModal(props: Props) {
  const { lang, onClose, onCreated, defaultTitle, conversationPreview } = props;
  const { data: pipelines = [] } = usePipelines();
  const create = useCreateTicket();
  const createFromConv = useCreateTicketFromConversation();

  const lastUsed = typeof localStorage !== "undefined" ? localStorage.getItem(LAST_USED_KEY) : null;
  const defaultPipeline = useMemo(
    () => pipelines.find((p) => p.id === lastUsed) ?? pipelines[0] ?? null,
    [pipelines, lastUsed],
  );

  const [pipelineId, setPipelineId] = useState<string>(defaultPipeline?.id ?? "");
  const selectedPipeline = pipelines.find((p) => p.id === pipelineId);
  const firstNonTerminal = selectedPipeline?.stages?.find((s: TicketStage) => !s.isTerminal);

  const [stageId, setStageId] = useState<string>(firstNonTerminal?.id ?? "");
  const [title, setTitle] = useState(defaultTitle ?? "");
  const [value, setValue] = useState<string>("");
  const [description, setDescription] = useState<string>("");

  useEffect(() => {
    if (!pipelineId && defaultPipeline) {
      setPipelineId(defaultPipeline.id);
    }
  }, [defaultPipeline, pipelineId]);

  useEffect(() => {
    if (selectedPipeline) {
      const ft = selectedPipeline.stages?.find((s: TicketStage) => !s.isTerminal);
      if (ft && (!stageId || !selectedPipeline.stages.some((s: TicketStage) => s.id === stageId))) {
        setStageId(ft.id);
      }
    }
  }, [selectedPipeline, stageId]);

  const submitting = create.isPending || createFromConv.isPending;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pipelineId || !stageId || !title) return;

    const numericValue = value ? Number(value) : undefined;
    try {
      if (props.mode === "from-conversation") {
        await createFromConv.mutateAsync({
          conversationId: props.conversationId,
          pipelineId,
          stageId,
          title,
          description: description || undefined,
          value: numericValue,
        });
      } else {
        await create.mutateAsync({
          pipelineId,
          stageId,
          contactId: props.contactId,
          conversationId: props.conversationId,
          title,
          description: description || undefined,
          value: numericValue,
        });
      }
      localStorage.setItem(LAST_USED_KEY, pipelineId);
      onCreated?.();
      onClose();
    } catch {
      // Mutation already surfaces the error; UI stays open so user can retry
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "grid",
        placeItems: "center",
        zIndex: 100,
      }}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={onSubmit}
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r)",
          padding: 20,
          minWidth: 380,
          maxWidth: 440,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 15, color: "var(--ink)" }}>
          {lang === "ar" ? "تذكرة جديدة" : "New ticket"}
        </h3>

        {conversationPreview ? (
          <div
            style={{
              padding: 10,
              background: "var(--bg-2)",
              borderRadius: "var(--r)",
              fontSize: 12,
              color: "var(--ink-2)",
              borderLeft: "3px solid var(--accent)",
            }}
          >
            {conversationPreview}
          </div>
        ) : null}

        <label style={{ fontSize: 11, color: "var(--ink-3)" }}>
          {lang === "ar" ? "خط الأنابيب" : "Pipeline"}
        </label>
        <select
          value={pipelineId}
          onChange={(e) => setPipelineId(e.target.value)}
          required
          style={selectStyle}
        >
          {pipelines.map((p: Pipeline) => (
            <option key={p.id} value={p.id}>
              {lang === "ar" ? p.nameAr : p.name}
            </option>
          ))}
        </select>

        <label style={{ fontSize: 11, color: "var(--ink-3)" }}>
          {lang === "ar" ? "المرحلة" : "Stage"}
        </label>
        <select
          value={stageId}
          onChange={(e) => setStageId(e.target.value)}
          required
          style={selectStyle}
        >
          {(selectedPipeline?.stages ?? []).map((s: TicketStage) => (
            <option key={s.id} value={s.id}>
              {lang === "ar" ? s.labelAr : s.label}
            </option>
          ))}
        </select>

        <label style={{ fontSize: 11, color: "var(--ink-3)" }}>
          {lang === "ar" ? "العنوان" : "Title"}
        </label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          autoFocus
          style={inputStyle}
        />

        <label style={{ fontSize: 11, color: "var(--ink-3)" }}>
          {lang === "ar" ? "القيمة" : "Value"}
        </label>
        <input
          type="number"
          min="0"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="0"
          style={inputStyle}
        />

        <label style={{ fontSize: 11, color: "var(--ink-3)" }}>
          {lang === "ar" ? "ملاحظات" : "Description"}
        </label>
        <textarea
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          style={{ ...inputStyle, resize: "vertical" }}
        />

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 6 }}>
          <button type="button" onClick={onClose} style={btnSecondary}>
            {lang === "ar" ? "إلغاء" : "Cancel"}
          </button>
          <button type="submit" disabled={submitting} style={btnPrimary}>
            {submitting
              ? lang === "ar"
                ? "جارٍ الحفظ..."
                : "Saving..."
              : lang === "ar"
                ? "إنشاء"
                : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--bg-2)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r)",
  padding: "8px 12px",
  color: "var(--ink)",
  fontSize: 13,
};

const selectStyle: React.CSSProperties = inputStyle;

const btnSecondary: React.CSSProperties = {
  padding: "8px 14px",
  background: "transparent",
  border: "1px solid var(--line)",
  borderRadius: "var(--r)",
  color: "var(--ink-2)",
  cursor: "pointer",
};

const btnPrimary: React.CSSProperties = {
  padding: "8px 14px",
  background: "var(--accent)",
  border: 0,
  borderRadius: "var(--r)",
  color: "white",
  cursor: "pointer",
};
