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
  login: (email: string, password: string) => Promise<void>;
  register: (input: {
    email: string;
    password: string;
    name: string;
  }) => Promise<void>;
  logout: () => void;
  switchWorkspace: (workspaceId: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<Workspace | null>(null);
  const [status, setStatus] = useState<"loading" | "anonymous" | "authenticated">(
    "loading",
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
    setStatus("authenticated");
  }, []);

  const register = useCallback(
    async (input: { email: string; password: string; name: string }) => {
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

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      workspaces,
      activeWorkspace,
      status,
      login,
      register,
      logout,
      switchWorkspace,
    }),
    [user, workspaces, activeWorkspace, status, login, register, logout, switchWorkspace],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
