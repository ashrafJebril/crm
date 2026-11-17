import type { LifecycleLang } from "./lifecycle-catalog";

/** Arabic script (letters, presentation forms). */
const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const LATIN = /[A-Za-zÀ-ɏ]/;

/**
 * Ruling 4: the language of a lifecycle message. Arabic letters in the newest
 * inbound message → ar; Latin letters and no Arabic → en; otherwise the
 * workspace's language (there is no Contact.lang).
 */
export function pickLanguage(input: { lastInboundBody?: string | null; workspaceLang?: string | null }): LifecycleLang {
  const body = input.lastInboundBody ?? "";
  if (ARABIC.test(body)) return "ar";
  if (LATIN.test(body)) return "en";
  return input.workspaceLang === "en" ? "en" : "ar";
}

export interface TemplateVariant {
  name: string;
  language: string;
  variables?: string[];
}

/**
 * The variant to send: the preferred one when its template is approved, else
 * the other one when that is approved, else null (skip
 * `template_not_approved`). `statuses` maps a variant language to its live
 * `Template.status` (absent = no template).
 */
export function chooseVariant(
  variants: Partial<Record<LifecycleLang, TemplateVariant>>,
  statuses: Partial<Record<LifecycleLang, string | null>>,
  preferred: LifecycleLang,
): { lang: LifecycleLang; variant: TemplateVariant } | null {
  const other: LifecycleLang = preferred === "ar" ? "en" : "ar";
  for (const lang of [preferred, other]) {
    const v = variants[lang];
    if (v && statuses[lang] === "approved") return { lang, variant: v };
  }
  return null;
}
