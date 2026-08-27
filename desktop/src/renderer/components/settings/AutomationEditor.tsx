import React, { useEffect, useMemo, useState } from "react";
import type {
  AutomationCondition,
  AutomationDefinition,
  EnterpriseAutomationPolicy,
} from "../../../shared/types-automation";
import { useColors } from "../../theme";
import { Tooltip } from "../git/Tooltip";
import { countAiActions, newId, normalize } from "./automation-editor-helpers";
import { EVENT_OPTIONS } from "./automation-editor-options";
import { ConditionRows, StepsEditor } from "./AutomationEditorSteps";
export { AUTOMATION_TEMPLATES } from "./automation-editor-helpers";

export function AutomationEditor({
  definition: source,
  onCancel,
  onSave,
  aiAuthorized = false,
}: {
  definition: AutomationDefinition;
  onCancel: () => void;
  onSave: (definition: AutomationDefinition) => void;
  aiAuthorized?: boolean;
}) {
  const colors = useColors();
  const [definition, setDefinition] = useState(() => normalize(source));
  useEffect(() => setDefinition(normalize(source)), [source]);
  const actionCount = useMemo(
    () => countAiActions(definition.steps ?? []),
    [definition.steps],
  );
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
  const update = (patch: Partial<AutomationDefinition>) =>
    setDefinition((current) => ({ ...current, ...patch }));
  const conditions = (definition.condition?.all ?? []).filter(
    (item): item is AutomationCondition => "path" in item,
  );
  const save = () =>
    onSave({
      ...definition,
      id: definition.id.trim() || `user.automation.${newId()}`,
      name: definition.name.trim() || "Untitled automation",
      trigger: { kind: "event", event: definition.trigger.event.trim() },
      updatedAt: new Date().toISOString(),
      actions: undefined,
    });

  return (
    <div
      aria-label="Automation editor"
      style={{
        display: "grid",
        gap: 10,
        padding: "10px 0",
        borderTop: `1px solid ${colors.containerBorder}`,
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <label style={{ color: colors.textSecondary, fontSize: 12 }}>
          Name
          <input
            aria-label="Automation name"
            value={definition.name}
            onChange={(event) => update({ name: event.target.value })}
            style={{ ...input, display: "block", width: "100%", marginTop: 3 }}
          />
        </label>
        <label style={{ color: colors.textSecondary, fontSize: 12 }}>
          <Tooltip text="Choose the desktop event that starts this workflow. The workflow then checks its conditions and runs its actions.">
            <span style={{ borderBottom: `1px dotted ${colors.textTertiary}`, cursor: 'help' }}>When this happens</span>
          </Tooltip>
          <select
            aria-label="Automation trigger"
            value={definition.trigger.event}
            onChange={(event) =>
              update({ trigger: { kind: "event", event: event.target.value } })
            }
            style={{ ...input, display: "block", width: "100%", marginTop: 3 }}
          >
            <option value="">Choose an event</option>
            {EVENT_OPTIONS.map((event) => (
              <option key={event.value} value={event.value}>{event.label}</option>
            ))}
          </select>
        </label>
      </div>
      <label style={{ color: colors.textSecondary, fontSize: 12 }}>
        <input
          aria-label="Enable automation"
          type="checkbox"
          checked={definition.enabled}
          onChange={() => update({ enabled: !definition.enabled })}
        />{" "}
        Enabled
      </label>
      <ConditionRows
        conditions={conditions}
        onChange={(all) =>
          update({ condition: all.length ? { all } : undefined })
        }
        input={input}
        button={button}
      />
      <StepsEditor
        steps={definition.steps ?? []}
        onChange={(steps) => update({ steps })}
        input={input}
        button={button}
      />
      <AiAuthorizationSummary
        actionCount={actionCount}
        authorized={aiAuthorized}
      />
      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="button"
          onClick={save}
          disabled={!definition.trigger.event.trim()}
          style={{
            ...button,
            background: colors.accent,
            color: colors.textOnAccent,
          }}
        >
          Save automation
        </button>
        <button type="button" onClick={onCancel} style={button}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function AiAuthorizationBadge({
  policy,
}: {
  policy: EnterpriseAutomationPolicy | undefined;
}) {
  const colors = useColors();
  const authorized = policy?.authorizeAiActions === true;
  return (
    <span
      aria-label="AI automation authorization"
      style={{
        color: authorized ? colors.accent : colors.statusWarning,
        fontSize: 12,
      }}
    >
      {authorized
        ? "AI automation authorized"
        : "AI automation needs confirmation"}
    </span>
  );
}

function AiAuthorizationSummary({
  actionCount,
  authorized,
}: {
  actionCount: number;
  authorized: boolean;
}) {
  return (
    <div style={{ fontSize: 12 }}>
      <AiAuthorizationBadge
        policy={authorized ? { authorizeAiActions: true } : undefined}
      />
      {actionCount > 0 && (
        <span>{` · ${actionCount} AI action${actionCount === 1 ? "" : "s"} creates a new conversation with shown prompt.`}</span>
      )}
    </div>
  );
}
