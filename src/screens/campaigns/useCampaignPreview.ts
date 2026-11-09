import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import { usePermissions } from "@/auth/usePermissions";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import type { CampaignPreviewV2, CustomFieldDef, VarMap } from "@/lib/types";
import type { CustomLabels } from "./varMap";

export interface PreviewBody {
  segmentId?: string;
  templateId?: string;
  senderChannelIds?: string[];
  varMap?: VarMap;
  headerMediaId?: string;
}

/** Wait after the last edit before asking: each preview reads every sender's templates live from Zernio. */
export const PREVIEW_DEBOUNCE_MS = 800;

/**
 * POST /campaigns/preview, debounced and cached by body. `current` is true
 * only when the data answers the body as it is now (not a previous body
 * shown while the new one loads), which is what launch gating needs.
 */
export function useCampaignPreview(body: PreviewBody | null) {
  const key = body ? JSON.stringify(body) : null;
  const debounced = useDebouncedValue(key, PREVIEW_DEBOUNCE_MS);
  const q = useQuery<CampaignPreviewV2, Error>({
    queryKey: ["campaign-preview", debounced],
    queryFn: () => api.post<CampaignPreviewV2>("/campaigns/preview", JSON.parse(debounced!)),
    enabled: !!debounced,
    staleTime: 30_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
  const settled = key !== null && debounced === key;
  return {
    data: q.data ?? null,
    error: settled ? q.error : null,
    loading: key !== null && (!settled || q.isFetching),
    current: settled && !!q.data && !q.isPlaceholderData && !q.isFetching,
  };
}

/** The workspace's contact custom fields (contacts.view), archived included for labels. */
export function useCustomFields(): { defs: CustomFieldDef[] | null; labels: CustomLabels } {
  const { can } = usePermissions();
  const q = useFetch<CustomFieldDef[]>(can("contacts.view") ? "/custom-fields?includeArchived=1" : null);
  const labels = useMemo(
    () => new Map((q.data ?? []).map((d) => [d.key, { label: d.label, labelAr: d.labelAr }] as const)),
    [q.data],
  );
  return { defs: q.data, labels };
}
