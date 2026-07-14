import { Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import type { JwtPayload } from "../auth/auth.guard";

/** Returns the room name a workspace's sockets join. */
export const workspaceRoom = (workspaceId: string): string =>
  `workspace:${workspaceId}`;

@WebSocketGateway({
  // socket.io path; defaults work fine but pinning makes it explicit.
  path: "/api/socket.io",
  cors: {
    origin: process.env.CORS_ORIGIN?.split(",") ?? "http://localhost:5173",
    credentials: true,
  },
})
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(private readonly jwt: JwtService) {}

  async handleConnection(client: Socket): Promise<void> {
    const token =
      (client.handshake.auth?.token as string | undefined) ??
      this.tokenFromAuthHeader(client.handshake.headers["authorization"]);
    if (!token) {
      client.disconnect();
      return;
    }
    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(token);
      if (!payload.workspaceId) {
        client.disconnect();
        return;
      }
      // Stash on the socket for outbound messages or later checks.
      (client.data as { user?: JwtPayload }).user = payload;
      await client.join(workspaceRoom(payload.workspaceId));
      this.logger.log(
        `connected sub=${payload.sub} ws=${payload.workspaceId} sid=${client.id}`,
      );
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket): void {
    const user = (client.data as { user?: JwtPayload }).user;
    if (user) {
      this.logger.log(
        `disconnected sub=${user.sub} ws=${user.workspaceId} sid=${client.id}`,
      );
    }
  }

  private tokenFromAuthHeader(h: string | string[] | undefined): string | null {
    const raw = Array.isArray(h) ? h[0] : h;
    if (!raw || !raw.startsWith("Bearer ")) return null;
    return raw.slice(7);
  }
}
