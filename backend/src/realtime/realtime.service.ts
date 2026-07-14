import { Injectable } from "@nestjs/common";
import { RealtimeGateway, workspaceRoom } from "./realtime.gateway";

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
}
