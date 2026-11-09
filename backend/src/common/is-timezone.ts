import { ValidateBy, ValidationOptions } from "class-validator";

/** True when `tz` is an IANA zone name this runtime's Intl accepts. */
export function isValidTimezone(tz: unknown): boolean {
  if (typeof tz !== "string" || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** class-validator: value must be a valid IANA timezone (400 otherwise). */
export function IsTimezone(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: "isTimezone",
      validator: {
        validate: (v: unknown) => isValidTimezone(v),
        defaultMessage: () => "timezone must be a valid IANA time zone name",
      },
    },
    options,
  );
}
