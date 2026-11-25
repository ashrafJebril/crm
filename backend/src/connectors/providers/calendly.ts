import { labelFromContent } from "./label";

/** SP-23 Calendly: the read-only probe for the account label. */
export const CALENDLY_PROBE_TOOL = "users-get_current_user";

export function calendlyLabel(content: unknown[]): string | null {
  return labelFromContent(content, ["email", "name", "slug"]);
}
