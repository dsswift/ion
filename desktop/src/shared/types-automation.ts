/** Shared, JSON-safe contract for desktop event automation. */
export type AutomationValue =
  | null
  | boolean
  | number
  | string
  | AutomationValue[]
  | { [key: string]: AutomationValue };
export interface AutomationTrigger {
  kind: "event";
  event: string;
}
export type AutomationConditionOperator =
  | "equals"
  | "not-equals"
  | "exists"
  | "not-exists"
  | "contains"
  | "not-contains"
  | "matches"
  | "greater-than"
  | "greater-than-or-equals"
  | "less-than"
  | "less-than-or-equals";
export interface AutomationCondition {
  path: string;
  operator: AutomationConditionOperator;
  value?: AutomationValue;
}
export interface AutomationConditionGroup {
  all?: AutomationConditionExpression[];
  any?: AutomationConditionExpression[];
}
export type AutomationConditionExpression =
  | AutomationCondition
  | AutomationConditionGroup;
export interface AutomationAction {
  kind: string;
  payload?: Record<string, unknown>;
}
export interface AutomationBranchStep {
  type: "branch";
  condition: AutomationConditionGroup;
  then: AutomationStep[];
  else?: AutomationStep[];
}
export type AutomationStep = AutomationAction | AutomationBranchStep;
export interface AutomationDefinition {
  id: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  condition?: AutomationConditionGroup;
  steps?: AutomationStep[];
  /** Legacy list, read then migrated to steps. */ actions?: AutomationAction[];
  createdAt: string;
  updatedAt: string;
}
export interface AutomationEvent {
  type: string;
  payload?: Record<string, unknown>;
  occurredAt?: string;
}
export interface AutomationCausation {
  rootId: string;
  chain: string[];
  depth: number;
}

/** A durable record of one condition result. Values are present only when JSON-safe. */
export interface AutomationConditionDecision {
  type: "condition";
  path: string;
  operator: AutomationConditionOperator;
  expected?: AutomationValue;
  actual?: AutomationValue;
  matched: boolean;
}
export interface AutomationConditionGroupDecision {
  type: "group";
  all: AutomationConditionDecisionTree[];
  any: AutomationConditionDecisionTree[];
  matched: boolean;
}
export type AutomationConditionDecisionTree =
  | AutomationConditionDecision
  | AutomationConditionGroupDecision;
export interface AutomationNoConditionDecision {
  type: "none";
  matched: true;
}
export type AutomationConditionDecisionResult =
  | AutomationConditionDecisionTree
  | AutomationNoConditionDecision;
export interface AutomationActionDecision {
  type: "action";
  kind: string;
  outcome: "succeeded" | "failed";
  error?: string;
}
export interface AutomationBranchDecision {
  type: "branch";
  condition: AutomationConditionGroupDecision;
  selected: "then" | "else";
  steps: AutomationStepDecision[];
}
export type AutomationStepDecision =
  | AutomationActionDecision
  | AutomationBranchDecision;
export interface AutomationEvaluationTrace {
  trigger: { eventType: string; occurredAt?: string };
  condition: AutomationConditionDecisionResult;
  causation: {
    decision: "continued" | "cycle" | "max-depth" | "not-evaluated";
    input: AutomationCausation;
    output?: AutomationCausation;
  };
  steps: AutomationStepDecision[];
}

export interface AutomationHistoryEntry {
  id: string;
  automationId: string;
  eventType: string;
  causation: AutomationCausation;
  startedAt: string;
  finishedAt: string;
  outcome: "succeeded" | "failed" | "skipped";
  error?: string;
  /** Optional so history written before evaluation traces stays readable. */
  trace?: AutomationEvaluationTrace;
}
export interface AutomationDocument {
  version: 1 | 2;
  definitions: AutomationDefinition[];
}
export interface EnterpriseAutomationPolicy {
  definitions?: AutomationDefinition[];
  disabledIds?: string[];
  locked?: boolean;
  maxHistoryEntries?: number;
  authorizeAiActions?: boolean;
}
export interface AutomationLayers {
  builtIn?: readonly AutomationDefinition[];
  user?: readonly AutomationDefinition[];
  project?: readonly AutomationDefinition[];
  projectDisabledIds?: readonly string[];
  enterprise?: EnterpriseAutomationPolicy;
}
export interface EffectiveAutomations {
  definitions: AutomationDefinition[];
  locked: boolean;
  maxHistoryEntries: number;
}

