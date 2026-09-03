import React, { useEffect, useState } from "react";
import type {
  AutomationDefinition,
  AutomationHistoryEntry,
  AutomationListing,
  AutomationSourceEntry,
  AutomationStep,
} from "../../../shared/types-automation";
import { deriveEnterpriseAutomationPolicy } from "../../../shared/types-automation";
import {
  automationAction,
  automationTrigger,
} from "../../../shared/automation-catalog";
import type { EnterprisePolicy } from "../../../shared/types-engine";
import { rInfo, rWarn } from "../../rendererLogger";
import { useColors } from "../../theme";
import { Tooltip } from "../git/Tooltip";
import { AutomationEditor } from "./AutomationEditor";
import { AutomationActivity } from "./AutomationActivity";
import { AUTOMATION_TEMPLATES } from "./automation-editor-helpers";
import { SettingHeading } from "./SettingHeading";
import { SettingSection } from "./SettingSection";

function blankAutomation(): AutomationDefinition {
  const now = new Date().toISOString();
  return {
    id: "",
    name: "",
    enabled: true,
    trigger: { kind: "event", event: "" },
    steps: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * The Desktop Automation category: a source-aware list plus the inline
 * Automation Editor. The main process owns evaluation and persistence; this
 * screen only reads the listing and requests one user mutation at a time.
 */
export function AutomationCategory() {
  const colors = useColors();
  const [listing, setListing] = useState<AutomationListing | null>(null);
  const [history, setHistory] = useState<AutomationHistoryEntry[]>([]);
  const [editing, setEditing] = useState<AutomationDefinition | null>(null);
  const [aiAuthorized, setAiAuthorized] = useState(false);
  const [projectPath, setProjectPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let active = true;
    void Promise.all([
      window.ion.automationListing(projectPath || undefined),
      window.ion.automationHistory(),
      window.ion.getEnterprisePolicyFull(),
    ])
      .then(([nextListing, nextHistory, policy]) => {
        if (!active) return;
        setListing(nextListing);
        setHistory(nextHistory);
        setAiAuthorized(
          deriveEnterpriseAutomationPolicy(policy as EnterprisePolicy | null)
            ?.authorizeAiActions === true,
        );
      })
      .catch((loadError) => {
        if (!active) return;
        setError(String(loadError));
        rWarn("automation.settings", "automation settings load failed", {
          error: String(loadError),
        });
      });
    return () => {
      active = false;
    };
  }, [projectPath, refreshTick]);

  const refresh = () => setRefreshTick((t) => t + 1);

  const save = (definition: AutomationDefinition) => {
    setError(null);
    void window.ion
      .automationUpsert(definition)
      .then((result) => {
        if (!result.ok) {
          setError(result.error ?? "Could not save workflow");
          rWarn("automation.settings", "automation save rejected", {
            error: result.error ?? "",
          });
          return;
        }
        rInfo("automation.settings", "automation workflow saved", {
          automation_id: result.definition?.id ?? definition.id,
        });
        setEditing(null);
        refresh();
      })
      .catch((saveError) => {
        setError(String(saveError));
        rWarn("automation.settings", "automation save failed", {
          error: String(saveError),
        });
      });
  };

  const remove = (id: string) => {
    void window.ion.automationDelete(id).then((result) => {
      if (!result.ok) setError(result.error ?? "Could not delete workflow");
      else refresh();
    });
  };

  const duplicate = (id: string) => {
    void window.ion
      .automationDuplicate(id, projectPath || undefined)
      .then((result) => {
        if (!result.ok || !result.definition) {
          setError(result.error ?? "Could not duplicate workflow");
          return;
        }
        // Open the fresh user copy for editing immediately.
        setEditing(result.definition);
        refresh();
      });
  };

  const toggleUser = (definition: AutomationDefinition) =>
    save({ ...definition, enabled: !definition.enabled });

  const toggleProject = (id: string, enabled: boolean) => {
    void window.ion
      .setProjectAutomationEnabled(projectPath, id, enabled)
      .then((result) => {
        if (!result.ok) setError(result.error ?? "Could not update project workflow");
        else refresh();
      });
  };

  return (
    <>
      <SettingHeading first>Desktop Automation</SettingHeading>
      <SettingSection description="Workflows watch for desktop events, check optional conditions, then run actions. They and their activity history stay on this desktop.">
        {error && (
          <div role="alert" style={{ color: colors.statusError, fontSize: 12, marginBottom: 8 }}>
            {error}
          </div>
        )}
        {listing?.locked && (
          <div style={{ color: colors.statusWarning, fontSize: 12, marginBottom: 8 }}>
            Enterprise policy locks changes to your workflows.
          </div>
        )}
        <label style={labelStyle(colors)}>
          <Tooltip text="Project workflows come from this project's .ion/automation folder. Leave blank to manage only your desktop workflows.">
            <span style={helpLabelStyle(colors)}>Project directory (optional)</span>
          </Tooltip>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              aria-label="Automation project directory"
              value={projectPath}
              onChange={(e) => setProjectPath(e.target.value)}
              placeholder="/path/to/project"
              style={{ ...inputStyle(colors), flex: 1 }}
            />
            {projectPath && (
              <button type="button" onClick={() => setProjectPath("")} style={buttonStyle(colors)}>
                Clear
              </button>
            )}
          </div>
        </label>

        <div style={toolbarStyle}>
          <span style={{ color: aiAuthorized ? colors.accent : colors.statusWarning, fontSize: 12 }}>
            {aiAuthorized ? "AI automation authorized" : "AI automation needs confirmation"}
          </span>
          {!listing?.locked && (
            <button type="button" onClick={() => setEditing(blankAutomation())} style={buttonStyle(colors)}>
              Create workflow
            </button>
          )}
        </div>

        {/* New-definition editor: shown above the list when creating from scratch.
            Existing-definition editors expand inline after their own card below. */}
        {editing?.id === "" && (
          <div style={{ display: "grid", gap: 6, marginBottom: 4 }}>
            <AutomationEditor definition={editing} onCancel={() => setEditing(null)} onSave={save} />
            {!editing.trigger.event && (
              <div style={{ display: "grid", gap: 5 }}>
                <span style={{ color: colors.textSecondary, fontSize: 12 }}>Start from a template</span>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {AUTOMATION_TEMPLATES.map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      onClick={() => setEditing(template.definition())}
                      style={buttonStyle(colors)}
                    >
                      Use {template.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Each card expands its own editor inline. Only one card is editable at a time. */}
        <div style={{ display: "grid", gap: 6 }}>
          {listing === null && <div style={emptyStyle(colors)}>Loading workflows…</div>}
          {listing?.entries.length === 0 && !editing && (
            <div style={emptyStyle(colors)}>No workflows yet. Create one, or start from a template.</div>
          )}
          {listing?.entries.map((entry) => (
            <React.Fragment key={`${entry.source}:${entry.definition.id}`}>
              <WorkflowCard
                entry={entry}
                locked={listing.locked}
                editLocked={editing !== null && editing.id !== entry.definition.id}
                onEdit={() => setEditing(entry.definition)}
                onDuplicate={() => duplicate(entry.definition.id)}
                onDelete={() => remove(entry.definition.id)}
                onToggleUser={() => toggleUser(entry.definition)}
                onToggleProject={(enabled) => toggleProject(entry.definition.id, enabled)}
              />
              {editing?.id === entry.definition.id && (
                <AutomationEditor definition={editing} onCancel={() => setEditing(null)} onSave={save} />
              )}
            </React.Fragment>
          ))}
        </div>
      </SettingSection>

      <SettingHeading>Recent activity</SettingHeading>
      <SettingSection description="Select an activity row to see the stored evaluation path. Older runs without trace data still show their final outcome.">
        <AutomationActivity
          history={history}
          nameFor={(id) =>
            listing?.entries.find((e) => e.definition.id === id)?.definition.name ?? id
          }
        />
      </SettingSection>
    </>
  );
}

function WorkflowCard({
  entry,
  locked,
  editLocked,
  onEdit,
  onDuplicate,
  onDelete,
  onToggleUser,
  onToggleProject,
}: {
  entry: AutomationSourceEntry;
  locked: boolean;
  editLocked: boolean;
  onEdit(): void;
  onDuplicate(): void;
  onDelete(): void;
  onToggleUser(): void;
  onToggleProject(enabled: boolean): void;
}) {
  const colors = useColors();
  const { definition, source } = entry;
  const steps = definition.steps ?? definition.actions ?? [];
  const isUser = source === "user";
  const enabled = source === "project" ? !entry.locallyDisabled : definition.enabled;
  return (
    <div
      style={{
        display: "grid",
        gap: 6,
        padding: 9,
        border: `1px solid ${colors.containerBorder}`,
        borderRadius: 6,
        background: colors.surfaceSecondary,
        opacity: entry.effective ? 1 : 0.7,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          aria-label={`Enable ${definition.name}`}
          type="checkbox"
          checked={enabled}
          disabled={locked || source === "enterprise" || source === "built-in"}
          onChange={() => (isUser ? onToggleUser() : onToggleProject(!enabled))}
        />
        <strong style={{ flex: 1, color: colors.textPrimary, fontSize: 13 }}>{definition.name}</strong>
        <span style={tagStyle(colors)}>{sourceLabel(source)}</span>
        {entry.overriddenBy && (
          <span style={tagStyle(colors)}>overridden by {sourceLabel(entry.overriddenBy)}</span>
        )}
        {isUser && !locked && (
          <button
            type="button"
            onClick={onEdit}
            disabled={editLocked}
            style={{ ...linkStyle(colors), opacity: editLocked ? 0.4 : 1 }}
          >
            Edit
          </button>
        )}
        {!locked && (
          <button type="button" onClick={onDuplicate} style={linkStyle(colors)}>
            Duplicate
          </button>
        )}
        {isUser && !locked && (
          <button
            type="button"
            onClick={onDelete}
            style={{ ...linkStyle(colors), color: colors.statusError }}
          >
            Delete
          </button>
        )}
      </div>
      <div style={{ display: "grid", gap: 3, color: colors.textSecondary, fontSize: 12 }}>
        <span>
          <strong>When:</strong> {automationTrigger(definition.trigger.event)?.label ?? definition.trigger.event}
        </span>
        <span>
          <strong>Then:</strong> {actionSummary(steps)}
        </span>
      </div>
    </div>
  );
}

function sourceLabel(source: AutomationSourceEntry["source"]): string {
  switch (source) {
    case "user":
      return "You";
    case "project":
      return "Project";
    case "enterprise":
      return "Enterprise";
    case "built-in":
      return "Built-in";
  }
}

function actionSummary(steps: AutomationStep[]): string {
  if (steps.length === 0) return "No actions configured.";
  return steps
    .map((step) => ("type" in step ? "choose a branch" : automationAction(step.kind)?.label ?? step.kind))
    .join(", ");
}

function labelStyle(colors: ReturnType<typeof useColors>): React.CSSProperties {
  return { display: "grid", gap: 3, color: colors.textSecondary, fontSize: 12, marginBottom: 8 };
}
function inputStyle(colors: ReturnType<typeof useColors>): React.CSSProperties {
  return {
    background: colors.surfacePrimary,
    color: colors.textPrimary,
    border: `1px solid ${colors.containerBorder}`,
    borderRadius: 5,
    padding: "5px 7px",
  };
}
function buttonStyle(colors: ReturnType<typeof useColors>): React.CSSProperties {
  return {
    background: colors.surfaceSecondary,
    color: colors.textSecondary,
    border: `1px solid ${colors.containerBorder}`,
    borderRadius: 5,
    padding: "5px 8px",
    fontSize: 12,
  };
}
function linkStyle(colors: ReturnType<typeof useColors>): React.CSSProperties {
  return {
    background: "transparent",
    border: "none",
    color: colors.accent,
    fontSize: 12,
    cursor: "pointer",
    padding: 0,
  };
}
function emptyStyle(colors: ReturnType<typeof useColors>): React.CSSProperties {
  return { color: colors.textTertiary, fontSize: 12 };
}
function helpLabelStyle(colors: ReturnType<typeof useColors>): React.CSSProperties {
  return {
    color: colors.textTertiary,
    fontSize: 11,
    borderBottom: `1px dotted ${colors.textTertiary}`,
    cursor: "help",
  };
}
function tagStyle(colors: ReturnType<typeof useColors>): React.CSSProperties {
  return {
    color: colors.textTertiary,
    fontSize: 11,
    border: `1px solid ${colors.containerBorder}`,
    borderRadius: 10,
    padding: "1px 5px",
  };
}

const toolbarStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
  alignItems: "center",
  marginBottom: 8,
};
