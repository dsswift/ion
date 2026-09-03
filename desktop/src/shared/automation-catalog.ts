/**
 * The Desktop Automation catalog — one typed source of truth for what the
 * Automation Editor may offer and what a user definition is allowed to contain.
 *
 * The catalog is deliberately shared (not renderer-only): the main-process user
 * CRUD validator reads it so a rule that cannot run is rejected at save time
 * rather than persisted. Loading stays tolerant — a hand-authored or future
 * project/enterprise rule using a field the catalog does not know still lists
 * and still evaluates; only a *user save* is strict.
 *
 * Renderer-only choice sources (pill colours/icons, tab groups, discovered slash
 * commands) are NOT baked in here — they are dynamic and live in the renderer,
 * which shared/ and main/ must not import. The catalog carries only the finite
 * value sets that are authoritative and stable (worktree stages, permission
 * modes, message kinds).
 */
import type {
  AutomationBranchStep,
  AutomationCondition,
  AutomationConditionExpression,
  AutomationConditionGroup,
  AutomationConditionOperator,
  AutomationDefinition,
  AutomationStep,
  AutomationValue,
} from "./types-automation";
import { WORK_STAGES } from "./types-git";

export type AutomationFieldType = "string" | "number" | "boolean" | "enum" | "path";

export interface AutomationFieldChoice {
  value: string;
  label: string;
}

export interface AutomationFieldSpec {
  path: string;
  label: string;
  type: AutomationFieldType;
  operators: readonly AutomationConditionOperator[];
  /** Finite values for an enum field, in display order. */
  values?: readonly AutomationFieldChoice[];
}

export interface AutomationTriggerSpec {
  event: string;
  label: string;
  /** Whether the triggering event can supply an action target directly. */
  provides: { worktree: boolean; conversation: boolean };
  fields: readonly AutomationFieldSpec[];
}

/** What an action needs to point at. `directory` is a worktree or a fixed path. */
export type AutomationActionTarget = "none" | "worktree" | "conversation" | "directory";

export interface AutomationActionConfigField {
  key: string;
  label: string;
  type: AutomationFieldType;
  required: boolean;
  values?: readonly AutomationFieldChoice[];
}

export interface AutomationActionSpec {
  kind: string;
  label: string;
  target: AutomationActionTarget;
  config: readonly AutomationActionConfigField[];
}

// ── Operator groups by field type ──────────────────────────────────────────
const PRESENCE_OPS = ["exists", "not-exists"] as const;
const EQUALITY_OPS = ["equals", "not-equals", ...PRESENCE_OPS] as const;
const STRING_OPS = [
  "equals",
  "not-equals",
  "contains",
  "not-contains",
  "matches",
  ...PRESENCE_OPS,
] as const;

// ── Finite, authoritative value sets ───────────────────────────────────────
const STAGE_CHOICES: readonly AutomationFieldChoice[] = WORK_STAGES.map((s) => ({
  value: s.id,
  label: s.label,
}));
const MESSAGE_KIND_CHOICES: readonly AutomationFieldChoice[] = [
  { value: "prompt", label: "Operator prompt" },
  { value: "slash", label: "Slash command" },
  { value: "structured", label: "Guided Questions answer" },
  { value: "machine", label: "Machine-authored" },
];
const PERMISSION_MODE_CHOICES: readonly AutomationFieldChoice[] = [
  { value: "plan", label: "Plan mode" },
  { value: "auto", label: "Auto mode" },
];
const SOURCE_CHOICES: readonly AutomationFieldChoice[] = [
  { value: "desktop", label: "Desktop" },
  { value: "remote", label: "iOS / remote" },
  { value: "machine", label: "Machine" },
];

// ── Reusable field specs ───────────────────────────────────────────────────
const WORKTREE_PATH_FIELD: AutomationFieldSpec = {
  path: "payload.worktreePath",
  label: "Worktree",
  type: "path",
  operators: PRESENCE_OPS,
};
const STAGE_FIELD: AutomationFieldSpec = {
  path: "payload.stage",
  label: "Current worktree stage",
  type: "enum",
  operators: EQUALITY_OPS,
  values: STAGE_CHOICES,
};
const PREVIOUS_STAGE_FIELD: AutomationFieldSpec = {
  path: "payload.previousStage",
  label: "Previous worktree stage",
  type: "enum",
  operators: EQUALITY_OPS,
  values: STAGE_CHOICES,
};
const PERMISSION_MODE_FIELD: AutomationFieldSpec = {
  path: "payload.permissionMode",
  label: "Permission mode",
  type: "enum",
  operators: EQUALITY_OPS,
  values: PERMISSION_MODE_CHOICES,
};
const SOURCE_FIELD: AutomationFieldSpec = {
  path: "payload.source",
  label: "Change source",
  type: "string",
  operators: EQUALITY_OPS,
};
const MESSAGE_KIND_FIELD: AutomationFieldSpec = {
  path: "payload.messageKind",
  label: "Message kind",
  type: "enum",
  operators: EQUALITY_OPS,
  values: MESSAGE_KIND_CHOICES,
};
const IS_STEER_FIELD: AutomationFieldSpec = {
  path: "payload.isSteer",
  label: "Sent during an active run (steer)",
  type: "boolean",
  operators: EQUALITY_OPS,
};
const SLASH_COMMAND_FIELD: AutomationFieldSpec = {
  path: "payload.slashCommand",
  label: "Slash command name",
  type: "string",
  operators: STRING_OPS,
};

