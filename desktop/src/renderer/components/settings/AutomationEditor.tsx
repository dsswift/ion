import React, { useEffect, useMemo, useState } from "react";
import {
  AUTOMATION_TRIGGERS,
  automationField,
  automationTrigger,
  validateUserDefinition,
} from "../../../shared/automation-catalog";
import type {
  AutomationAction,
  AutomationCondition,
  AutomationDefinition,
} from "../../../shared/types-automation";
import { useColors } from "../../theme";
import {
  flatConditions,
  hasBranchSteps,
  keepValidActions,
  keepValidConditions,
  plainActions,
} from "./automation-draft";
import { newId, normalize, toSteps, isBranch } from "./automation-editor-helpers";
import { AutomationConditionEditor } from "./AutomationConditionEditor";
import { StepsEditor } from "./AutomationEditorSteps";

/**
 * The Automation Editor: one panel with three labeled sections (When / If /
 * Then). Not a wizard — the whole rule is visible and editable at once, in any
 * order. It is placement-agnostic: it receives its target definition and its
 * save/cancel callbacks as props and does not know whether the category mounts
 * it inline beside the list or as a full replace-view. That knowledge lives at
 * one seam in AutomationCategory, which is what keeps a later pivot localized.
 */
export function AutomationEditor({
  definition: source,
  onCancel,
  onSave,
}: {
  definition: AutomationDefinition;
  onCancel: () => void;
  onSave: (definition: AutomationDefinition) => void;
}) {
  const colors = useColors();
  const [draft, setDraft] = useState(() => normalize(source));
  useEffect(() => setDraft(normalize(source)), [source]);

  const input: React.CSSProperties = {
    background: colors.surfacePrimary,
    color: colors.textPrimary,
    border: `1px solid ${colors.containerBorder}`,
    borderRadius: 5,
    padding: "5px 7px",
    fontSize: 12,
  };
  const button: React.CSSProperties = {
    background: colors.surfaceSecondary,
    color: colors.textSecondary,
    border: `1px solid ${colors.containerBorder}`,
    borderRadius: 5,
    padding: "5px 8px",
    fontSize: 12,
  };

  const trigger = automationTrigger(draft.trigger.event);
  const flat = flatConditions(draft.condition);
  const advanced = flat === null;
  const conditions = flat ?? [];
  const steps = toSteps(draft);
  const actions = plainActions(steps);
  const branchSteps = steps.filter(isBranch);

  const finalized = useMemo(() => finalize(draft), [draft]);
  const validation = draft.trigger.event
    ? validateUserDefinition(finalized)
    : ({ ok: false, error: "Select an event first." } as const);

  const setEvent = (event: string) => {
    const nextTrigger = automationTrigger(event);
    setDraft((current) => {
      const currentConditions = flatConditions(current.condition) ?? [];
      const currentActions = plainActions(toSteps(current));
      const currentBranches = toSteps(current).filter(isBranch);
      const keptConditions = nextTrigger
        ? keepValidConditions(currentConditions, nextTrigger)
        : [];
      const keptActions = nextTrigger
        ? keepValidActions(currentActions, nextTrigger)
        : currentActions;
      return {
        ...current,
        trigger: { kind: "event", event },
        condition: keptConditions.length ? { all: keptConditions } : undefined,
        steps: [...keptActions, ...currentBranches],
      };
    });
  };

  const setConditions = (next: AutomationCondition[]) =>
    setDraft((current) => ({
      ...current,
      condition: next.length ? { all: next } : undefined,
    }));

  const setActions = (next: AutomationAction[]) =>
    setDraft((current) => ({ ...current, steps: [...next, ...branchSteps] }));

  return (
    <div
      aria-label="Automation Editor"
      style={{
        display: "grid",
        gap: 12,
        padding: 10,
        border: `1px solid ${colors.containerBorder}`,
        borderRadius: 6,
        background: colors.surfaceSecondary,
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <label style={{ color: colors.textSecondary, fontSize: 12, display: "grid", gap: 3 }}>
          Name
          <input
            aria-label="Automation name"
            value={draft.name}
            onChange={(e) => setDraft((c) => ({ ...c, name: e.target.value }))}
            style={input}
          />
        </label>
        <label style={{ color: colors.textSecondary, fontSize: 12, display: "grid", gap: 3 }}>
          When
          <select
            aria-label="Automation trigger"
            value={draft.trigger.event}
            onChange={(e) => setEvent(e.target.value)}
            style={input}
          >
            <option value="">Choose an event</option>
            {AUTOMATION_TRIGGERS.map((t) => (
              <option key={t.event} value={t.event}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label style={{ color: colors.textSecondary, fontSize: 12 }}>
        <input
          aria-label="Enable automation"
          type="checkbox"
          checked={draft.enabled}
          onChange={() => setDraft((c) => ({ ...c, enabled: !c.enabled }))}
        />{" "}
        Enabled
      </label>

      <AutomationConditionEditor
        trigger={trigger}
        conditions={conditions}
        advanced={advanced}
        onChange={setConditions}
        input={input}
        button={button}
      />

      <StepsEditor
        trigger={trigger}
        actions={actions}
        onChange={setActions}
        branchCount={branchSteps.length}
        input={input}
        button={button}
      />

      <div
        style={{
          fontSize: 12,
          color: validation.ok ? colors.textSecondary : colors.statusWarning,
        }}
      >
        {validation.ok ? preview(finalized) : validation.error}
      </div>

      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="button"
          onClick={() => onSave(finalized)}
          disabled={!validation.ok}
          style={{
            ...button,
            background: validation.ok ? colors.accent : colors.surfaceSecondary,
            color: validation.ok ? colors.textOnAccent : colors.textTertiary,
          }}
        >
          Save
        </button>
        <button type="button" onClick={onCancel} style={button}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function finalize(draft: AutomationDefinition): AutomationDefinition {
  return {
    ...draft,
    id: draft.id.trim() || `user.${newId()}`,
    name: draft.name.trim() || "Untitled automation",
    trigger: { kind: "event", event: draft.trigger.event.trim() },
    steps: toSteps(draft),
    actions: undefined,
    updatedAt: new Date().toISOString(),
  };
}

/** Plain-language summary of a runnable rule. */
function preview(definition: AutomationDefinition): string {
  const trigger = automationTrigger(definition.trigger.event);
  const when = trigger?.label ?? definition.trigger.event;
  const conditions = flatConditions(definition.condition) ?? [];
  const ifPart = conditions.length
    ? ` if ${conditions.map((c) => describeCondition(trigger, c)).join(" and ")}`
    : "";
  const actions = plainActions(toSteps(definition));
  const branches = hasBranchSteps(toSteps(definition));
  const thenPart = actions.length
    ? ` then ${actions.map(describeAction).join(", ")}`
    : branches
      ? " then run its conditional branches"
      : " then do nothing";
  return `When ${when.toLowerCase()},${ifPart}${thenPart}.`;
}

function describeCondition(
  trigger: ReturnType<typeof automationTrigger>,
  condition: AutomationCondition,
): string {
  const field = trigger && automationField(trigger, condition.path);
  const label = field?.label ?? condition.path;
  if (condition.operator === "exists") return `${label} is present`;
  if (condition.operator === "not-exists") return `${label} is absent`;
  const value = field?.values?.find((choice) => choice.value === condition.value)?.label;
  return `${label} ${condition.operator} ${value ?? String(condition.value)}`;
}

function describeAction(action: AutomationAction): string {
  if (action.kind === "worktree:set-stage")
    return `set the stage to ${String(action.payload?.stage ?? "")}`;
  if (action.kind === "desktop:notification") return "show a notification";
  if (action.kind === "conversation:slash")
    return `run /${String(action.payload?.command ?? "")}`;
  if (action.kind === "conversation:run") return "start a conversation";
  return action.kind;
}
