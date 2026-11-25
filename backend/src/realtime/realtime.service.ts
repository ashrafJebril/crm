import { Injectable } from "@nestjs/common";
import { RealtimeGateway, userRoom, workspaceRoom } from "./realtime.gateway";

/** Thin façade over the gateway so services can emit without depending on
 *  socket.io types directly. */
@Injectable()
export class RealtimeService {
  constructor(private readonly gateway: RealtimeGateway) {}

  /** Emit an event to every socket in the given workspace's room. */
  emitToWorkspace(workspaceId: string, event: string, payload: unknown): void {
    // Server may not be initialized if the platform adapter hasn't booted yet;
    // guard so the emit is a no-op rather than crashing the request.
    if (!this.gateway.server) return;
    this.gateway.server.to(workspaceRoom(workspaceId)).emit(event, payload);
  }

  /** SP-19 T3: the `/widget` namespace server, attached by the WidgetGateway. */
  private widgetServer?: { to(room: string): { emit(event: string, payload: unknown): unknown } };

  attachWidgetServer(server: { to(room: string): { emit(event: string, payload: unknown): unknown } }): void {
    this.widgetServer = server;
  }

  /**
   * Emit to one web chat visitor (room `widget:<channelId>:<visitorId>`).
   * A no-op until T3's WidgetGateway attaches its namespace server.
   */
  emitToWidgetVisitor(channelId: string, visitorId: string, event: string, payload: unknown): void {
    this.widgetServer?.to(`widget:${channelId}:${visitorId}`).emit(event, payload);
  }

  /** Emit an event only to one user's sockets within a workspace. */
  emitToUser(
    workspaceId: string,
    userId: string,
    event: string,
    payload: unknown,
  ): void {
    if (!this.gateway.server) return;
    this.gateway.server.to(userRoom(workspaceId, userId)).emit(event, payload);
  }
}