// ── Trigger catalog ────────────────────────────────────────────────────────
export const AUTOMATION_TRIGGERS: readonly AutomationTriggerSpec[] = [
  {
    event: "conversation:message-submitted",
    label: "A message is submitted",
    provides: { worktree: true, conversation: true },
    fields: [
      MESSAGE_KIND_FIELD,
      PERMISSION_MODE_FIELD,
      IS_STEER_FIELD,
      { ...SOURCE_FIELD, values: SOURCE_CHOICES, type: "enum" },
      WORKTREE_PATH_FIELD,
      STAGE_FIELD,
    ],
  },
  {
    event: "prompt:submitted",
    label: "A prompt is submitted (legacy)",
    provides: { worktree: true, conversation: true },
    fields: [PERMISSION_MODE_FIELD, SLASH_COMMAND_FIELD, SOURCE_FIELD, WORKTREE_PATH_FIELD, STAGE_FIELD],
  },
  {
    event: "conversation:slash",
    label: "A slash command is submitted (legacy)",
    provides: { worktree: true, conversation: true },
    fields: [SLASH_COMMAND_FIELD, SOURCE_FIELD, WORKTREE_PATH_FIELD, STAGE_FIELD],
  },
  {
    event: "conversation:slash-resolved",
    label: "A slash command resolves",
    provides: { worktree: true, conversation: true },
    fields: [SLASH_COMMAND_FIELD, WORKTREE_PATH_FIELD, STAGE_FIELD],
  },
  {
    event: "conversation:completed",
    label: "A conversation completes",
    provides: { worktree: true, conversation: true },
    fields: [
      { path: "payload.completionReason", label: "Completion reason", type: "string", operators: STRING_OPS },
      { path: "payload.lastSlashCommand", label: "Last slash command", type: "string", operators: STRING_OPS },
      { path: "payload.endedWithQuestion", label: "Ended with a question", type: "boolean", operators: EQUALITY_OPS },
      WORKTREE_PATH_FIELD,
      STAGE_FIELD,
    ],
  },
  {
    event: "plan:implemented",
    label: "A plan is implemented",
    provides: { worktree: true, conversation: true },
    fields: [
      { path: "payload.planFilePath", label: "Plan file path", type: "string", operators: STRING_OPS },
      WORKTREE_PATH_FIELD,
      STAGE_FIELD,
    ],
  },
  {
    event: "engine:status",
    label: "Engine status changes",
    provides: { worktree: false, conversation: true },
    fields: [
      { path: "payload.state", label: "Engine state", type: "string", operators: EQUALITY_OPS },
      { path: "payload.completionReason", label: "Completion reason", type: "string", operators: STRING_OPS },
    ],
  },
  {
    event: "worktree:pin-advanced",
    label: "A worktree update reaches the bench",
    provides: { worktree: true, conversation: false },
    fields: [
      WORKTREE_PATH_FIELD,
      STAGE_FIELD,
      { path: "payload.branchName", label: "Branch name", type: "string", operators: STRING_OPS },
      { path: "payload.sourceBranch", label: "Source branch", type: "string", operators: STRING_OPS },
    ],
  },
  {
    event: "worktree:stage-changed",
    label: "A worktree stage changes",
    provides: { worktree: true, conversation: false },
    fields: [WORKTREE_PATH_FIELD, STAGE_FIELD, PREVIOUS_STAGE_FIELD, SOURCE_FIELD],
  },
  {
    event: "worktree:created",
    label: "A worktree is created",
    provides: { worktree: true, conversation: false },
    fields: [
      WORKTREE_PATH_FIELD,
      { path: "payload.branchName", label: "Branch name", type: "string", operators: STRING_OPS },
      { path: "payload.sourceBranch", label: "Source branch", type: "string", operators: STRING_OPS },
      SOURCE_FIELD,
    ],
  },
  {
    event: "worktree:landed",
    label: "A worktree lands",
    provides: { worktree: true, conversation: false },
    fields: [
      WORKTREE_PATH_FIELD,
      { path: "payload.branchName", label: "Branch name", type: "string", operators: STRING_OPS },
      { path: "payload.sourceBranch", label: "Source branch", type: "string", operators: STRING_OPS },
      { path: "payload.landMode", label: "Land mode", type: "string", operators: EQUALITY_OPS },
    ],
  },
  {
    event: "worktree:retired",
    label: "A worktree is retired",
    provides: { worktree: true, conversation: false },
    fields: [
      WORKTREE_PATH_FIELD,
      { path: "payload.branchName", label: "Branch name", type: "string", operators: STRING_OPS },
    ],
  },
  {
    event: "bench:member-added",
    label: "A worktree joins an integration bench",
    provides: { worktree: true, conversation: false },
    fields: [
      WORKTREE_PATH_FIELD,
      { path: "payload.sourceBranch", label: "Source branch", type: "string", operators: STRING_OPS },
      { path: "payload.branchName", label: "Branch name", type: "string", operators: STRING_OPS },
    ],
  },
  {
    event: "bench:member-removed",
    label: "A worktree leaves an integration bench",
    provides: { worktree: true, conversation: false },
    fields: [
      WORKTREE_PATH_FIELD,
      { path: "payload.sourceBranch", label: "Source branch", type: "string", operators: STRING_OPS },
    ],
  },
];

