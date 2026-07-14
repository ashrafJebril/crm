import { io, type Socket } from "socket.io-client";
import { tokenStore } from "./client";

let socket: Socket | null = null;

/** Lazily connect a singleton socket to the API server. Auth comes from the
 *  JWT in tokenStore; the server's gateway joins the socket to a room scoped
 *  to the user's workspace. */
export function ensureSocket(): Socket {
  if (socket && socket.connected) return socket;
  if (socket) {
    socket.connect();
    return socket;
  }
  const apiUrl =
    (import.meta.env.VITE_API_URL as string | undefined) ??
    "http://localhost:3001/api";
  // io() wants the origin; the socket.io endpoint sits at /api/socket.io,
  // which matches the gateway's path option on the server.
  const origin = apiUrl.replace(/\/api\/?$/, "");
  socket = io(origin || window.location.origin, {
    path: "/api/socket.io",
    transports: ["websocket", "polling"],
    auth: (cb: (data: Record<string, unknown>) => void) =>
      cb({ token: tokenStore.get() ?? "" }),
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });
  return socket;
}

/** Tear the socket down on logout so the next login gets a fresh connection
 *  with the new JWT (and joins the new workspace's room). */
export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
