import { Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { PaymentLockService } from "../billing/payment-lock.service";
import type { JwtPayload } from "../auth/auth.guard";
import { PermissionService } from "../permissions/permission.service";
import { SessionVersionService } from "../auth/session-version.service";

/** Returns the room name a workspace's sockets join. */
export const workspaceRoom = (workspaceId: string): string =>
  `workspace:${workspaceId}`;

/** Room for one user's sockets in one workspace (per-user notifications). */
export const userRoom = (workspaceId: string, userId: string): string =>
  `user:${workspaceId}:${userId}`;

/** SP-26: every socket of one user, across workspaces (closed on a session bump). */
export const sessionRoom = (userId: string): string => `session:${userId}`;

/**
 * SP-26 I1: the socket.io adapter is the default in-memory one (main.ts), so
 * a bump's disconnect reaches only this process. Every instance therefore
 * re-checks its own connected sockets this often (batched per user, through
 * SessionVersionService's 30 s cache) and drops stale ones: a socket on
 * another machine dies within RECHECK + cache TTL of a bump.
 */
export const SESSION_RECHECK_MS = 60_000;

@WebSocketGateway({
  // socket.io path; defaults work fine but pinning makes it explicit.
  path: "/api/socket.io",
  cors: {
    origin: process.env.CORS_ORIGIN?.split(",") ?? "http://localhost:5173",
    credentials: true,
  },
})
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly paymentLock: PaymentLockService,
    private readonly permissions: PermissionService,
    private readonly sessions: SessionVersionService,
  ) {}

  private stopListening: (() => void) | null = null;
  private recheckTimer: ReturnType<typeof setInterval> | null = null;

  /** SP-26: a reset, password change or 2FA change closes the user's open
   *  sockets on this process at once (other processes refuse the next
   *  reconnect through the sv check below). */
  onModuleInit(): void {
    this.stopListening = this.sessions.onBump((userId) => this.disconnectUser(userId));
    this.recheckTimer = setInterval(() => void this.recheckSessions(), SESSION_RECHECK_MS);
    this.recheckTimer.unref?.();
  }

  onModuleDestroy(): void {
    this.stopListening?.();
    if (this.recheckTimer) clearInterval(this.recheckTimer);
    this.recheckTimer = null;
  }

  /** Disconnects this process's sockets whose token's sv is no longer
   *  current. One lookup per (user, sv) pair. Returns how many were closed. */
  async recheckSessions(): Promise<number> {
    const sockets = this.server?.sockets?.sockets;
    if (!sockets) return 0;
    const byKey = new Map<string, Socket[]>();
    for (const socket of sockets.values()) {
      const user = (socket.data as { user?: JwtPayload } | undefined)?.user;
      if (!user) continue;
      const key = `${user.sub}|${user.sv ?? 0}`;
      const list = byKey.get(key) ?? [];
      list.push(socket);
      byKey.set(key, list);
    }
    let closed = 0;
    for (const [key, list] of byKey) {
      const [userId, sv] = key.split("|");
      let current = true;
      try {
        current = await this.sessions.isCurrent(userId as string, Number(sv));
      } catch {
        continue; // a lookup failure keeps the socket; the next sweep retries
      }
      if (current) continue;
      for (const socket of list) {
        socket.disconnect(true);
        closed++;
      }
    }
    return closed;
  }

  disconnectUser(userId: string): void {
    this.server?.in(sessionRoom(userId)).disconnectSockets(true);
  }

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
      // SP-26: a 2FA challenge (any purpose-bound token) is never a session,
      // and a token issued before a session bump is dead.
      if (payload.purpose !== undefined || !(await this.sessions.isCurrent(payload.sub, payload.sv))) {
        client.disconnect();
        return;
      }
      if (!payload.workspaceId) {
        client.disconnect();
        return;
      }
      // Locked workspaces get no live feed. Support sessions are exempt. A
      // lookup failure lands in the catch below and disconnects (fail closed).
      // Sockets already open when a lock lands stay until they reconnect.
      if (
        !payload.isSuperAdmin &&
        !payload.impersonating &&
        (await this.paymentLock.isLocked(payload.workspaceId))
      ) {
        client.disconnect();
        return;
      }
      // Only members of the JWT workspace get its live feed: a removed
      // member's token stays valid for days. Support sessions have no member
      // row and are exempt (as in PermissionGuard). A lookup failure lands in
      // the catch below and disconnects (fail closed).
      if (
        !payload.isSuperAdmin &&
        !payload.impersonating &&
        !(await this.permissions.effective(payload.workspaceId, payload.sub))
      ) {
        client.disconnect();
        return;
      }
      // Stash on the socket for outbound messages or later checks.
      (client.data as { user?: JwtPayload }).user = payload;
      await client.join(workspaceRoom(payload.workspaceId));
      await client.join(userRoom(payload.workspaceId, payload.sub));
      await client.join(sessionRoom(payload.sub));
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
