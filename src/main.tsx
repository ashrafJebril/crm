import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { TweaksProvider } from "@/tweaks/context";
import { AuthProvider } from "@/auth/context";
import "./styles/index.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root element not found");

// Shared cache for every useFetch call in the app. Two components asking for
// the same URL share one in-flight request and one cached payload — no more
// duplicate GETs on render.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TweaksProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </TweaksProvider>
    </QueryClientProvider>
  </StrictMode>,
);
