import { API_BASE, ApiError, api, notifyUnauthorized, tokenStore } from "@/api/client";
import type { Workspace } from "@/lib/types";

/**
 * SP-29 R7: the logo uploads as soon as it is chosen, on its own route
 * (`POST /workspaces/:id/logo`, multipart field `file`), with progress (XHR:
 * fetch has no upload progress). Errors are ApiErrors carrying the server's
 * key and extras, like `api`.
 */
export function uploadLogo(workspaceId: string, file: File, onProgress: (fraction: number) => void): Promise<Workspace> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/workspaces/${encodeURIComponent(workspaceId)}/logo`);
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
        resolve(body as Workspace);
        return;
      }
      const msg =
        body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string"
          ? (body as { message: string }).message
          : `HTTP ${xhr.status}`;
      if (xhr.status === 401 && tok) notifyUnauthorized(tok, msg.startsWith("auth.") ? msg : "auth.session_expired");
      reject(new ApiError(msg, xhr.status, undefined, body));
    };
    xhr.onerror = () => reject(new ApiError("network", 0));
    xhr.onabort = () => reject(new ApiError("aborted", 0));
    const fd = new FormData();
    fd.append("file", file);
    xhr.send(fd);
  });
}

export const removeLogo = (workspaceId: string) => api.delete<Workspace>(`/workspaces/${encodeURIComponent(workspaceId)}/logo`);
