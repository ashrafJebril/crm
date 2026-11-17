import { ApiError } from "@/api/client";
import { NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";
import type { Tx } from "@/lib/tx";

/** Copy for every SP-23 error key (backend connector-errors.ts; the test pins the list). */
export const CONNECTOR_ERROR_COPY: Record<string, [string, string]> = {
  "connectors.provider_unavailable": ["This app can't be connected on this server yet.", "لا يمكن ربط هذا التطبيق على هذا الخادم بعد."],
  "connectors.encryption_unavailable": [
    "Connections are not available right now (secret storage is not configured).",
    "الربط غير متاح حاليًا (تخزين الأسرار غير مهيأ).",
  ],
  "connectors.unsafe_url": [
    "Use a public https:// address (port 443 or 8443). Private and local addresses are not allowed.",
    "استخدم عنوان https:// عامًا (المنفذ 443 أو 8443). العناوين الخاصة والمحلية غير مسموحة.",
  ],
  "connectors.check_failed": ["We couldn't reach this MCP server or read its tools.", "تعذّر الوصول إلى خادم MCP هذا أو قراءة أدواته."],
  "connectors.tool_removed": ["The provider removed this tool.", "أزال المزوّد هذه الأداة."],
  "connectors.invalid_tools": ["Some tool switches are not valid. Reload and try again.", "بعض مفاتيح الأدوات غير صالحة. أعد التحميل وحاول مجددًا."],
  "connectors.write_access_requires_manage": [
    "Only the owner or an admin can let the agent make changes.",
    "يمكن للمالك أو المسؤول فقط السماح للوكيل بإجراء تغييرات.",
  ],
  "connectors.not_found": ["This connector no longer exists.", "هذا الموصل لم يعد موجودًا."],
  "connectors.custom_limit": ["You can add up to 10 custom connectors.", "يمكنك إضافة 10 موصلات مخصصة كحد أقصى."],
  "connectors.version_conflict": ["Someone else changed this connector", "عدّل شخص آخر هذا الموصل"],
  "connectors.disconnected": ["This connector is disconnected. Connect it again first.", "هذا الموصل مفصول. أعد ربطه أولًا."],
  "connectors.needs_reconnect": ["This connector needs reconnecting first.", "يحتاج هذا الموصل إلى إعادة الربط أولًا."],
  "connectors.agent_not_connected": [
    "Connect this workspace to a Kewy AI agent first.",
    "اربط مساحة العمل هذه بوكيل كيوي الذكاء أولًا.",
  ],
};

export const CONNECTOR_ERROR_KEYS = Object.keys(CONNECTOR_ERROR_COPY);

/** `connectors.check_failed {reason}` / `unsafe_url {reason}` details in plain words. */
const REASON_COPY: Record<string, [string, string]> = {
  not_https: ["The address must start with https://.", "يجب أن يبدأ العنوان بـ https://."],
  port_not_allowed: ["Only ports 443 and 8443 are allowed.", "المنفذان 443 و8443 فقط مسموحان."],
  private_address: ["The address points to a private or local network.", "يشير العنوان إلى شبكة خاصة أو محلية."],
  credentials_in_url: ["Remove the user name and password from the address.", "احذف اسم المستخدم وكلمة المرور من العنوان."],
  invalid_url: ["The address is not valid.", "العنوان غير صالح."],
  unauthorized: ["The server refused the credentials (check the headers).", "رفض الخادم بيانات الدخول (تحقق من الترويسات)."],
  invalid_headers: ["Check the header names and values.", "تحقق من أسماء الترويسات وقيمها."],
  invalid_name: ["Give the connector a name (up to 60 characters).", "أدخل اسمًا للموصل (حتى 60 حرفًا)."],
  timeout: ["The server took too long to answer.", "استغرق الخادم وقتًا طويلًا للرد."],
  dns_failed: ["The address could not be found.", "تعذّر العثور على العنوان."],
};

function body(e: unknown): Record<string, unknown> | null {
  return e instanceof ApiError && e.body && typeof e.body === "object" ? (e.body as Record<string, unknown>) : null;
}

export function connectorErrorKey(e: unknown): string | null {
  const m = body(e)?.message ?? (e instanceof Error ? e.message : null);
  return typeof m === "string" && CONNECTOR_ERROR_COPY[m] ? m : null;
}

export function connectorErrorText(e: unknown, tx: Tx): string {
  const key = connectorErrorKey(e);
  if (key) {
    const [en, ar] = CONNECTOR_ERROR_COPY[key]!;
    const reason = body(e)?.reason;
    const detail = typeof reason === "string" ? REASON_COPY[reason] : undefined;
    return detail ? `${tx(en, ar)} ${tx(detail[0], detail[1])}` : tx(en, ar);
  }
  if (e instanceof ApiError && e.status === 403) return tx(NO_PERMISSION_EN, NO_PERMISSION_AR);
  return tx("Something went wrong. Try again.", "حدث خطأ ما. حاول مرة أخرى.");
}
