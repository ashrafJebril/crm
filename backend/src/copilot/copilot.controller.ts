import { Body, Controller, Delete, Get, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { CurrentViewer, CurrentWorkspace } from "../common/current-workspace.decorator";
import type { Viewer } from "../permissions/visibility";
import { HEARTBEAT_MS, type StreamEventName } from "./copilot-constants";
import { CopilotStreamDto } from "./copilot.dto";
import { CopilotSessionsService } from "./copilot-sessions.service";
import { CopilotTurnService } from "./copilot-turn.service";

/** One SSE frame: a named event, one JSON per `data:` line. */
export function sseFrame(event: StreamEventName, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * SP-18 copilot routes. All `authenticated` (ruling 2): every tool checks its
 * own permission as the member. The workspace and member come from the JWT;
 * another member's or workspace's ids are 404.
 *
 * `POST /copilot/stream`: pre-flight refusals are normal HTTP errors; then
 * `text/event-stream` with `session` first, `activity` / `token` / `draft` /
 * `sources` while it runs, and `done` or `error` last; a heartbeat comment
 * every HEARTBEAT_MS. Closing the response does not abort the turn.
 */
@Controller("copilot")
export class CopilotController {
  constructor(
    private readonly turns: CopilotTurnService,
    private readonly sessions: CopilotSessionsService,
  ) {}

  @Get("status")
  status() {
    return this.turns.status();
  }

  @Get("sessions")
  list(@CurrentWorkspace() ws: string, @CurrentViewer() viewer: Viewer, @Query("cursor") cursor?: string) {
    return this.sessions.list(ws, viewer.userId, cursor);
  }

  @Get("sessions/:id")
  get(@CurrentWorkspace() ws: string, @CurrentViewer() viewer: Viewer, @Param("id") id: string) {
    return this.sessions.detail(ws, viewer.userId, id);
  }

  @Delete("sessions/:id")
  remove(@CurrentWorkspace() ws: string, @CurrentViewer() viewer: Viewer, @Param("id") id: string) {
    return this.sessions.remove(ws, viewer.userId, id);
  }

  @Post("stream")
  async stream(
    @CurrentWorkspace() ws: string,
    @CurrentViewer() viewer: Viewer,
    @Body() dto: CopilotStreamDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // Pre-flush: throws a normal HTTP error (400/403/404/409/429/503).
    const turn = await this.turns.prepare(ws, viewer, dto);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    let open = true;
    const heartbeat = setInterval(() => {
      if (!open) return;
      try {
        res.write(":\n\n");
      } catch {
        /* closed */
      }
    }, HEARTBEAT_MS);
    // The client leaving stops the writes, never the turn.
    req.on("close", () => {
      open = false;
      clearInterval(heartbeat);
    });
    const emit = (event: StreamEventName, data: unknown) => {
      if (!open) return;
      res.write(sseFrame(event, data));
    };
    emit("session", { sessionId: turn.sessionId, title: turn.title });
    try {
      await turn.run(emit);
    } finally {
      clearInterval(heartbeat);
      try {
        res.end();
      } catch {
        /* already closed */
      }
    }
  }
}
