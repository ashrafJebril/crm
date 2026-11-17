import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, setPaymentOverdueHandler, setUnauthorizedHandler, tokenStore } from "@/api/client";
import { disconnectSocket, ensureSocket } from "@/api/realtime";
import { bootPaymentOverdue } from "@/lib/paymentLock";
import type { Workspace } from "@/lib/types";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
  initials: string;
  color: string;
  isSuperAdmin?: boolean;
  /** SP-26: TOTP two-step verification is on. */
  twoFA?: boolean;
}

/** A session as every login-like route returns it. */
export interface LoginResponse {
  token: string;
  user: AuthUser;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
}

/** SP-26: a password login with two-step verification on. */
export interface TwoFactorChallenge {
  twoFactorRequired: true;
  challenge: string;
}

export type AuthStatus = "loading" | "anonymous" | "authenticated" | "noWorkspace";

/** Why the last session ended, for the sign-in page's notice. */
export type SessionNotice = "session_expired" | null;

interface AuthContextValue {
  user: AuthUser | null;
  workspaces: Workspace[];
  activeWorkspace: Workspace | null;
  /** "noWorkspace": signed in but in no workspace (removed, or invited): the
   *  NoWorkspace page shows instead of logging out (SP-26 ruling 6). */
  status: AuthStatus;
  /** True when the current JWT is an impersonation session (super-admin
   *  entered another tenant's workspace). UI surfaces a banner + offers exit. */
  impersonating: boolean;
  /** True once any request was refused with PAYMENT_OVERDUE; cleared on logout. */
  paymentOverdue: boolean;
  sessionNotice: SessionNotice;
  /** Resolves with a challenge when two-step verification is on. */
  login: (email: string, password: string) => Promise<TwoFactorChallenge | void>;
  /** SP-26: the second step after a challenge. */
  completeTwoFactor: (challenge: string, factor: { code?: string; recoveryCode?: string }) => Promise<void>;
  /** SP-26: adopt a session another route returned (accept invite, 2FA enable/disable). */
  adoptSession: (res: LoginResponse) => void;
  /** SP-26: swap in a fresh token (change-password returns only a token). */
  adoptToken: (token: string) => void;
  register: (input: {
    email: string;
    password: string;
    name: string;
    workspaceName?: string;
  }) => Promise<void>;
  logout: () => void;
  switchWorkspace: (workspaceId: string) => Promise<void>;
  createWorkspace: (name: string) => Promise<Workspace>;
}

function readTokenPayload<T>(): T | null {
  const tok = tokenStore.get();
  if (!tok) return null;
  try {
    const payload = tok.split(".")[1];
    if (!payload) return null;
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(b64)) as T;
  } catch {
    return null;
  }
}

/** Reads the `impersonating` claim from the active JWT, no verification.
 *  We trust the server — the JWT was minted by us and the AuthGuard
 *  already verified it on every request. The client only reads the flag
 *  to drive UI state. */
function readImpersonatingFromToken(): boolean {
  return !!readTokenPayload<{ impersonating?: boolean }>()?.impersonating;
}

function readWorkspaceIdFromToken(): string | null {
  return readTokenPayload<{ workspaceId?: string }>()?.workspaceId ?? null;
}

