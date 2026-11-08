import type { ConversationVisibility, PermissionMatrix } from "./permissions";

const EXACT_AR: Record<string, string> = {
  "Cannot grant permissions you don't have": "لا يمكنك منح صلاحيات لا تملكها",
  "A workspace must keep at least one owner": "يجب أن تحتفظ مساحة العمل بمالك واحد على الأقل",
  "Send role or roleId, not both": "أرسل role أو roleId وليس كليهما",
  "Switch to this workspace first": "بدّل إلى مساحة العمل هذه أولاً",
  "You can't change a member with more access than you":
    "لا يمكنك تعديل عضو لديه صلاحيات أكثر منك",
  "Only the author can change this note": "فقط كاتب الملاحظة يمكنه تعديلها",
  "System roles cannot be deleted": "لا يمكن حذف أدوار النظام",
  "The Owner role cannot be modified": "لا يمكن تعديل دور المالك",
  "Role is assigned to members": "هذا الدور مسند إلى أعضاء. انقلهم إلى دور آخر أولاً.",
  "A role with this name already exists": "يوجد دور بهذا الاسم بالفعل",
  "Role not found": "الدور غير موجود",
  "Missing permission": "ليست لديك صلاحية للقيام بذلك",
};

/** Arabic text for a known server error message, or null when unknown. */
export function arabicServerMessage(message: string): string | null {
  if (EXACT_AR[message]) return EXACT_AR[message]!;
  if (/last owner/i.test(message)) return EXACT_AR["A workspace must keep at least one owner"]!;
  if (/^Only an owner can/i.test(message)) return "هذا الإجراء متاح للمالك فقط";
  if (/role .*assigned|assigned to .*member/i.test(message)) {
    return EXACT_AR["Role is assigned to members"]!;
  }
  return null;
}

export interface RoleDraft {
  name: string;
  nameAr: string;
  permissions: PermissionMatrix;
  conversationVisibility: ConversationVisibility;
}

/** Only the fields that differ from the saved role, so a rename never
 *  re-sends (and re-validates) the permission matrix. */
export function changedRoleFields(
  saved: RoleDraft,
  next: RoleDraft,
): Partial<RoleDraft> {
  const out: Partial<RoleDraft> = {};
  if (next.name !== saved.name) out.name = next.name;
  if (next.nameAr !== saved.nameAr) out.nameAr = next.nameAr;
  if (JSON.stringify(next.permissions) !== JSON.stringify(saved.permissions)) {
    out.permissions = next.permissions;
  }
  if (next.conversationVisibility !== saved.conversationVisibility) {
    out.conversationVisibility = next.conversationVisibility;
  }
  return out;
}

export interface RoleOption {
  id: string;
  name: string;
  nameAr: string;
}

/** Fallback role list built from /team rows when /roles is not readable. */
export function roleOptionsFromTeam(
  rows: Array<{ roleId?: string | null; roleName?: string; roleNameAr?: string }>,
): RoleOption[] {
  const seen = new Map<string, RoleOption>();
  for (const r of rows) {
    if (!r.roleId || seen.has(r.roleId)) continue;
    seen.set(r.roleId, {
      id: r.roleId,
      name: r.roleName ?? "",
      nameAr: r.roleNameAr || r.roleName || "",
    });
  }
  return [...seen.values()];
}
