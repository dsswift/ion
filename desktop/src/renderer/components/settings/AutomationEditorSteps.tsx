import React from "react";
import type { AutomationTriggerSpec } from "../../../shared/automation-catalog";
import type { AutomationAction } from "../../../shared/types-automation";
import { useColors } from "../../theme";
import { AutomationActionEditor } from "./AutomationActionEditor";
import { defaultActionFor } from "./automation-draft";

/**
 * Orchestrates the ordered list of plain actions. Each row is a catalog-driven
 * AutomationActionEditor. Branch steps a rule may already contain are preserved
 * by the editor and reported here as read-only, so the guided form never
 * silently flattens a construct it cannot represent.
 */
export function StepsEditor({
  trigger,
  actions,
  onChange,
  branchCount,
  input,
  button,
}: {
  trigger: AutomationTriggerSpec | undefined;
  actions: AutomationAction[];
  onChange: (next: AutomationAction[]) => void;
  branchCount: number;
  input: React.CSSProperties;
  button: React.CSSProperties;
}) {
  const colors = useColors();
  const heading = { color: colors.textSecondary, fontSize: 12, fontWeight: 600 };

  const replace = (index: number, next: AutomationAction) =>
    onChange(actions.map((a, i) => (i === index ? next : a)));
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= actions.length) return;
    const next = [...actions];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <span style={heading}>Then</span>
      {actions.length === 0 && (
        <span style={{ color: colors.textTertiary, fontSize: 12 }}>
          No actions yet. Add at least one for this rule to do anything.
        </span>
      )}
      {actions.map((action, index) => (
        <div key={index} style={{ display: "grid", gap: 4 }}>
          <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
            <button
              type="button"
              aria-label="Move action up"
              disabled={index === 0}
              onClick={() => move(index, -1)}
              style={button}
            >
              ↑
            </button>
            <button
              type="button"
              aria-label="Move action down"
              disabled={index === actions.length - 1}
              onClick={() => move(index, 1)}
              style={button}
            >
              ↓
            </button>
          </div>
          <AutomationActionEditor
            trigger={trigger}
            action={action}
            onChange={(next) => replace(index, next)}
            onRemove={() => onChange(actions.filter((_, i) => i !== index))}
            input={input}
            button={button}
          />
        </div>
      ))}
      <div>
        <button type="button" onClick={() => onChange([...actions, defaultActionFor("record")])} style={button}>
          Add action
        </button>
      </div>
      {branchCount > 0 && (
        <span style={{ color: colors.statusWarning, fontSize: 11 }}>
          This rule also has {branchCount} conditional branch
          {branchCount === 1 ? "" : "es"} kept read-only here; edit them in the
          JSON file.
        </span>
      )}
    </div>
  );
}