// ── Action catalog ─────────────────────────────────────────────────────────
export const AUTOMATION_ACTIONS: readonly AutomationActionSpec[] = [
  { kind: "record", label: "Record this run only", target: "none", config: [] },
  {
    kind: "worktree:set-stage",
    label: "Set the worktree stage",
    target: "worktree",
    config: [
      { key: "stage", label: "New stage", type: "enum", required: true, values: STAGE_CHOICES },
      { key: "onlyIfStage", label: "Only if current stage is", type: "enum", required: false, values: STAGE_CHOICES },
    ],
  },
  {
    kind: "desktop:notification",
    label: "Show a desktop notification",
    target: "none",
    config: [
      { key: "title", label: "Title", type: "string", required: true },
      { key: "body", label: "Body", type: "string", required: false },
    ],
  },
  {
    kind: "conversation:run",
    label: "Start an AI conversation",
    target: "directory",
    config: [{ key: "prompt", label: "Prompt", type: "string", required: true }],
  },
  {
    kind: "conversation:slash",
    label: "Run a slash command",
    target: "directory",
    config: [
      { key: "command", label: "Command", type: "string", required: true },
      { key: "args", label: "Arguments", type: "string", required: false },
    ],
  },
  {
    kind: "tab:set-color",
    label: "Set the tab color",
    target: "conversation",
    config: [{ key: "color", label: "Color", type: "string", required: false }],
  },
  {
    kind: "tab:set-icon",
    label: "Set the tab icon",
    target: "conversation",
    config: [{ key: "icon", label: "Icon", type: "string", required: false }],
  },
  {
    kind: "tab:set-group",
    label: "Move the tab to a group",
    target: "conversation",
    config: [
      { key: "groupId", label: "Group", type: "string", required: false },
      { key: "groupPinned", label: "Pin to group", type: "boolean", required: false },
    ],
  },
];

export function automationTrigger(event: string): AutomationTriggerSpec | undefined {
  return AUTOMATION_TRIGGERS.find((t) => t.event === event);
}
export function automationAction(kind: string): AutomationActionSpec | undefined {
  return AUTOMATION_ACTIONS.find((a) => a.kind === kind);
}
export function automationField(
  trigger: AutomationTriggerSpec,
  path: string,
): AutomationFieldSpec | undefined {
  return trigger.fields.find((f) => f.path === path);
}

export type CatalogValidation = { ok: true } | { ok: false; error: string };

/**
 * Strict validation for a user-authored definition. Rejects any trigger, field,
 * operator, value, or action the catalog does not model so a rule that could
 * never run is never persisted to `~/.ion/automation`.
 */
export function validateUserDefinition(definition: AutomationDefinition): CatalogValidation {
  const trigger = automationTrigger(definition.trigger.event);
  if (!trigger)
    return { ok: false, error: `Unknown trigger event: ${definition.trigger.event}` };

  const conditionError = validateGroup(definition.condition, trigger);
  if (conditionError) return { ok: false, error: conditionError };

  const steps = definition.steps ?? definition.actions ?? [];
  const stepError = validateSteps(steps, trigger);
  if (stepError) return { ok: false, error: stepError };
  return { ok: true };
}

