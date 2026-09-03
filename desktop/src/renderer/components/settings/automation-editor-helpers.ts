import type {
  AutomationCondition,
  AutomationDefinition,
  AutomationStep,
} from "../../../shared/types-automation";

type Template = {
  id: string;
  label: string;
  definition: () => AutomationDefinition;
};

export const AUTOMATION_TEMPLATES: readonly Template[] = [
  {
    id: "issue-found-refinement",
    label: "Normal message on a tested worktree marks Issue found",
    definition: () =>
      template(
        "Normal refinement marks worktree as Issue found",
        "conversation:message-submitted",
        [
          {
            kind: "worktree:set-stage",
            payload: { stage: "bug", onlyIfStage: "test" },
          },
        ],
        [
          { path: "payload.worktreePath", operator: "exists" },
          { path: "payload.stage", operator: "equals", value: "test" },
          { path: "payload.messageKind", operator: "equals", value: "prompt" },
          { path: "payload.permissionMode", operator: "equals", value: "auto" },
        ],
      ),
  },
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
        "conversation:slash-resolved",
        [{ kind: "worktree:set-stage", payload: { stage: "merge" } }],
        [
          { path: "payload.slashCommand", operator: "equals", value: "align" },
          { path: "payload.worktreePath", operator: "exists" },
          // Requires a stage and never moves a ready worktree back to merge.
          { path: "payload.stage", operator: "not-equals", value: "ready" },
        ],
      ),
  },
  {
    id: "squash-merge",
    label: "Squash enters merge checks",
    definition: () =>
      template(
        "Squash enters merge checks",
        "conversation:slash-resolved",
        [{ kind: "worktree:set-stage", payload: { stage: "merge" } }],
        [
          { path: "payload.slashCommand", operator: "equals", value: "squash" },
          { path: "payload.worktreePath", operator: "exists" },
          { path: "payload.stage", operator: "not-equals", value: "ready" },
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

export function toSteps(definition: AutomationDefinition): AutomationStep[] {
  return definition.steps ?? definition.actions ?? [];
}

export function isBranch(
  step: AutomationStep,
): step is Extract<AutomationStep, { type: "branch" }> {
  return "type" in step;
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
