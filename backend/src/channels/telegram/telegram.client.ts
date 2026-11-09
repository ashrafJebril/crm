import { Injectable } from "@nestjs/common";
import { redactUrl } from "../../common/redact-url";

const API_BASE = "https://api.telegram.org";
const TIMEOUT_MS = 15_000;
/** `<bot id>:<secret>`. Checked before the token is put in a URL path. */
export const BOT_TOKEN_RE = /^\d{1,20}:[A-Za-z0-9_-]{20,100}$/;

export interface TelegramBot {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TelegramFile {
  file_id: string;
  file_path?: string;
  file_size?: number;
}

/**
 * A failed Bot API call. The message never contains the bot token: it is
 * masked by `redactUrl` (`/bot<id>:<secret>` → `/bot***`) and any literal
 * occurrence is scrubbed too.
 */
export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly errorCode: number | null = null,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

export function scrubToken(text: string, token?: string): string {
  let out = redactUrl(text);
  if (token) out = out.split(token).join("***");
  // The secret half alone (e.g. echoed without the id) is masked as well.
  const secret = token?.split(":")[1];
  if (secret && secret.length >= 8) out = out.split(secret).join("***");
  return out;
}

/**
 * Thin Telegram Bot API client (`fetch`). Every error is a TelegramApiError
 * with the token masked; the original error (whose message or stack may hold
 * the URL) is never rethrown or attached as `cause`.
 */
@Injectable()
export class TelegramClient {
  getMe(token: string): Promise<TelegramBot> {
    return this.call<TelegramBot>(token, "getMe");
  }

  async setWebhook(token: string, args: { url: string; secretToken: string }): Promise<void> {
    await this.call<boolean>(token, "setWebhook", {
      url: args.url,
      secret_token: args.secretToken,
      allowed_updates: ["message"],
    });
  }

  async deleteWebhook(token: string): Promise<void> {
    await this.call<boolean>(token, "deleteWebhook");
  }

  sendMessage(token: string, chatId: string, text: string): Promise<{ message_id: number }> {
    return this.call<{ message_id: number }>(token, "sendMessage", { chat_id: chatId, text });
  }

  getFile(token: string, fileId: string): Promise<TelegramFile> {
    return this.call<TelegramFile>(token, "getFile", { file_id: fileId });
  }

  async downloadFile(token: string, filePath: string): Promise<Buffer> {
    this.assertToken(token);
    const path = filePath.split("/").map(encodeURIComponent).join("/");
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/file/bot${token}/${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      throw new TelegramApiError(`Telegram file download failed: ${scrubToken(String((e as Error)?.message ?? e), token)}`);
    }
    if (!res.ok) throw new TelegramApiError(`Telegram file download failed: HTTP ${res.status}`, res.status);
    return Buffer.from(await res.arrayBuffer());
  }

  private assertToken(token: string): void {
    if (typeof token !== "string" || !BOT_TOKEN_RE.test(token)) {
      throw new TelegramApiError("Telegram bot token is malformed");
    }
  }

  private async call<T>(token: string, method: string, params?: Record<string, unknown>): Promise<T> {
    this.assertToken(token);
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: params ? JSON.stringify(params) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new TelegramApiError(
        `Telegram ${method} request failed: ${scrubToken(String((e as Error)?.message ?? e), token)}`,
      );
    }
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      result?: T;
      description?: string;
      error_code?: number;
    } | null;
    if (!body?.ok) {
      const why = body?.description ? scrubToken(String(body.description), token) : `HTTP ${res.status}`;
      throw new TelegramApiError(`Telegram ${method} failed: ${why}`, body?.error_code ?? res.status);
    }
    return body.result as T;
  }
}
