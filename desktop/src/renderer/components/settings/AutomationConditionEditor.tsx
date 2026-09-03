import React from "react";
import type {
  AutomationFieldSpec,
  AutomationTriggerSpec,
} from "../../../shared/automation-catalog";
import { automationField } from "../../../shared/automation-catalog";
import type {
  AutomationCondition,
  AutomationConditionOperator,
} from "../../../shared/types-automation";
import { useColors } from "../../theme";
import {
  conditionForField,
  conditionForOperator,
  defaultConditionFor,
  isPresenceOperator,
} from "./automation-draft";

const OPERATOR_LABELS: Record<AutomationConditionOperator, string> = {
  equals: "is",
  "not-equals": "is not",
  exists: "is present",
  "not-exists": "is absent",
  contains: "contains",
  "not-contains": "does not contain",
  matches: "matches pattern",
  "greater-than": "is greater than",
  "greater-than-or-equals": "is at least",
  "less-than": "is less than",
  "less-than-or-equals": "is at most",
};

/**
 * Trigger-aware condition rows. Every control offers only what the selected
 * trigger and field allow, so a rule cannot be built with a field the event
 * never carries or an operator the field cannot use. There is no raw path input.
 */
export function AutomationConditionEditor({
  trigger,
  conditions,
  advanced,
  onChange,
  input,
  button,
}: {
  trigger: AutomationTriggerSpec | undefined;
  conditions: AutomationCondition[];
  advanced: boolean;
  onChange: (next: AutomationCondition[]) => void;
  input: React.CSSProperties;
  button: React.CSSProperties;
}) {
  const colors = useColors();
  const heading = { color: colors.textSecondary, fontSize: 12, fontWeight: 600 };

  if (!trigger)
    return (
      <div style={{ display: "grid", gap: 4 }}>
        <span style={heading}>If</span>
        <span style={{ color: colors.textTertiary, fontSize: 12 }}>
          Select an event first to add conditions.
        </span>
      </div>
    );

  if (advanced)
    return (
      <div style={{ display: "grid", gap: 4 }}>
        <span style={heading}>If</span>
        <span style={{ color: colors.statusWarning, fontSize: 12 }}>
          This rule uses advanced condition groups. They are kept as-is and shown
          read-only; edit them in the JSON file to change them.
        </span>
      </div>
    );

  const replace = (index: number, next: AutomationCondition) =>
    onChange(conditions.map((c, i) => (i === index ? next : c)));

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <span style={heading}>If (all of)</span>
      {conditions.length === 0 && (
        <span style={{ color: colors.textTertiary, fontSize: 12 }}>
          No conditions — this rule runs on every {trigger.label.toLowerCase()}.
        </span>
      )}
      {conditions.map((condition, index) => {
        const field = automationField(trigger, condition.path) ?? trigger.fields[0];
        return (
          <div
            key={index}
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 6 }}
          >
            <select
              aria-label="Condition field"
              value={condition.path}
              onChange={(e) => {
                const nextField = automationField(trigger, e.target.value);
                if (nextField) replace(index, conditionForField(e.target.value, nextField));
              }}
              style={input}
            >
              {trigger.fields.map((f) => (
                <option key={f.path} value={f.path}>
                  {f.label}
                </option>
              ))}
            </select>
            <select
              aria-label="Condition operator"
              value={condition.operator}
              onChange={(e) =>
                replace(
                  index,
                  conditionForOperator(condition, field, e.target.value as AutomationConditionOperator),
                )
              }
              style={input}
            >
              {field.operators.map((op) => (
                <option key={op} value={op}>
                  {OPERATOR_LABELS[op]}
                </option>
              ))}
            </select>
            {isPresenceOperator(condition.operator) ? (
              <span style={{ color: colors.textTertiary, fontSize: 12, alignSelf: "center" }}>
                (no value)
              </span>
            ) : (
              <ConditionValue
                field={field}
                value={condition.value}
                onChange={(value) => replace(index, { ...condition, value })}
                input={input}
              />
            )}
            <button
              type="button"
              aria-label="Remove condition"
              onClick={() => onChange(conditions.filter((_, i) => i !== index))}
              style={button}
            >
              ✕
            </button>
          </div>
        );
      })}
      <div>
        <button
          type="button"
          onClick={() => {
            const next = defaultConditionFor(trigger);
            if (next) onChange([...conditions, next]);
          }}
          style={button}
        >
          Add condition
        </button>
      </div>
    </div>
  );
}

function ConditionValue({
  field,
  value,
  onChange,
  input,
}: {
  field: AutomationFieldSpec;
  value: unknown;
  onChange: (value: string | number | boolean) => void;
  input: React.CSSProperties;
}) {
  if (field.type === "enum")
    return (
      <select
        aria-label="Condition value"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        style={input}
      >
        {(field.values ?? []).map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    );
  if (field.type === "boolean")
    return (
      <select
        aria-label="Condition value"
        value={value === true ? "true" : "false"}
        onChange={(e) => onChange(e.target.value === "true")}
        style={input}
      >
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  if (field.type === "number")
    return (
      <input
        aria-label="Condition value"
        type="number"
        value={typeof value === "number" ? value : 0}
        onChange={(e) => onChange(Number(e.target.value))}
        style={input}
      />
    );
  return (
    <input
      aria-label="Condition value"
      type="text"
      value={typeof value === "string" ? value : ""}
      onChange={(e) => onChange(e.target.value)}
      style={input}
    />
  );
}
