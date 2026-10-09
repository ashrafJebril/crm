import { ConditionConfig } from "./workflow-steps";
import { getByPath, RunContext } from "./workflow-variables";

export function evaluateCondition(config: ConditionConfig, context: RunContext): boolean {
  const actual = getByPath(context, config.field);
  const actualStr = actual === undefined || actual === null ? "" : String(actual);

  switch (config.operator) {
    case "equals":
      return actualStr === config.value;
    case "not_equals":
      return actualStr !== config.value;
    case "contains":
      return actualStr.includes(config.value);
    case "not_contains":
      return !actualStr.includes(config.value);
  }
}

export function interpretYesNo(answer: string | null): boolean {
  if (!answer) return false;
  const normalized = answer.trim().toLowerCase();
  return normalized.startsWith("y") || normalized.startsWith("true");
}
