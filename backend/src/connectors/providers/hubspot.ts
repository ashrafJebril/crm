import { labelFromContent } from "./label";

/** SP-23 HubSpot: the read-only probe for the account label. */
export const HUBSPOT_PROBE_TOOL = "get_user_details";

export function hubspotLabel(content: unknown[]): string | null {
  return labelFromContent(content, ["hubDomain", "hub_domain", "user", "email", "name"]);
}
