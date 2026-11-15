import { getHashParam, setHashParam } from "@/lib/hashState";

/** The Contacts screen tabs. SP-16 (ruling 13): "groups" became "audiences". */
export type ContactsTabId = "contacts" | "audiences" | "tags" | "fields";

const TABS: readonly ContactsTabId[] = ["contacts", "audiences", "tags", "fields"];

/** `#/contacts?ct=<tab>`; the old `ct=groups` link still opens Audiences, and so does `aud=<id>` alone. */
export function contactsTabFromHash(hash: string): ContactsTabId {
  const ct = getHashParam(hash, "ct");
  if (ct === "groups") return "audiences";
  if (ct && (TABS as readonly string[]).includes(ct)) return ct as ContactsTabId;
  return getHashParam(hash, "aud") ? "audiences" : "contacts";
}

/** The hash with `ct` set (removed for the default tab); leaving Audiences closes an open audience. */
export function withContactsTab(hash: string, tab: ContactsTabId): string {
  let next = setHashParam(hash, "ct", tab === "contacts" ? null : tab);
  if (tab !== "audiences") next = setHashParam(next, "aud", null);
  return next;
}

/** The link to one audience's detail page. */
export function audienceHash(id: string): string {
  return setHashParam(setHashParam("#/contacts", "ct", "audiences"), "aud", id);
}
