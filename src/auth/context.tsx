import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, tokenStore } from "@/api/client";
import type { Workspace } from "@/lib/types";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
  initials: string;
  color: string;
  isSuperAdmin?: boolean;
}

interface LoginResponse {
  token: string;
  user: AuthUser;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
}

interface AuthContextValue {
  user: AuthUser | null;
  workspaces: Workspace[];
  activeWorkspace: Workspace | null;
  status: "loading" | "anonymous" | "authenticated";
  /** True when the current JWT is an impersonation session (super-admin
   *  entered another tenant's workspace). UI surfaces a banner + offers exit. */
  impersonating: boolean;
  login: (email: string, password: string) => Promise<void>;
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

/** Reads the `impersonating` claim from the active JWT, no verification.
 *  We trust the server — the JWT was minted by us and the AuthGuard
 *  already verified it on every request. The client only reads the flag
 *  to drive UI state. */
function readImpersonatingFromToken(): boolean {
  const tok = tokenStore.get();
  if (!tok) return false;
  try {
    const payload = tok.split(".")[1];
    if (!payload) return false;
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(b64)) as { impersonating?: boolean };
    return !!json.impersonating;
  } catch {
    return false;
  }
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<Workspace | null>(null);
  const [status, setStatus] = useState<"loading" | "anonymous" | "authenticated">(
    "loading",
  );
  const [impersonating, setImpersonating] = useState<boolean>(
    () => readImpersonatingFromToken(),
  );

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
        setActiveWorkspace(wss[0] ?? null);
        if (wss.length === 0) {
          // Inconsistent state — log out to recover.
          tokenStore.clear();
          setUser(null);
          setStatus("anonymous");
        } else {
          setStatus("authenticated");
        }
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

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<LoginResponse>("/auth/login", { email, password });
    tokenStore.set(res.token);
    setUser(res.user);
    setWorkspaces(res.workspaces);
    const active =
      res.workspaces.find((w) => w.id === res.activeWorkspaceId) ??
      res.workspaces[0] ??
      null;
    setActiveWorkspace(active);
    setImpersonating(readImpersonatingFromToken());
    setStatus("authenticated");
  }, []);

  const register = useCallback(
    async (input: {
      email: string;
      password: string;
      name: string;
      workspaceName?: string;
    }) => {
      const res = await api.post<LoginResponse>("/auth/register", input);
      tokenStore.set(res.token);
      setUser(res.user);
      setWorkspaces(res.workspaces);
      const active =
        res.workspaces.find((w) => w.id === res.activeWorkspaceId) ??
        res.workspaces[0] ??
        null;
      setActiveWorkspace(active);
      setStatus("authenticated");
    },
    [],
  );

  const logout = useCallback(() => {
    tokenStore.clear();
    setUser(null);
    setWorkspaces([]);
    setActiveWorkspace(null);
    setImpersonating(false);
    setStatus("anonymous");
  }, []);

  const switchWorkspace = useCallback(async (workspaceId: string) => {
    const resp = await api.post<LoginResponse>("/auth/switch-workspace", {
      workspaceId,
    });
    tokenStore.set(resp.token);
    setUser(resp.user);
    setWorkspaces(resp.workspaces);
    setActiveWorkspace(
      resp.workspaces.find((w) => w.id === resp.activeWorkspaceId) ?? null,
    );
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
      login,
      register,
      logout,
      switchWorkspace,
      createWorkspace,
    }),
    [user, workspaces, activeWorkspace, status, impersonating, login, register, logout, switchWorkspace, createWorkspace],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
