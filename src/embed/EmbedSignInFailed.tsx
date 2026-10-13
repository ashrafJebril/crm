import { postToParent } from "./embed";

export function EmbedSignInFailed() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "var(--bg)",
        color: "var(--ink-3)",
        textAlign: "center",
      }}
    >
      <div>
        <p>Could not sign in to Marketing.</p>
        <button type="button" onClick={() => postToParent({ type: "kewy:sso-failed" })}>
          Retry
        </button>
      </div>
    </div>
  );
}
