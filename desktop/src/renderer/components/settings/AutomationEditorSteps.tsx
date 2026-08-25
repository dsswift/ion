import React from "react";
import { Tooltip } from "../git/Tooltip";
import type {
  AutomationAction,
  AutomationCondition,
  AutomationConditionOperator,
  AutomationStep,
} from "../../../shared/types-automation";
import {
  ACTION_KINDS,
  displayValue,
  isBranch,
  isValueOperator,
  newAction,
  OPERATORS,
  parseValue,
  STAGES,
} from "./automation-editor-helpers";
import {
  ACTION_LABELS,
  CONDITION_FIELD_OPTIONS,
  OPERATOR_LABELS,
  STAGE_LABELS,
} from "./automation-editor-options";

type Styles = {
  input: React.CSSProperties;
  button: React.CSSProperties;
};

export function ConditionRows({
  conditions,
  onChange,
  input,
  button,
}: {
  conditions: AutomationCondition[];
  onChange: (conditions: AutomationCondition[]) => void;
} & Styles) {
  const change = (index: number, patch: Partial<AutomationCondition>) =>
    onChange(
      conditions.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...patch } : item,
      ),
    );
  return (
    <div style={{ display: "grid", gap: 5 }}>
      <Tooltip text="All conditions must match before this workflow runs its actions. A run that does not match is recorded as skipped.">
        <strong style={{ fontSize: 12, borderBottom: `1px dotted currentColor`, cursor: 'help' }}>Run only when all conditions match</strong>
      </Tooltip>
      {conditions.map((condition, index) => (
        <div key={index} style={{ display: "flex", gap: 5 }}>
          <select
            aria-label={`Condition ${index + 1} field`}
            value={condition.path}
            onChange={(event) => change(index, { path: event.target.value })}
            style={{ ...input, flex: 1 }}
          >
            {CONDITION_FIELD_OPTIONS.map((field) => (
              <option key={field.value} value={field.value}>{field.label}</option>
            ))}
          </select>
          <select
            aria-label={`Condition ${index + 1} operator`}
            value={condition.operator}
            onChange={(event) =>
              change(index, {
                operator: event.target.value as AutomationConditionOperator,
                value: undefined,
              })
            }
            style={input}
          >
            {OPERATORS.map((operator) => (
              <option key={operator} value={operator}>{OPERATOR_LABELS[operator]}</option>
            ))}
          </select>
          {isValueOperator(condition.operator) && (
            <input
              aria-label={`Condition ${index + 1} value`}
              value={displayValue(condition.value)}
              onChange={(event) =>
                change(index, { value: parseValue(event.target.value) })
              }
              style={{ ...input, flex: 1 }}
            />
          )}
          <button
            type="button"
            aria-label={`Remove condition ${index + 1}`}
            onClick={() =>
              onChange(conditions.filter((_, itemIndex) => itemIndex !== index))
            }
            style={button}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          onChange([
            ...conditions,
            { path: "payload.", operator: "equals", value: "" },
          ])
        }
        style={{ ...button, justifySelf: "start" }}
      >
        Add condition
      </button>
    </div>
  );
}

export function StepsEditor({
  steps,
  onChange,
  input,
  button,
}: {
  steps: AutomationStep[];
  onChange: (steps: AutomationStep[]) => void;
} & Styles) {
  const replace = (index: number, step: AutomationStep) =>
    onChange(
      steps.map((item, itemIndex) => (itemIndex === index ? step : item)),
    );
  const move = (index: number, offset: number) => {
    const target = index + offset;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  const border = String(input.border).replace(/^1px solid /, "");
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <Tooltip text="Actions run in this order after the workflow trigger and conditions match. A branch selects either its Then or Else action list.">
        <strong style={{ fontSize: 12, borderBottom: `1px dotted currentColor`, cursor: 'help' }}>Actions to run, in order</strong>
      </Tooltip>
      {steps.map((step, index) => (
        <div
          key={index}
          style={{
            display: "grid",
            gap: 5,
            padding: 7,
            border: `1px solid ${border}`,
            borderRadius: 5,
          }}
        >
          {isBranch(step) ? (
            <BranchEditor
              step={step}
              onChange={(next) => replace(index, next)}
              input={input}
              button={button}
            />
          ) : (
            <ActionEditor
              action={step}
              onChange={(next) => replace(index, next)}
              input={input}
            />
          )}
          <div style={{ display: "flex", gap: 5 }}>
            <button
              type="button"
              aria-label={`Move action ${index + 1} up`}
              disabled={index === 0}
              onClick={() => move(index, -1)}
              style={button}
            >
              Up
            </button>
            <button
              type="button"
              aria-label={`Move action ${index + 1} down`}
              disabled={index === steps.length - 1}
              onClick={() => move(index, 1)}
              style={button}
            >
              Down
            </button>
            <button
              type="button"
              aria-label={`Remove action ${index + 1}`}
              onClick={() =>
                onChange(steps.filter((_, itemIndex) => itemIndex !== index))
              }
              style={button}
            >
              Remove
            </button>
          </div>
        </div>
      ))}
      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="button"
          onClick={() => onChange([...steps, newAction()])}
          style={button}
        >
          Add action
        </button>
        <button
          type="button"
          onClick={() =>
            onChange([
              ...steps,
              {
                type: "branch",
                condition: { all: [{ path: "payload.", operator: "exists" }] },
                then: [newAction()],
                else: [newAction()],
              },
            ])
          }
          style={button}
        >
          Add branch
        </button>
      </div>
    </div>
  );
}

function ActionEditor({
  action,
  onChange,
  input,
}: {
  action: AutomationAction;
  onChange: (action: AutomationAction) => void;
  input: React.CSSProperties;
}) {
  const payload = action.payload ?? {};
  const setPayload = (patch: Record<string, unknown>) =>
    onChange({ ...action, payload: { ...payload, ...patch } });
  const tabValueKey =
    action.kind === "tab:set-color"
      ? "color"
      : action.kind === "tab:set-icon"
        ? "icon"
        : "groupId";
  const tabValueLabel =
    action.kind === "tab:set-color"
      ? "Color"
      : action.kind === "tab:set-icon"
        ? "Icon"
        : "Group ID";
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      <select
        aria-label="Action kind"
        value={action.kind}
        onChange={(event) =>
          onChange(
            newAction(event.target.value as (typeof ACTION_KINDS)[number]),
          )
        }
        style={input}
      >
        <option value="" disabled>Choose an action</option>
        {ACTION_KINDS.map((kind) => (
          <option key={kind} value={kind}>{ACTION_LABELS[kind]}</option>
        ))}
      </select>
      {action.kind === "worktree:set-stage" && (
        <>
          <select
            aria-label="Target worktree stage"
            value={String(payload.stage ?? "test")}
            onChange={(event) => setPayload({ stage: event.target.value })}
            style={input}
          >
            {STAGES.map((stage) => (
              <option key={stage} value={stage}>{STAGE_LABELS[stage]}</option>
            ))}
          </select>
          <select
            aria-label="Only if stage"
            value={String(payload.onlyIfStage ?? "")}
            onChange={(event) =>
              setPayload({ onlyIfStage: event.target.value || undefined })
            }
            style={input}
          >
            <option value="">Any current stage</option>
            {STAGES.map((stage) => (
              <option key={stage} value={stage}>{STAGE_LABELS[stage]}</option>
            ))}
          </select>
        </>
      )}
      {action.kind === "desktop:notification" && (
        <>
          <input
            aria-label="Notification title"
            value={String(payload.title ?? "")}
            placeholder="Notification title"
            onChange={(event) => setPayload({ title: event.target.value })}
            style={input}
          />
          <input
            aria-label="Notification body"
            value={String(payload.body ?? "")}
            placeholder="Notification body"
            onChange={(event) => setPayload({ body: event.target.value })}
            style={{ ...input, flex: 1 }}
          />
        </>
      )}
      {action.kind === "conversation:run" && (
        <input
          aria-label="AI prompt"
          value={String(payload.prompt ?? "")}
          placeholder="Prompt for new conversation"
          onChange={(event) => setPayload({ prompt: event.target.value })}
          style={{ ...input, flex: 1, minWidth: 180 }}
        />
      )}
      {action.kind === "conversation:slash" && (
        <>
          <input
            aria-label="Slash command"
            value={String(payload.command ?? "")}
            placeholder="align"
            onChange={(event) => setPayload({ command: event.target.value })}
            style={input}
          />
          <input
            aria-label="Slash arguments"
            value={String(payload.args ?? "")}
            placeholder="Optional arguments"
            onChange={(event) => setPayload({ args: event.target.value })}
            style={{ ...input, flex: 1 }}
          />
        </>
      )}
      {(action.kind === "tab:set-color" ||
        action.kind === "tab:set-icon" ||
        action.kind === "tab:set-group") && (
        <>
          <input
            aria-label="Target tab id"
            value={String(payload.tabId ?? "")}
            placeholder="Tab ID"
            onChange={(event) => setPayload({ tabId: event.target.value })}
            style={input}
          />
          <input
            aria-label="Action value"
            value={String(payload[tabValueKey] ?? "")}
            placeholder={tabValueLabel}
            onChange={(event) =>
              setPayload({ [tabValueKey]: event.target.value })
            }
            style={input}
          />
        </>
      )}
    </div>
  );
}

