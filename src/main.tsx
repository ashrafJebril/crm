import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { TweaksProvider } from "@/tweaks/context";
import { AuthProvider } from "@/auth/context";
import "./styles/index.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root element not found");

createRoot(rootEl).render(
  <StrictMode>
    <TweaksProvider>
      <AuthProvider>
        <App />
      </AuthProvider>
    </TweaksProvider>
  </StrictMode>,
);
