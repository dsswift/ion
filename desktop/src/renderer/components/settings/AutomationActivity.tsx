import React, { useState } from "react";
import type {
  AutomationConditionDecisionResult,
  AutomationEvaluationTrace,
  AutomationHistoryEntry,
  AutomationStepDecision,
  AutomationValue,
} from "../../../shared/types-automation";
import {
  automationAction,
  automationTrigger,
} from "../../../shared/automation-catalog";
import { useColors } from "../../theme";

function eventLabel(event: string): string {
  return automationTrigger(event)?.label ?? event;
}
function actionLabel(kind: string): string {
  return automationAction(kind)?.label ?? kind;
}

/** Recent automation activity with the stored evaluation trace. Read-only. */
export function AutomationActivity({
  history,
  nameFor,
}: {
  history: AutomationHistoryEntry[];
  nameFor: (automationId: string) => string;
}) {
  const colors = useColors();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  if (history.length === 0)
    return <div style={{ color: colors.textTertiary, fontSize: 12 }}>No workflow activity yet.</div>;
  return (
    <div style={{ display: "grid", gap: 5 }}>
      {history
        .slice(-10)
        .reverse()
        .map((item) => (
          <ActivityRow
            key={item.id}
            item={item}
            workflowName={nameFor(item.automationId)}
            expanded={expandedId === item.id}
            onToggle={() => setExpandedId((c) => (c === item.id ? null : item.id))}
          />
        ))}
    </div>
  );
}

function ActivityRow({
  item,
  workflowName,
  expanded,
  onToggle,
}: {
  item: AutomationHistoryEntry;
  workflowName: string;
  expanded: boolean;
  onToggle(): void;
}) {
  const colors = useColors();
  const outcomeColor =
    item.outcome === "succeeded"
      ? colors.successFg
      : item.outcome === "failed"
        ? colors.statusError
        : colors.statusWarning;
  return (
    <div style={{ border: `1px solid ${colors.containerBorder}`, borderRadius: 6 }}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        style={{
          width: "100%",
          display: "grid",
          gridTemplateColumns: "1fr auto",
          gap: 8,
          padding: "7px 8px",
          border: "none",
          background: "transparent",
          color: colors.textSecondary,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{ display: "grid", gap: 2 }}>
          <strong style={{ color: colors.textPrimary, fontSize: 12 }}>{workflowName}</strong>
          <span style={{ fontSize: 11 }}>
            Trigger: {eventLabel(item.eventType)} · {new Date(item.finishedAt).toLocaleString()}
          </span>
        </span>
        <span style={{ color: outcomeColor, fontSize: 12 }}>
          {expanded ? "Hide" : "Show"} {item.outcome}
        </span>
      </button>
      {expanded && (
        <div style={{ borderTop: `1px solid ${colors.containerBorder}`, padding: 8 }}>
          {item.trace ? (
            <TraceView trace={item.trace} />
          ) : (
            <span style={{ color: colors.textTertiary, fontSize: 12 }}>
              This older activity record has no step-by-step trace.
            </span>
          )}
          {item.error && (
            <div style={{ color: colors.statusError, fontSize: 12, marginTop: 7 }}>
              Error: {item.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TraceView({ trace }: { trace: AutomationEvaluationTrace }) {
  const colors = useColors();
  const rows = [
    `Trigger received: ${eventLabel(trace.trigger.eventType)}`,
    `Conditions: ${describeCondition(trace.condition)}`,
    `Causation: ${describeCausation(trace)}`,
    ...trace.steps.flatMap(describeStep),
  ];
  return (
    <ol
      style={{
        display: "grid",
        gap: 5,
        margin: 0,
        paddingLeft: 20,
        color: colors.textSecondary,
        fontSize: 12,
      }}
    >
      {rows.map((row, index) => (
        <li key={`${index}-${row}`}>{row}</li>
      ))}
    </ol>
  );
}

function describeStep(step: AutomationStepDecision): string[] {
  if (step.type === "action")
    return [`Action ${step.outcome}: ${actionLabel(step.kind)}${step.error ? ` (${step.error})` : ""}`];
  return [
    `Branch selected: ${step.selected === "then" ? "Then actions" : "Else actions"} (${describeGroup(step.condition)})`,
    ...step.steps.flatMap(describeStep),
  ];
}

function describeCondition(decision: AutomationConditionDecisionResult): string {
  if (decision.type === "none") return "No conditions configured; workflow is eligible.";
  return describeDecisionTree(decision);
}

function describeGroup(
  decision: Extract<AutomationConditionDecisionResult, { type: "group" }>,
): string {
  const parts = [...decision.all.map(describeDecisionTree), ...decision.any.map(describeDecisionTree)];
  return `${decision.matched ? "Matched" : "Did not match"}${parts.length ? `: ${parts.join("; ")}` : ""}`;
}

function describeDecisionTree(
  decision: Exclude<AutomationConditionDecisionResult, { type: "none" }>,
): string {
  return decision.type === "group" ? describeGroup(decision) : describeLeaf(decision);
}

function describeLeaf(
  decision: Extract<AutomationConditionDecisionResult, { type: "condition" }>,
): string {
  const expected =
    decision.expected === undefined ? "" : ` ${decision.operator} ${formatValue(decision.expected)}`;
  return `${decision.path}${expected} (${decision.matched ? "matched" : `was ${formatValue(decision.actual)}`})`;
}

function describeCausation(trace: AutomationEvaluationTrace): string {
  switch (trace.causation.decision) {
    case "continued":
      return "Allowed to run.";
    case "cycle":
      return "Skipped to prevent an automation cycle.";
    case "max-depth":
      return "Skipped because the automation chain reached its depth limit.";
    default:
      return "Not evaluated after the condition did not match.";
  }
}

function formatValue(value: AutomationValue | undefined): string {
  if (value === undefined) return "no value";
  return typeof value === "string" ? value : JSON.stringify(value);
}