export function isChallenge(res: unknown): res is TwoFactorChallenge {
  return !!res && typeof res === "object" && (res as { twoFactorRequired?: unknown }).twoFactorRequired === true;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<Workspace | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [paymentOverdue, setPaymentOverdue] = useState(() => bootPaymentOverdue());
  const [impersonating, setImpersonating] = useState<boolean>(
    () => readImpersonatingFromToken(),
  );
  const [sessionNotice, setSessionNotice] = useState<SessionNotice>(null);

  // Bootstrap: if we already have a token, validate it and load workspaces.
  useEffect(() => {
    const tok = tokenStore.get();
    if (!tok) {
      setStatus("anonymous");
      return;
    }
    let cancelled = false;
    Promise.all([
      api.get<AuthUser>("/auth/me"),
      api.get<Workspace[]>("/auth/workspaces"),
    ])
      .then(([me, wss]) => {
        if (cancelled) return;
        setUser(me);
        setWorkspaces(wss);
        const claimedId = readWorkspaceIdFromToken();
        setActiveWorkspace(
          (claimedId && wss.find((w) => w.id === claimedId)) || wss[0] || null,
        );
        // SP-26: no workspace is a page of its own (removed or invited), not a logout.
        setStatus(wss.length === 0 ? "noWorkspace" : "authenticated");
      })
      .catch(() => {
        if (cancelled) return;
        tokenStore.clear();
        setUser(null);
        setWorkspaces([]);
        setActiveWorkspace(null);
        setImpersonating(false);
        setStatus("anonymous");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const adoptSession = useCallback((res: LoginResponse) => {
    tokenStore.set(res.token);
    setUser(res.user);
    setWorkspaces(res.workspaces);
    const active =
      res.workspaces.find((w) => w.id === res.activeWorkspaceId) ??
      (res.activeWorkspaceId ? res.workspaces[0] : null) ??
      null;
    setActiveWorkspace(active);
    setImpersonating(readImpersonatingFromToken());
    setSessionNotice(null);
    setStatus(active ? "authenticated" : "noWorkspace");
  }, []);

  const adoptToken = useCallback((token: string) => {
    tokenStore.set(token);
    // The socket handshake reads tokenStore: reconnect with the new session.
    try {
      ensureSocket().disconnect().connect();
    } catch {
      /* no socket yet */
    }
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<LoginResponse | TwoFactorChallenge>("/auth/login", { email, password });
    if (isChallenge(res)) return res;
    adoptSession(res);
  }, [adoptSession]);

  const completeTwoFactor = useCallback(
    async (challenge: string, factor: { code?: string; recoveryCode?: string }) => {
      const res = await api.post<LoginResponse>("/auth/2fa/verify", { challenge, ...factor });
      adoptSession(res);
    },
    [adoptSession],
  );

  const register = useCallback(
    async (input: {
      email: string;
      password: string;
      name: string;
      workspaceName?: string;
    }) => {
      const res = await api.post<LoginResponse>("/auth/register", input);
      adoptSession(res);
    },
    [adoptSession],
  );

  const logout = useCallback(() => {
    disconnectSocket();
    tokenStore.clear();
    setUser(null);
    setWorkspaces([]);
    setActiveWorkspace(null);
    setImpersonating(false);
    setPaymentOverdue(false);
    setStatus("anonymous");
  }, []);

  // Any authenticated request that comes back 401 (expired/invalid token,
  // or SP-26 auth.session_expired after a reset or 2FA change) tears the
  // session down via this hook — see client.ts. The sign-in page then says
  // why.
  useEffect(() => {
    setUnauthorizedHandler((reason) => {
      setSessionNotice(reason === "auth.session_expired" ? "session_expired" : null);
      logout();
    });
    return () => setUnauthorizedHandler(null);
  }, [logout]);

  useEffect(() => {
    setPaymentOverdueHandler(() => setPaymentOverdue(true));
    return () => setPaymentOverdueHandler(null);
  }, []);

  const switchWorkspace = useCallback(async (workspaceId: string) => {
    const resp = await api.post<LoginResponse>("/auth/switch-workspace", {
      workspaceId,
    }, { localPaymentError: true });
    tokenStore.set(resp.token);
    // Reconnect the same socket so the handshake (auth callback reads tokenStore)
    // joins the new workspace's room; existing listeners stay attached.
    ensureSocket().disconnect().connect();
    setUser(resp.user);
    setWorkspaces(resp.workspaces);
    const active = resp.workspaces.find((w) => w.id === resp.activeWorkspaceId) ?? null;
    setActiveWorkspace(active);
    if (active) setStatus("authenticated");
  }, []);

  const createWorkspace = useCallback(async (name: string): Promise<Workspace> => {
    const ws = await api.post<{ id: string; name: string; slug: string; timezone: string; lang: string; plan: string }>(
      "/workspaces",
      { name },
    );
    // Refresh the user's workspace list from the server so the new entry shows
    // up with the correct role (the create endpoint auto-adds caller as owner).
    const wss = await api.get<Workspace[]>("/auth/workspaces");
    setWorkspaces(wss);
    return wss.find((w) => w.id === ws.id) ?? {
      ...ws,
      role: "owner" as const,
    };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      workspaces,
      activeWorkspace,
      status,
      impersonating,
      paymentOverdue,
      sessionNotice,
      login,
      completeTwoFactor,
      adoptSession,
      adoptToken,
      register,
      logout,
      switchWorkspace,
      createWorkspace,
    }),
    [user, workspaces, activeWorkspace, status, impersonating, paymentOverdue, sessionNotice, login, completeTwoFactor, adoptSession, adoptToken, register, logout, switchWorkspace, createWorkspace],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
