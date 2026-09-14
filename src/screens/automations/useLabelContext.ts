import { useMemo } from "react";
import { useTweaks } from "@/tweaks/context";
import type { Pipeline, TagRow } from "@/lib/types";
import { useFetch } from "@/api/useFetch";
import type { LabelContext } from "./catalog";

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
