export interface RunContext {
  trigger: Record<string, unknown>;
  steps: Record<string, unknown>;
}

export function getByPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export function resolveVariables(template: string, context: RunContext): string {
  return template.replace(VARIABLE_PATTERN, (_match, path: string) => {
    const value = getByPath(context, path);
    return value === undefined || value === null ? "" : String(value);
  });
}
