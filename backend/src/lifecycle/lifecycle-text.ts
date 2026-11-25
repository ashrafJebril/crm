import { validTz } from "../activities/buckets";

/**
 * Booking date and time as the customer reads them, in the workspace timezone,
 * with Latin digits in both languages (`ar-SA-u-nu-latn`, the SP-04 rule).
 * Templates never format dates themselves.
 */
export function formatBookingTexts(
  startAt: Date | string,
  tz: string | null | undefined,
): { dateTextAr: string; dateTextEn: string; timeTextAr: string; timeTextEn: string } {
  const d = typeof startAt === "string" ? new Date(startAt) : startAt;
  const timeZone = validTz(tz ?? "");
  const date = (locale: string) =>
    new Intl.DateTimeFormat(locale, { timeZone, weekday: "long", day: "numeric", month: "long" }).format(d);
  const time = (locale: string) =>
    new Intl.DateTimeFormat(locale, { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return {
    dateTextAr: date("ar-SA-u-nu-latn-ca-gregory"),
    dateTextEn: date("en-GB"),
    timeTextAr: time("ar-SA-u-nu-latn"),
    timeTextEn: time("en-GB"),
  };
}
