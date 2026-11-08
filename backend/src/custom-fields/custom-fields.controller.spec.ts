import { REQUIRE_PERMISSION_KEY } from "../permissions/require-permission.decorator";
import { CustomFieldsController } from "./custom-fields.controller";

describe("CustomFieldsController permissions", () => {
  const proto = CustomFieldsController.prototype as unknown as Record<string, object>;
  const perm = (m: string) => Reflect.getMetadata(REQUIRE_PERMISSION_KEY, proto[m]) as string | undefined;

  // Was @WorkspaceRoles("owner","admin"); settings.manage is held by exactly
  // the owner and admin system roles.
  it.each(["create", "update", "remove"])("%s (definition write) requires settings.manage", (m) => {
    expect(perm(m)).toBe("settings.manage");
  });

  it.each(["list", "deletePreview", "getForContact", "setForContact"])("%s has no handler override (route map decides)", (m) => {
    expect(perm(m)).toBeUndefined();
  });
});
