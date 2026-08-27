import type {
  AutomationAction,
  AutomationCondition,
  AutomationConditionOperator,
  AutomationDefinition,
  AutomationStep,
} from "../../../shared/types-automation";

export const OPERATORS: AutomationConditionOperator[] = [
  "equals",
  "not-equals",
  "exists",
  "not-exists",
  "contains",
  "not-contains",
  "matches",
  "greater-than",
  "greater-than-or-equals",
  "less-than",
  "less-than-or-equals",
];

export const ACTION_KINDS = [
  "record",
  "worktree:set-stage",
  "desktop:notification",
  "conversation:run",
  "conversation:slash",
  "tab:set-color",
  "tab:set-icon",
  "tab:set-group",
] as const;

export const STAGES = [
  "plan",
  "build",
  "test",
  "bug",
  "verified",
  "merge",
  "ready",
];

type Template = {
  id: string;
  label: string;
  definition: () => AutomationDefinition;
};

export const AUTOMATION_TEMPLATES: readonly Template[] = [
  {
    id: "verified-align",
    label: "Verified runs alignment",
    definition: () =>
      template(
        "Verified runs alignment",
        "worktree:stage-changed",
        [
          {
            kind: "conversation:slash",
            payload: { command: "align" },
          },
        ],
        [
          { path: "payload.stage", operator: "equals", value: "verified" },
          { path: "payload.source", operator: "equals", value: "operator" },
        ],
      ),
  },
  {
    id: "align-merge",
    label: "Align enters merge checks",
    definition: () =>
      template(
        "Align enters merge checks",
        "conversation:slash",
        [{ kind: "worktree:set-stage", payload: { stage: "merge" } }],
        [
          { path: "payload.slashCommand", operator: "equals", value: "align" },
          { path: "payload.worktreePath", operator: "exists" },
        ],
      ),
  },
  {
    id: "squash-merge",
    label: "Squash enters merge checks",
    definition: () =>
      template(
        "Squash enters merge checks",
        "conversation:slash",
        [{ kind: "worktree:set-stage", payload: { stage: "merge" } }],
        [
          { path: "payload.slashCommand", operator: "equals", value: "squash" },
          { path: "payload.worktreePath", operator: "exists" },
        ],
      ),
  },
  {
    id: "squash-ready",
    label: "Completed squash is ready to land",
    definition: () =>
      template(
        "Completed squash is ready to land",
        "conversation:completed",
        [{ kind: "worktree:set-stage", payload: { stage: "ready" } }],
        [
          {
            path: "payload.lastSlashCommand",
            operator: "equals",
            value: "squash",
          },
          {
            path: "payload.endedWithQuestion",
            operator: "equals",
            value: false,
          },
          { path: "payload.worktreePath", operator: "exists" },
        ],
      ),
  },
  {
    id: "bug-migration",
    label: "When an issue fix reaches the bench, move it to Needs testing",
    definition: () =>
      template(
        "When an issue fix reaches the bench, move it to Needs testing",
        "worktree:pin-advanced", [
        {
          kind: "worktree:set-stage",
          payload: { stage: "test", onlyIfStage: "bug" },
        },
      ]),
  },
  {
    id: "plan-message",
    label: "Plan message returns worktree to planning",
    definition: () =>
      template(
        "Plan message returns worktree to planning",
        "prompt:submitted",
        [{ kind: "worktree:set-stage", payload: { stage: "plan" } }],
        [
          { path: "payload.permissionMode", operator: "equals", value: "plan" },
          { path: "payload.worktreePath", operator: "exists" },
        ],
      ),
  },
];

function template(
  name: string,
  event: string,
  steps: AutomationStep[],
  all?: AutomationCondition[],
): AutomationDefinition {
  const now = new Date().toISOString();
  return {
    id: `user.${slug(name)}.${newId()}`,
    name,
    enabled: true,
    trigger: { kind: "event", event },
    condition: all?.length ? { all } : undefined,
    steps,
    createdAt: now,
    updatedAt: now,
  };
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function newId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export function newAction(
  kind: (typeof ACTION_KINDS)[number] = "record",
): AutomationAction {
  switch (kind) {
    case "worktree:set-stage":
      return { kind, payload: { stage: "test" } };
    case "desktop:notification":
      return { kind, payload: { title: "", body: "" } };
    case "conversation:run":
      return { kind, payload: { prompt: "" } };
    case "conversation:slash":
      return { kind, payload: { command: "", args: "" } };
    case "tab:set-color":
      return { kind, payload: { tabId: "", color: "" } };
    case "tab:set-icon":
      return { kind, payload: { tabId: "", icon: "" } };
    case "tab:set-group":
      return { kind, payload: { tabId: "", groupId: "" } };
    default:
      return { kind };
  }
}

export function toSteps(definition: AutomationDefinition): AutomationStep[] {
  return definition.steps ?? definition.actions ?? [];
}

export function isBranch(
  step: AutomationStep,
): step is Extract<AutomationStep, { type: "branch" }> {
  return "type" in step;
}

export function isValueOperator(
  operator: AutomationConditionOperator,
): boolean {
  return operator !== "exists" && operator !== "not-exists";
}

export function parseValue(value: string): string | number | boolean | null {
  try {
    return JSON.parse(value) as string | number | boolean | null;
  } catch {
    return value;
  }
}

export function displayValue(value: unknown): string {
  return value === undefined ? "" : JSON.stringify(value);
}

export function normalize(
  definition: AutomationDefinition,
): AutomationDefinition {
  return {
    ...definition,
    trigger: { ...definition.trigger },
    condition: definition.condition
      ? JSON.parse(JSON.stringify(definition.condition))
      : undefined,
    steps: JSON.parse(JSON.stringify(toSteps(definition))),
    actions: undefined,
  };
}

export function countAiActions(steps: AutomationStep[]): number {
  return steps.reduce(
    (count, step) =>
      count +
      (isBranch(step)
        ? countAiActions(step.then) + countAiActions(step.else ?? [])
        : [
              "conversation",
              "conversation:run",
              "conversation:slash",
            ].includes(step.kind)
          ? 1
          : 0),
    0,
  );
}
