import { RESOURCES } from "../permissions/catalog";
import { KEY_ACTIONS, KEY_RESOURCES, scopesToPermissions, storedScopesToPermissions, validateScopes } from "./api-key-scopes";

describe("api key scopes", () => {
  it("maps the scope words to catalogue actions (ruling 1)", () => {
    expect(KEY_ACTIONS).toEqual(["read", "write", "delete", "admin"]);
    expect(scopesToPermissions({ contacts: ["read"] })).toEqual({ contacts: ["view"] });
    expect(scopesToPermissions({ contacts: ["write"] })).toEqual({ contacts: ["view", "create", "update"] });
    expect(scopesToPermissions({ contacts: ["delete"] })).toEqual({ contacts: ["delete"] });
    expect(scopesToPermissions({ tickets: ["admin"] })).toEqual({ tickets: ["view", "create", "update", "delete", "manage"] });
    expect(scopesToPermissions({ contacts: ["read", "write"], reports: ["read"] })).toEqual({
      contacts: ["view", "create", "update"],
      reports: ["view"],
    });
  });

  it("allows only the ruling 3 resources", () => {
    expect([...KEY_RESOURCES].sort()).toEqual(
      ["contacts", "conversations", "tickets", "pipelines", "bookings", "campaigns", "templates", "audiences", "reports"].sort(),
    );
    const refused = RESOURCES.filter((r) => !(KEY_RESOURCES as readonly string[]).includes(r));
    expect([...refused].sort()).toEqual(
      ["members", "roles", "billing", "api_keys", "settings", "connectors", "agent", "knowledge", "channels", "workflows"].sort(),
    );
    for (const r of refused) {
      expect(() => validateScopes({ [r]: ["read"] })).toThrow(expect.objectContaining({ response: expect.objectContaining({ message: "api_keys.scope_not_allowed" }) }));
    }
  });

  it("validates shape and normalises", () => {
    expect(validateScopes({ contacts: ["write", "read", "read"] })).toEqual({ contacts: ["read", "write"] });
    expect(validateScopes({ contacts: ["read"], tickets: [] })).toEqual({ contacts: ["read"] });
    for (const bad of [null, [], "x", {}, { contacts: "read" }, { contacts: ["view"] }, { contacts: [1] }, { tickets: [] }]) {
      expect(() => validateScopes(bad)).toThrow();
    }
    // A malformed stored row grants nothing instead of throwing.
    expect(storedScopesToPermissions({ members: ["admin"] })).toEqual({});
    expect(storedScopesToPermissions(null)).toEqual({});
  });
});
