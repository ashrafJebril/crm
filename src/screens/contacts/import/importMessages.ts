import type { Tx } from "@/lib/tx";

const M: Record<string, [string, string]> = {
  "imports.file_empty": ["The file is empty.", "الملف فارغ."],
  "imports.file_too_large": ["The file is larger than 10 MB.", "حجم الملف أكبر من 10 ميغابايت."],
  "imports.unsupported_type": ["Only .csv and .xlsx files are supported.", "الملفات المدعومة هي csv و xlsx فقط."],
  "imports.file_invalid": ["The file could not be read.", "تعذّرت قراءة الملف."],
  "imports.too_many_rows": ["The file has more than 50,000 rows. Split it into smaller files.", "يحتوي الملف على أكثر من 50,000 صف. قسّمه إلى ملفات أصغر."],
  "imports.file_missing": ["Choose a file to upload.", "اختر ملفًا للرفع."],
  "imports.invalid_kind": ["Unknown import type.", "نوع الاستيراد غير معروف."],
  "imports.invalid_state": ["This import can no longer be changed.", "لا يمكن تعديل هذا الاستيراد بعد الآن."],
  "imports.not_previewed": ["Preview the import before running it.", "عاين الاستيراد قبل تشغيله."],
  "imports.options_invalid": ["Some import options are invalid.", "بعض خيارات الاستيراد غير صالحة."],
  "imports.group_required": ["Choose a group or enter a name for a new one.", "اختر مجموعة أو أدخل اسمًا لمجموعة جديدة."],
  "imports.group_invalid": ["The selected group is not available.", "المجموعة المحددة غير متاحة."],
  "imports.mapping_invalid": ["The column mapping is invalid.", "ربط الأعمدة غير صالح."],
  "imports.mapping_duplicate": ["Each field can be mapped to one column only (except tags).", "يمكن ربط كل حقل بعمود واحد فقط (عدا الوسوم)."],
  "imports.mapping_required": ["Map at least a name, first name or phone column.", "اربط عمود الاسم أو الاسم الأول أو الهاتف على الأقل."],
  "imports.custom_field_invalid": ["A mapped custom field no longer exists.", "حقل مخصص مرتبط لم يعد موجودًا."],
  "imports.owner_invalid": ["The selected owner is not a member of this workspace.", "المسؤول المحدد ليس عضوًا في مساحة العمل."],
  "imports.pipeline_invalid": ["The selected pipeline or stage is not available.", "المسار أو المرحلة المحددة غير متاحة."],
  "imports.pipeline_too_large": ["Adding to a pipeline is limited to 500 rows. Remove the pipeline option or use a smaller file.", "الإضافة إلى مسار محدودة بـ 500 صف. أزل خيار المسار أو استخدم ملفًا أصغر."],
  "imports.forbidden": ["You don't have permission for one of the selected options.", "ليست لديك صلاحية لأحد الخيارات المحددة."],
  "imports.err.no_identity": ["No name, phone or email.", "لا يوجد اسم أو هاتف أو بريد."],
  "imports.err.bad_email": ["Invalid email address.", "بريد إلكتروني غير صالح."],
  "imports.err.bad_phone": ["Invalid phone number.", "رقم هاتف غير صالح."],
  "imports.err.bad_custom_value": ["Invalid value for a custom field.", "قيمة غير صالحة لحقل مخصص."],
  "imports.err.owner_not_found": ["Owner not found in this workspace.", "المسؤول غير موجود في مساحة العمل."],
  "imports.err.owner_ambiguous": ["Several members have this name. Use the owner's email instead.", "عدة أعضاء لهم هذا الاسم. استخدم بريد المسؤول بدلًا منه."],
  "imports.err.job_failed": ["The import stopped because of an error. Start it again from a new upload.", "توقف الاستيراد بسبب خطأ. ابدأه من جديد برفع الملف مرة أخرى."],
};

/** Translates a backend import message key; unknown keys get a generic message. */
export function messageText(key: string | undefined | null, tx: Tx): string {
  const m = key ? M[key] : undefined;
  return m ? tx(m[0], m[1]) : tx("Something went wrong with the import.", "حدث خطأ في الاستيراد.");
}

/** Bilingual text for a failed contacts export (the export endpoint answers with plain messages, not keys). */
export function exportErrorText(e: unknown, tx: Tx): string {
  const status = (e as { status?: number } | null)?.status;
  const msg = e instanceof Error ? e.message : "";
  if (status === 403) return tx("You don't have permission to export contacts.", "ليست لديك صلاحية لتصدير جهات الاتصال.");
  if (status === 401) return tx("Your session expired. Sign in again.", "انتهت الجلسة. سجّل الدخول من جديد.");
  if (/limited to/i.test(msg)) return tx("Export is limited to 10,000 selected contacts. Narrow the selection or use the filters.", "التصدير محدود بـ 10,000 جهة محددة. قلّص التحديد أو استخدم المرشحات.");
  return tx("Export failed. Try again.", "فشل التصدير. حاول مرة أخرى.");
}
