import { GUARDS_METADATA } from "@nestjs/common/constants";
import { WORKSPACE_ROLES_KEY, WorkspaceRolesGuard } from "../common/workspace-roles.guard";
import { CustomFieldsController } from "./custom-fields.controller";

describe("CustomFieldsController role guards", () => {
  const proto = CustomFieldsController.prototype as unknown as Record<string, object>;
  const guards = (m: string) => Reflect.getMetadata(GUARDS_METADATA, proto[m]) as unknown[] | undefined;
  const roles = (m: string) => Reflect.getMetadata(WORKSPACE_ROLES_KEY, proto[m]) as string[] | undefined;

  it.each(["create", "update", "remove"])("%s (definition write) is owner/admin only", (m) => {
    expect(guards(m)).toContain(WorkspaceRolesGuard);
    expect(roles(m)).toEqual(["owner", "admin"]);
  });

  it.each(["list", "deletePreview", "getForContact", "setForContact"])("%s stays open to all members", (m) => {
    expect(roles(m)).toBeUndefined();
  });
});
