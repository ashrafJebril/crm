/** SP-18 copilot API calls (routes in backend/src/copilot/copilot.controller.ts). */
import { useQuery } from "@tanstack/react-query";
import { api, API_BASE, ApiError, tokenStore } from "@/api/client";
import { useAuth } from "@/auth/context";
import type {
  CopilotApprovalMode,
  CopilotPageContext,
  CopilotSessionDetail,
  CopilotSessionPage,
  CopilotUploadedAttachment,
  PendingCard,
} from "@/lib/types";

export interface StreamBody {
  sessionId?: string;
  message: string;
  references?: { kind: string; id: string }[];
  attachmentIds?: string[];
  pageContext?: CopilotPageContext;
  approvalMode: CopilotApprovalMode;
  lang: "en" | "ar";
}

export const copilotStatus = (signal?: AbortSignal) => api.get<{ available: boolean; reasons: string[] }>("/copilot/status", signal);
export const listSessions = (cursor?: string | null) => api.get<CopilotSessionPage>(`/copilot/sessions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
export const getSession = (id: string) => api.get<CopilotSessionDetail>(`/copilot/sessions/${encodeURIComponent(id)}`);
export const deleteSession = (id: string) => api.delete<{ ok: true }>(`/copilot/sessions/${encodeURIComponent(id)}`);
export const approveAction = (id: string) => api.post<{ action: PendingCard }>(`/copilot/actions/${encodeURIComponent(id)}/approve`);
export const declineAction = (id: string, note?: string) =>
  api.post<{ action: PendingCard }>(`/copilot/actions/${encodeURIComponent(id)}/decline`, note ? { note } : {});
export const deleteAttachment = (id: string) => api.delete<{ ok: true }>(`/copilot/attachments/${encodeURIComponent(id)}`);

/** One copilot turn (SSE). Resolves with the terminal event; refusals before the stream throw ApiError. */
export const streamTurn = (body: StreamBody, onEvent: (event: string, data: unknown) => void, signal?: AbortSignal) =>
  api.postEventStream("/copilot/stream", body, { onEvent, signal });

/**
 * Upload one attachment with progress (XHR: fetch has no upload progress).
 * Errors are ApiErrors carrying the server's key and extras, like `api`.
 */
export function uploadAttachment(file: File, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<CopilotUploadedAttachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/copilot/attachments`);
    const tok = tokenStore.get();
    if (tok) xhr.setRequestHeader("Authorization", `Bearer ${tok}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total));
    };
    xhr.onload = () => {
      let body: unknown = undefined;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : undefined;
      } catch {
        body = xhr.responseText;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve(body as CopilotUploadedAttachment);
        return;
      }
      const msg = body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string" ? (body as { message: string }).message : `HTTP ${xhr.status}`;
      reject(new ApiError(msg, xhr.status, undefined, body));
    };
    xhr.onerror = () => reject(new ApiError("network", 0));
    xhr.onabort = () => reject(new ApiError("aborted", 0));
    signal?.addEventListener("abort", () => xhr.abort());
    const fd = new FormData();
    fd.append("file", file);
    xhr.send(fd);
  });
}

/** `GET /copilot/status` for the active workspace (shared by the Topbar button, the drawer and the ask box). */
export function useCopilotAvailable(): boolean {
  const { activeWorkspace, status } = useAuth();
  const q = useQuery({
    queryKey: ["copilot", "status", activeWorkspace?.id ?? null],
    queryFn: ({ signal }) => copilotStatus(signal),
    enabled: status === "authenticated" && !!activeWorkspace,
    staleTime: 5 * 60_000,
    retry: false,
  });
  return q.data?.available === true;
}

/** Open the drawer from anywhere (Topbar button, Ctrl/Cmd+J, the insights ask box, a chat in the history). */
export const OPEN_COPILOT_EVENT = "aram:open-copilot";
export function openCopilot(opts: { prompt?: string; sessionId?: string } = {}): void {
  window.dispatchEvent(new CustomEvent(OPEN_COPILOT_EVENT, { detail: opts }));
}