function BranchEditor({
  step,
  onChange,
  input,
  button,
}: {
  step: Extract<AutomationStep, { type: "branch" }>;
  onChange: (step: Extract<AutomationStep, { type: "branch" }>) => void;
} & Styles) {
  const condition = (step.condition.all ?? []).find(
    (item): item is AutomationCondition => "path" in item,
  ) ?? { path: "payload.", operator: "exists" as const };
  const patch = (update: Partial<AutomationCondition>) =>
    onChange({ ...step, condition: { all: [{ ...condition, ...update }] } });
  return (
    <div style={{ display: "grid", gap: 5 }}>
      <Tooltip text="During a run, this branch evaluates its condition and runs the Then actions when it matches. Otherwise it runs the Else actions.">
        <strong style={{ fontSize: 12, borderBottom: `1px dotted currentColor`, cursor: 'help' }}>If this condition matches</strong>
      </Tooltip>
      <div style={{ display: "flex", gap: 5 }}>
        <select
          aria-label="Branch condition field"
          value={condition.path}
          onChange={(event) => patch({ path: event.target.value })}
          style={{ ...input, flex: 1 }}
        >
          {CONDITION_FIELD_OPTIONS.map((field) => (
            <option key={field.value} value={field.value}>{field.label}</option>
          ))}
        </select>
        <select
          aria-label="Branch condition operator"
          value={condition.operator}
          onChange={(event) =>
            patch({
              operator: event.target.value as AutomationConditionOperator,
            })
          }
          style={input}
        >
          {OPERATORS.map((operator) => (
            <option key={operator} value={operator}>{OPERATOR_LABELS[operator]}</option>
          ))}
        </select>
        {isValueOperator(condition.operator) && (
          <input
            aria-label="Branch condition value"
            value={displayValue(condition.value)}
            onChange={(event) =>
              patch({ value: parseValue(event.target.value) })
            }
            style={{ ...input, flex: 1 }}
          />
        )}
      </div>
      <label style={{ fontSize: 12 }}>
        Then{" "}
        <ActionEditor
          action={firstAction(step.then)}
          onChange={(action) => onChange({ ...step, then: [action] })}
          input={input}
        />
      </label>
      <label style={{ fontSize: 12 }}>
        Else{" "}
        <ActionEditor
          action={firstAction(step.else ?? [])}
          onChange={(action) => onChange({ ...step, else: [action] })}
          input={input}
        />
      </label>
      <span style={{ display: "none" }}>{button.padding}</span>
    </div>
  );
}

function firstAction(steps: AutomationStep[]): AutomationAction {
  return (
    steps.find((step): step is AutomationAction => !isBranch(step)) ??
    newAction()
  );
}