/** Which layer a listed definition came from. Only `user` is editable. */
export type AutomationSource = "user" | "project" | "enterprise" | "built-in";

/**
 * One source definition as Settings sees it. The listing carries every source
 * layer that defines an id — not only the effective winner — so the operator can
 * see an overridden or locally disabled rule and act on it.
 */
export interface AutomationSourceEntry {
  definition: AutomationDefinition;
  source: AutomationSource;
  /** True when this exact source is the one the runtime evaluates for its id. */
  effective: boolean;
  /** Project rules only: the id sits in the local disable ledger. */
  locallyDisabled?: boolean;
  /** Set on a non-effective entry: the higher layer that owns the id instead. */
  overriddenBy?: AutomationSource;
}

/** Source-aware view for Settings. The runtime never reads this shape. */
export interface AutomationListing {
  entries: AutomationSourceEntry[];
  /** Enterprise policy locks user mutations (definitions still listed). */
  locked: boolean;
}
export interface AutomationActionContext {
  automation: AutomationDefinition;
  action: AutomationAction;
  event: AutomationEvent;
  causation: AutomationCausation;
}
export type AutomationActionRunner = (
  context: AutomationActionContext,
) => Promise<void>;
export interface AutomationEvaluation {
  automationId: string;
  outcome: AutomationHistoryEntry["outcome"];
  causation?: AutomationCausation;
  error?: string;
  reason?: "cycle" | "max-depth" | "condition";
  trace?: AutomationEvaluationTrace;
}
export interface AutomationRuntimeEvent {
  type: "automation:executed";
  automationId: string;
  eventType: string;
  outcome: "succeeded" | "failed" | "skipped";
  worktreePath?: string;
}

export function deriveEnterpriseAutomationPolicy(
  policy: import("./types-enterprise").EnterprisePolicy | null | undefined,
): EnterpriseAutomationPolicy | undefined {
  const raw = policy?.customFields?.["ion-desktop"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const automation = (
    raw as import("./types-enterprise").IonDesktopPolicyFields
  ).automation;
  if (
    !automation ||
    typeof automation !== "object" ||
    Array.isArray(automation)
  )
    return undefined;
  return {
    definitions: automation.definitions
      ?.filter(isAutomationDefinition)
      .map(cloneDefinition),
    disabledIds: automation.disabledIds?.filter(
      (id): id is string => typeof id === "string",
    ),
    locked: automation.locked === true,
    maxHistoryEntries: automation.maxHistoryEntries,
    authorizeAiActions: automation.authorizeAiActions === true,
  };
}

export function cloneDefinition(
  definition: AutomationDefinition,
): AutomationDefinition {
  return JSON.parse(
    JSON.stringify({
      ...definition,
      actions: undefined,
      steps: definition.steps ?? definition.actions ?? [],
    }),
  ) as AutomationDefinition;
}
export function isAutomationDefinition(
  value: unknown,
): value is AutomationDefinition {
  const d = value as Partial<AutomationDefinition>;
  return (
    !!d &&
    typeof d === "object" &&
    typeof d.id === "string" &&
    d.id.length > 0 &&
    typeof d.name === "string" &&
    typeof d.enabled === "boolean" &&
    !!d.trigger &&
    d.trigger.kind === "event" &&
    typeof d.trigger.event === "string" &&
    (Array.isArray(d.steps) || Array.isArray(d.actions)) &&
    typeof d.createdAt === "string" &&
    typeof d.updatedAt === "string"
  );
}
