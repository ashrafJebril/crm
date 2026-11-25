import { Logger } from "@nestjs/common";
import {
  OnGatewayConnection,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import type { Namespace, Socket } from "socket.io";
import { PrismaService } from "../../prisma/prisma.service";
import { RealtimeService } from "../../realtime/realtime.service";
import { verifyVisitorToken } from "./visitor-token";
import { apiOrigins, clientIp } from "./widget-origin.guard";
import { WidgetRateLimiter } from "./widget-rate-limit.guard";

export const widgetRoom = (channelId: string, visitorId: string): string => `widget:${channelId}:${visitorId}`;

/** The handshake parts the gateway reads (a subset of socket.io's). */
export interface WidgetHandshake {
  headers: Record<string, string | string[] | undefined>;
  auth?: Record<string, unknown>;
  address?: string;
}

/**
 * socket.io namespace `/widget` for web chat visitors, on the same path as
 * the member gateway (`/api/socket.io`). Members' JWTs play no part here.
 *
 * Handshake: `auth: {channelId, visitorId, visitorToken}`. It is refused
 * (disconnected) unless:
 *  - the `Origin` header, when the browser sends one, is the API's own
 *    origin (only the hosted chat page, served by the API, connects);
 *  - the per-IP read limit is not exceeded;
 *  - the token verifies for that channel and visitor;
 *  - the channel is a live web chat channel.
 * The socket then joins `widget:<channelId>:<visitorId>` only; it receives
 * `widget.message {id, from, body, at}` via RealtimeService.emitToWidgetVisitor.
 * It accepts no client events.
 */
@WebSocketGateway({ namespace: "/widget", path: "/api/socket.io" })
export class WidgetGateway implements OnGatewayInit, OnGatewayConnection {
  @WebSocketServer()
  server!: Namespace;

  private readonly logger = new Logger(WidgetGateway.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly limits: WidgetRateLimiter,
  ) {}

  afterInit(server: Namespace): void {
    this.realtime.attachWidgetServer(server);
  }

  /** The room to join, or null when the handshake is refused. */
  async authorize(h: WidgetHandshake): Promise<string | null> {
    const origin = Array.isArray(h.headers?.origin) ? h.headers.origin[0] : h.headers?.origin;
    if (origin !== undefined && !apiOrigins({ headers: h.headers }).includes(origin.trim().toLowerCase())) return null;
    if (!this.limits.readPerIp.hit(clientIp({ headers: h.headers, ip: h.address })).ok) return null;
    const auth = h.auth ?? {};
    const channelId = auth.channelId;
    if (typeof channelId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(channelId)) return null;
    if (!verifyVisitorToken(channelId, auth.visitorId, auth.visitorToken)) return null;
    const channel = await this.prisma.raw.channel.findFirst({
      where: { id: channelId, kind: "webchat", provider: "native", status: { not: "disconnected" } },
      select: { id: true },
    });
    if (!channel) return null;
    return widgetRoom(channelId, auth.visitorId as string);
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const room = await this.authorize(client.handshake as unknown as WidgetHandshake);
      if (!room) {
        client.disconnect(true);
        return;
      }
      await client.join(room);
    } catch (e) {
      this.logger.warn(`widget handshake failed: ${(e as Error).message}`);
      client.disconnect(true);
    }
  }
}
