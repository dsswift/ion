import type {
  AutomationActionContext,
  AutomationActionRunner,
  AutomationCondition,
  AutomationConditionDecision,
  AutomationConditionDecisionResult,
  AutomationConditionDecisionTree,
  AutomationConditionExpression,
  AutomationConditionGroup,
  AutomationConditionGroupDecision,
  AutomationEvent,
  AutomationStep,
  AutomationStepDecision,
  AutomationValue,
} from "./types";

const MAX_CONDITION_DEPTH = 16;

export function matchesCondition(
  group: AutomationConditionGroup | undefined,
  event: AutomationEvent,
): boolean {
  return evaluateCondition(group, event).matched;
}

export function evaluateCondition(
  group: AutomationConditionGroup | undefined,
  event: AutomationEvent,
): AutomationConditionDecisionResult {
  if (!group) return { type: "none", matched: true };
  return groupDecision(
    group,
    { type: event.type, payload: event.payload, occurredAt: event.occurredAt },
    0,
  );
}

function groupDecision(
  group: AutomationConditionGroup,
  subject: Record<string, unknown>,
  depth: number,
): AutomationConditionGroupDecision {
  if (depth >= MAX_CONDITION_DEPTH)
    return { type: "group", all: [], any: [], matched: false };
  const evaluate = (
    item: AutomationConditionExpression,
  ): AutomationConditionDecisionTree =>
    isCondition(item)
      ? conditionDecision(item, subject)
      : groupDecision(item, subject, depth + 1);
  const all = (group.all ?? []).map(evaluate);
  const any = (group.any ?? []).map(evaluate);
  return {
    type: "group",
    all,
    any,
    matched: all.every((item) => item.matched) &&
      (!any.length || any.some((item) => item.matched)),
  };
}

function conditionDecision(
  condition: AutomationCondition,
  subject: Record<string, unknown>,
): AutomationConditionDecision {
  const actual = valueAt(subject, condition.path);
  return {
    type: "condition",
    path: condition.path,
    operator: condition.operator,
    ...(jsonValue(condition.value) !== undefined
      ? { expected: jsonValue(condition.value) }
      : {}),
    ...(jsonValue(actual) !== undefined ? { actual: jsonValue(actual) } : {}),
    matched: conditionMatches(condition, actual),
  };
}

function conditionMatches(condition: AutomationCondition, actual: unknown): boolean {
  // Presence operators are the only ones that treat an absent path as meaningful.
  if (condition.operator === "exists")
    return actual !== undefined && actual !== null;
  if (condition.operator === "not-exists")
    return actual === undefined || actual === null;
  // Absent path semantics split by operator polarity:
  //   Positive (equals, contains, …): missing field → false (no match).
  //   Negative (not-equals, not-contains): missing field → true (undefined ≠ any value,
  //     so "stage is not Ready to land" is vacuously satisfied when there is no stage).
  // A present JSON null is a real value and is compared normally below.
  if (actual === undefined) {
    return condition.operator === "not-equals" || condition.operator === "not-contains";
  }
  switch (condition.operator) {
    case "equals":
      return same(actual, condition.value);
    case "not-equals":
      return !same(actual, condition.value);
    case "contains":
      return typeof actual === "string" && typeof condition.value === "string"
        ? actual.includes(condition.value)
        : Array.isArray(actual) && actual.some((item) => same(item, condition.value));
    case "not-contains":
      return !(typeof actual === "string" && typeof condition.value === "string"
        ? actual.includes(condition.value)
        : Array.isArray(actual) && actual.some((item) => same(item, condition.value)));
    case "matches":
      try {
        return typeof actual === "string" &&
          typeof condition.value === "string" &&
          new RegExp(condition.value).test(actual);
      } catch {
        return false;
      }
    case "greater-than":
      return typeof actual === "number" &&
        typeof condition.value === "number" && actual > condition.value;
    case "greater-than-or-equals":
      return typeof actual === "number" &&
        typeof condition.value === "number" && actual >= condition.value;
    case "less-than":
      return typeof actual === "number" &&
        typeof condition.value === "number" && actual < condition.value;
    case "less-than-or-equals":
      return typeof actual === "number" &&
        typeof condition.value === "number" && actual <= condition.value;
  }
}

export async function runSteps(
  steps: readonly AutomationStep[],
  context: Omit<AutomationActionContext, "action">,
  runner: AutomationActionRunner,
  decisions: AutomationStepDecision[] = [],
): Promise<AutomationStepDecision[]> {
  for (const step of steps) {
    if ("type" in step) {
      const condition = groupDecision(
        step.condition,
        { type: context.event.type, payload: context.event.payload, occurredAt: context.event.occurredAt },
        0,
      );
      const selected = condition.matched ? "then" : "else";
      const branch: Extract<AutomationStepDecision, { type: "branch" }> = {
        type: "branch",
        condition,
        selected,
        steps: [],
      };
      decisions.push(branch);
      await runSteps(
        selected === "then" ? step.then : step.else ?? [],
        context,
        runner,
        branch.steps,
      );
      continue;
    }
    try {
      await runner({ ...context, action: step });
      decisions.push({ type: "action", kind: step.kind, outcome: "succeeded" });
    } catch (err) {
      decisions.push({
        type: "action",
        kind: step.kind,
        outcome: "failed",
        error: String(err),
      });
      throw err;
    }
  }
  return decisions;
}

export function selfCycleAdvisory(definition: {
  id: string;
  trigger: { event: string };
  steps?: AutomationStep[];
  actions?: AutomationStep[];
}): string | undefined {
  const hasStageAction = (steps: readonly AutomationStep[]): boolean =>
    steps.some((step) =>
      "type" in step
        ? hasStageAction(step.then) || hasStageAction(step.else ?? [])
        : step.kind === "worktree:set-stage",
    );
  return definition.trigger.event === "worktree:stage-changed" &&
    hasStageAction(definition.steps ?? definition.actions ?? [])
    ? "possible-self-cycle"
    : undefined;
}

function isCondition(
  value: AutomationConditionExpression,
): value is AutomationCondition {
  return "path" in value;
}
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function valueAt(subject: unknown, path: string): unknown {
  let value = subject;
  for (const part of path.split(".")) {
    if (!part || !value || typeof value !== "object" || Array.isArray(value))
      return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
function jsonValue(value: unknown): AutomationValue | undefined {
  if (value === undefined || typeof value === "function" || typeof value === "symbol")
    return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as AutomationValue;
  } catch {
    return undefined;
  }
}
