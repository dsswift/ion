import React from "react";
import type {
  AutomationActionConfigField,
  AutomationActionSpec,
  AutomationTriggerSpec,
} from "../../../shared/automation-catalog";
import { AUTOMATION_ACTIONS, automationAction } from "../../../shared/automation-catalog";
import type { AutomationAction } from "../../../shared/types-automation";
import { useColors } from "../../theme";
import { usePreferencesStore } from "../../preferences";
import { PILL_COLOR_PRESETS, PILL_ICON_PRESETS } from "../TabStripPillPresets";
import { SLASH_COMMANDS } from "../SlashCommandMenu";
import { defaultActionFor, actionTargetSatisfied } from "./automation-draft";

/**
 * One action row. The kind picker offers only catalog actions; each config
 * control is derived from the action spec, and the target is derived from the
 * trigger (never a raw worktree or tab id). A fixed directory is chosen with the
 * native picker only when the trigger cannot supply one.
 */
export function AutomationActionEditor({
  trigger,
  action,
  onChange,
  onRemove,
  input,
  button,
}: {
  trigger: AutomationTriggerSpec | undefined;
  action: AutomationAction;
  onChange: (next: AutomationAction) => void;
  onRemove: () => void;
  input: React.CSSProperties;
  button: React.CSSProperties;
}) {
  const colors = useColors();
  const spec = automationAction(action.kind);

  const setConfig = (key: string, value: unknown) => {
    const payload = { ...(action.payload ?? {}) };
    if (value === "" || value === undefined) delete payload[key];
    else payload[key] = value;
    onChange({ ...action, payload });
  };

  return (
    <div
      style={{
        display: "grid",
        gap: 6,
        padding: 8,
        border: `1px solid ${colors.containerBorder}`,
        borderRadius: 6,
      }}
    >
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <select
          aria-label="Action"
          value={action.kind}
          onChange={(e) => onChange(defaultActionFor(e.target.value))}
          style={{ ...input, flex: 1 }}
        >
          {AUTOMATION_ACTIONS.map((a) => (
            <option key={a.kind} value={a.kind}>
              {a.label}
            </option>
          ))}
        </select>
        <button type="button" aria-label="Remove action" onClick={onRemove} style={button}>
          ✕
        </button>
      </div>
      {spec && (
        <TargetRow trigger={trigger} spec={spec} action={action} onChange={onChange} button={button} />
      )}
      {spec?.config.map((configField) => (
        <ConfigControl
          key={configField.key}
          kind={action.kind}
          field={configField}
          value={action.payload?.[configField.key]}
          onChange={(value) => setConfig(configField.key, value)}
          input={input}
        />
      ))}
    </div>
  );
}

function TargetRow({
  trigger,
  spec,
  action,
  onChange,
  button,
}: {
  trigger: AutomationTriggerSpec | undefined;
  spec: AutomationActionSpec;
  action: AutomationAction;
  onChange: (next: AutomationAction) => void;
  button: React.CSSProperties;
}) {
  const colors = useColors();
  const line = (text: string, warn = false) => (
    <span style={{ color: warn ? colors.statusWarning : colors.textTertiary, fontSize: 11 }}>
      {text}
    </span>
  );
  const satisfied = trigger ? actionTargetSatisfied(spec, trigger, action) : false;

  if (spec.target === "none") return null;
  if (spec.target === "worktree")
    return satisfied
      ? line("Target: the triggering worktree")
      : line("This event cannot supply a worktree for this action", true);
  if (spec.target === "conversation")
    return satisfied
      ? line("Target: the triggering conversation")
      : line("This event cannot supply a conversation for this action", true);

  // directory
  if (trigger?.provides.worktree) return line("Target: the triggering worktree");
  const directory = typeof action.payload?.directory === "string" ? action.payload.directory : "";
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      {line(directory ? `Target directory: ${directory}` : "Choose a target directory", !directory)}
      <button
        type="button"
        onClick={() => {
          void window.ion.selectDirectory().then((picked) => {
            if (picked)
              onChange({ ...action, payload: { ...(action.payload ?? {}), directory: picked } });
          });
        }}
        style={button}
      >
        Choose…
      </button>
    </div>
  );
}

function ConfigControl({
  kind,
  field,
  value,
  onChange,
  input,
}: {
  kind: string;
  field: AutomationActionConfigField;
  value: unknown;
  onChange: (value: unknown) => void;
  input: React.CSSProperties;
}) {
  const colors = useColors();
  const tabGroups = usePreferencesStore((s) => s.tabGroups);
  const label = { color: colors.textSecondary, fontSize: 12, display: "grid", gap: 3 };

  const control = renderControl();
  return (
    <label style={label}>
      {field.label}
      {control}
    </label>
  );

  function renderControl(): React.ReactNode {
    // Renderer-sourced choice lists for tab decoration + slash commands.
    if (kind === "tab:set-color" && field.key === "color")
      return (
        <select
          aria-label={field.label}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          style={input}
        >
          {PILL_COLOR_PRESETS.map((preset) => (
            <option key={preset.label} value={preset.color ?? ""}>
              {preset.label}
            </option>
          ))}
        </select>
      );
    if (kind === "tab:set-icon" && field.key === "icon")
      return (
        <select
          aria-label={field.label}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          style={input}
        >
          {PILL_ICON_PRESETS.map((preset) => (
            <option key={preset.label} value={preset.icon ?? ""}>
              {preset.label}
            </option>
          ))}
        </select>
      );
    if (kind === "tab:set-group" && field.key === "groupId")
      return (
        <select
          aria-label={field.label}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          style={input}
        >
          <option value="">No group</option>
          {tabGroups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.label}
            </option>
          ))}
        </select>
      );
    if (kind === "conversation:slash" && field.key === "command")
      return (
        <>
          <input
            aria-label={field.label}
            list="automation-slash-commands"
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
            style={input}
            placeholder="align"
          />
          <datalist id="automation-slash-commands">
            {SLASH_COMMANDS.map((c) => (
              <option key={c.command} value={c.command.replace(/^\//, "")} />
            ))}
          </datalist>
        </>
      );
    if (field.type === "enum")
      return (
        <select
          aria-label={field.label}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          style={input}
        >
          {!field.required && <option value="">— any —</option>}
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
          aria-label={field.label}
          value={value === true ? "true" : "false"}
          onChange={(e) => onChange(e.target.value === "true")}
          style={input}
        >
          <option value="false">No</option>
          <option value="true">Yes</option>
        </select>
      );
    if (field.type === "number")
      return (
        <input
          aria-label={field.label}
          type="number"
          value={typeof value === "number" ? value : 0}
          onChange={(e) => onChange(Number(e.target.value))}
          style={input}
        />
      );
    return (
      <input
        aria-label={field.label}
        type="text"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        style={input}
      />
    );
  }
}