function validateGroup(
  group: AutomationConditionGroup | undefined,
  trigger: AutomationTriggerSpec,
): string | undefined {
  if (!group) return undefined;
  for (const item of [...(group.all ?? []), ...(group.any ?? [])]) {
    const error = validateExpression(item, trigger);
    if (error) return error;
  }
  return undefined;
}

function validateExpression(
  item: AutomationConditionExpression,
  trigger: AutomationTriggerSpec,
): string | undefined {
  if ("path" in item) return validateCondition(item, trigger);
  return validateGroup(item, trigger);
}

function validateCondition(
  condition: AutomationCondition,
  trigger: AutomationTriggerSpec,
): string | undefined {
  const field = automationField(trigger, condition.path);
  if (!field)
    return `"${trigger.label}" has no field ${condition.path}`;
  if (!field.operators.includes(condition.operator))
    return `${field.label} cannot use operator ${condition.operator}`;
  // Presence operators take no value.
  if (condition.operator === "exists" || condition.operator === "not-exists")
    return undefined;
  return validateValue(field, condition.value);
}

function validateValue(
  field: AutomationFieldSpec,
  value: AutomationValue | undefined,
): string | undefined {
  if (value === undefined) return `${field.label} requires a value`;
  switch (field.type) {
    case "enum":
      return (field.values ?? []).some((choice) => choice.value === value)
        ? undefined
        : `${field.label} does not allow ${String(value)}`;
    case "boolean":
      return typeof value === "boolean" ? undefined : `${field.label} requires yes or no`;
    case "number":
      return typeof value === "number" ? undefined : `${field.label} requires a number`;
    case "string":
    case "path":
      return typeof value === "string" ? undefined : `${field.label} requires text`;
  }
}

function validateSteps(
  steps: readonly AutomationStep[],
  trigger: AutomationTriggerSpec,
): string | undefined {
  for (const step of steps) {
    if ("type" in step) {
      const branch = step as AutomationBranchStep;
      const groupError = validateGroup(branch.condition, trigger);
      if (groupError) return groupError;
      const thenError = validateSteps(branch.then, trigger);
      if (thenError) return thenError;
      const elseError = validateSteps(branch.else ?? [], trigger);
      if (elseError) return elseError;
      continue;
    }
    const error = validateAction(step, trigger);
    if (error) return error;
  }
  return undefined;
}

function validateAction(
  action: AutomationStep & { kind: string; payload?: Record<string, unknown> },
  trigger: AutomationTriggerSpec,
): string | undefined {
  const spec = automationAction(action.kind);
  if (!spec) return `Unknown action: ${action.kind}`;
  const payload = action.payload ?? {};
  const targetError = validateTarget(spec, trigger, payload);
  if (targetError) return targetError;
  for (const configField of spec.config) {
    const value = payload[configField.key];
    if (value === undefined || value === null || value === "") {
      if (configField.required) return `${spec.label} requires ${configField.label}`;
      continue;
    }
    const error = validateConfigValue(spec, configField, value);
    if (error) return error;
  }
  return undefined;
}

function validateTarget(
  spec: AutomationActionSpec,
  trigger: AutomationTriggerSpec,
  payload: Record<string, unknown>,
): string | undefined {
  switch (spec.target) {
    case "none":
      return undefined;
    case "worktree":
      return trigger.provides.worktree
        ? undefined
        : `"${trigger.label}" cannot supply a worktree for ${spec.label}`;
    case "conversation":
      return trigger.provides.conversation
        ? undefined
        : `"${trigger.label}" cannot supply a conversation for ${spec.label}`;
    case "directory":
      return trigger.provides.worktree || typeof payload.directory === "string"
        ? undefined
        : `${spec.label} needs a directory this trigger cannot supply`;
  }
}

function validateConfigValue(
  spec: AutomationActionSpec,
  field: AutomationActionConfigField,
  value: unknown,
): string | undefined {
  switch (field.type) {
    case "enum":
      return (field.values ?? []).some((choice) => choice.value === value)
        ? undefined
        : `${spec.label}: ${field.label} does not allow ${String(value)}`;
    case "boolean":
      return typeof value === "boolean" ? undefined : `${spec.label}: ${field.label} must be yes or no`;
    case "number":
      return typeof value === "number" ? undefined : `${spec.label}: ${field.label} must be a number`;
    case "string":
    case "path":
      return typeof value === "string" ? undefined : `${spec.label}: ${field.label} must be text`;
  }
}
