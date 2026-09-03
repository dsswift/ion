/**
 * Catalog-driven draft helpers for the Automation Editor.
 *
 * Every new condition and action starts VALID — a real field, a real operator,
 * and a value the field accepts — so the editor never seeds the invalid
 * `payload.` placeholder the old raw form did. When a trigger or field changes,
 * these helpers reset the dependent state to a valid default instead of leaving
 * a stale, unrunnable combination behind.
 */
import type {
  AutomationActionSpec,
  AutomationFieldSpec,
  AutomationTriggerSpec,
} from "../../../shared/automation-catalog";
import { automationAction, automationField } from "../../../shared/automation-catalog";
import type {
  AutomationAction,
  AutomationCondition,
  AutomationConditionGroup,
  AutomationConditionOperator,
  AutomationStep,
  AutomationValue,
} from "../../../shared/types-automation";

const PRESENCE_OPERATORS: readonly AutomationConditionOperator[] = ["exists", "not-exists"];

export function isPresenceOperator(operator: AutomationConditionOperator): boolean {
  return PRESENCE_OPERATORS.includes(operator);
}

/** A valid default value for a field+operator pair (undefined for presence ops). */
export function defaultValueFor(
  field: AutomationFieldSpec,
  operator: AutomationConditionOperator,
): AutomationValue | undefined {
  if (isPresenceOperator(operator)) return undefined;
  switch (field.type) {
    case "enum":
      return field.values?.[0]?.value ?? "";
    case "boolean":
      return false;
    case "number":
      return 0;
    case "string":
    case "path":
      return "";
  }
}

/** A valid new condition for a trigger — its first field, first operator, valid value. */
export function defaultConditionFor(
  trigger: AutomationTriggerSpec,
): AutomationCondition | null {
  const field = trigger.fields[0];
  if (!field) return null;
  const operator = field.operators[0];
  const value = defaultValueFor(field, operator);
  return value === undefined
    ? { path: field.path, operator }
    : { path: field.path, operator, value };
}

/** Re-seed a condition after its field changed, keeping the operator valid. */
export function conditionForField(
  path: string,
  field: AutomationFieldSpec,
): AutomationCondition {
  const operator = field.operators[0];
  const value = defaultValueFor(field, operator);
  return value === undefined ? { path, operator } : { path, operator, value };
}

/** Re-seed a condition's value after its operator changed. */
export function conditionForOperator(
  condition: AutomationCondition,
  field: AutomationFieldSpec,
  operator: AutomationConditionOperator,
): AutomationCondition {
  const value = defaultValueFor(field, operator);
  return value === undefined
    ? { path: condition.path, operator }
    : { path: condition.path, operator, value };
}

/** A valid new action, with any required enum config pre-filled to a real value. */
export function defaultActionFor(kind: string): AutomationAction {
  const spec = automationAction(kind);
  if (!spec) return { kind };
  const payload: Record<string, unknown> = {};
  for (const configField of spec.config) {
    if (!configField.required) continue;
    if (configField.type === "enum") payload[configField.key] = configField.values?.[0]?.value ?? "";
    else if (configField.type === "boolean") payload[configField.key] = false;
    else if (configField.type === "number") payload[configField.key] = 0;
    else payload[configField.key] = "";
  }
  return spec.config.length ? { kind, payload } : { kind };
}

/**
 * The flat top-level `all` conditions, or null if the group uses `any` or nested
 * groups. The guided editor edits the flat form; anything richer is shown
 * read-only and preserved verbatim (lossless).
 */
export function flatConditions(
  group: AutomationConditionGroup | undefined,
): AutomationCondition[] | null {
  if (!group) return [];
  if (group.any && group.any.length > 0) return null;
  const all = group.all ?? [];
  if (all.some((item) => !("path" in item))) return null;
  return all as AutomationCondition[];
}

/** True when the steps contain a branch the guided editor renders read-only. */
export function hasBranchSteps(steps: readonly AutomationStep[]): boolean {
  return steps.some((step) => "type" in step);
}

/** The plain ordered actions (branches excluded — they are edited elsewhere). */
export function plainActions(steps: readonly AutomationStep[]): AutomationAction[] {
  return steps.filter((step): step is AutomationAction => !("type" in step));
}

/** Drop conditions whose field the new trigger does not carry. */
export function keepValidConditions(
  conditions: readonly AutomationCondition[],
  trigger: AutomationTriggerSpec,
): AutomationCondition[] {
  return conditions.filter((condition) => {
    const field = automationField(trigger, condition.path);
    return !!field && field.operators.includes(condition.operator);
  });
}

/** Drop actions whose target the new trigger cannot supply. */
export function keepValidActions(
  actions: readonly AutomationAction[],
  trigger: AutomationTriggerSpec,
): AutomationAction[] {
  return actions.filter((action) => actionTargetSatisfied(automationAction(action.kind), trigger, action));
}

export function actionTargetSatisfied(
  spec: AutomationActionSpec | undefined,
  trigger: AutomationTriggerSpec,
  action: AutomationAction,
): boolean {
  if (!spec) return false;
  switch (spec.target) {
    case "none":
      return true;
    case "worktree":
      return trigger.provides.worktree;
    case "conversation":
      return trigger.provides.conversation;
    case "directory":
      return trigger.provides.worktree || typeof action.payload?.directory === "string";
  }
}
