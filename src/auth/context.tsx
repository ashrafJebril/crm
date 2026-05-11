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
}

interface AuthContextValue {
  user: AuthUser | null;
  status: "loading" | "anonymous" | "authenticated";
  login: (email: string, password: string) => Promise<void>;
  register: (input: {
    email: string;
    password: string;
    name: string;
  }) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<"loading" | "anonymous" | "authenticated">(
    "loading",
  );

  // Bootstrap: if we already have a token, ask /auth/me to validate it.
  useEffect(() => {
    const tok = tokenStore.get();
    if (!tok) {
      setStatus("anonymous");
      return;
    }
    let cancelled = false;
    api
      .get<AuthUser>("/auth/me")
      .then((u) => {
        if (cancelled) return;
        setUser(u);
        setStatus("authenticated");
      })
      .catch(() => {
        if (cancelled) return;
        tokenStore.clear();
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
    setStatus("authenticated");
  }, []);

  const register = useCallback(
    async (input: { email: string; password: string; name: string }) => {
      const res = await api.post<LoginResponse>("/auth/register", input);
      tokenStore.set(res.token);
      setUser(res.user);
      setStatus("authenticated");
    },
    [],
  );

  const logout = useCallback(() => {
    tokenStore.clear();
    setUser(null);
    setStatus("anonymous");
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, status, login, register, logout }),
    [user, status, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
