import React, { useEffect, useState } from 'react'
import type {
  AutomationConditionDecisionResult,
  AutomationDefinition,
  AutomationEvaluationTrace,
  AutomationHistoryEntry,
  AutomationStep,
  AutomationStepDecision,
  AutomationValue,
} from '../../../shared/types-automation'
import { deriveEnterpriseAutomationPolicy } from '../../../shared/types-automation'
import type { EnterprisePolicy } from '../../../shared/types-engine'
import { rInfo, rWarn } from '../../rendererLogger'
import { useColors } from '../../theme'
import { Tooltip } from '../git/Tooltip'
import { AutomationEditor, AUTOMATION_TEMPLATES, AiAuthorizationBadge } from './AutomationEditor'
import { eventLabel, actionLabel } from './automation-editor-options'
import { SettingHeading } from './SettingHeading'
import { SettingSection } from './SettingSection'

function blankAutomation(): AutomationDefinition {
  const now = new Date().toISOString()
  return {
    id: '',
    name: '',
    enabled: true,
    trigger: { kind: 'event', event: '' },
    steps: [],
    createdAt: now,
    updatedAt: now,
  }
}

/** Desktop-local editor for declarative workflows. Main process remains evaluator. */
export function AutomationCategory() {
  const colors = useColors()
  const [definitions, setDefinitions] = useState<AutomationDefinition[] | null>(null)
  const [history, setHistory] = useState<AutomationHistoryEntry[]>([])
  const [editing, setEditing] = useState<AutomationDefinition | null>(null)
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [aiAuthorized, setAiAuthorized] = useState(false)
  const [projectPath, setProjectPath] = useState('')
  const [projectIds, setProjectIds] = useState<string[]>([])

  useEffect(() => {
    let active = true
    void Promise.all([
      window.ion.automationList(projectPath || undefined),
      window.ion.automationHistory(),
      window.ion.getEnterprisePolicyFull(),
      projectPath ? window.ion.automationProjectIds(projectPath) : Promise.resolve([]),
    ])
      .then(([nextDefinitions, nextHistory, policy, nextProjectIds]) => {
        if (!active) return
        setDefinitions(nextDefinitions)
        setHistory(nextHistory)
        setAiAuthorized(
          deriveEnterpriseAutomationPolicy(policy as EnterprisePolicy | null)
            ?.authorizeAiActions === true,
        )
        setProjectIds(nextProjectIds)
      })
      .catch((loadError) => {
        if (!active) return
        setError(String(loadError))
        rWarn('automation.settings', 'automation settings load failed', {
          error: String(loadError),
        })
      })
    return () => {
      active = false
    }
  }, [projectPath])

  const persist = (
    next: AutomationDefinition[],
    message: string,
    automationId?: string,
  ) => {
    const previous = definitions
    setDefinitions(next)
    setError(null)
    void window.ion.automationSave(next)
      .then((result) => {
        if (result.ok) {
          rInfo('automation.settings', message, {
            automation_id: automationId ?? '',
            count: next.length,
          })
          return
        }
        setDefinitions(previous)
        setError(result.error ?? 'Could not save workflow')
        rWarn('automation.settings', 'automation setting save rejected', {
          automation_id: automationId ?? '',
          error: result.error ?? '',
        })
      })
      .catch((saveError) => {
        setDefinitions(previous)
        setError(String(saveError))
        rWarn('automation.settings', 'automation setting save failed', {
          automation_id: automationId ?? '',
          error: String(saveError),
        })
      })
  }

  const toggle = (definition: AutomationDefinition) => {
    if (projectIds.includes(definition.id) && projectPath) {
      void window.ion
        .setProjectAutomationEnabled(projectPath, definition.id, !definition.enabled)
        .then((result) => {
          if (!result.ok) {
            setError(result.error ?? 'Could not update project workflow')
            return
          }
          setDefinitions((current) =>
            current?.map((item) =>
              item.id === definition.id
                ? { ...item, enabled: !item.enabled }
                : item,
            ) ?? null,
          )
        })
        .catch((toggleError) => setError(String(toggleError)))
      return
    }
    persist(
      (definitions ?? []).map((item) =>
        item.id === definition.id
          ? { ...item, enabled: !item.enabled, updatedAt: new Date().toISOString() }
          : item,
      ),
      'automation workflow saved',
      definition.id,
    )
  }

  const save = (definition: AutomationDefinition) => {
    const exists = (definitions ?? []).some((item) => item.id === definition.id)
    persist(
      exists
        ? (definitions ?? []).map((item) =>
            item.id === definition.id ? definition : item,
          )
        : [...(definitions ?? []), definition],
      'automation workflow saved',
      definition.id,
    )
    setEditing(null)
  }

  return (
    <>
      <SettingHeading first>Automation</SettingHeading>
      <SettingSection description="Workflows watch for desktop events, check optional conditions, then run actions. They and their activity history stay on this desktop.">
        {error && (
          <div role="alert" style={{ color: colors.statusError, fontSize: 12, marginBottom: 8 }}>
            {error}
          </div>
        )}
        <label style={labelStyle(colors)}>
          <Tooltip text="Project workflows come from this project's .ion/automation folder. Leave this blank to manage only desktop workflows.">
            <span style={helpLabelStyle(colors)}>Project directory (optional)</span>
          </Tooltip>
          <input
            aria-label="Automation project directory"
            value={projectPath}
            onChange={(event) => setProjectPath(event.target.value)}
            placeholder="/path/to/project"
            style={inputStyle(colors)}
          />
        </label>

        <div style={toolbarStyle}>
          <AiAuthorizationBadge
            policy={aiAuthorized ? { authorizeAiActions: true } : undefined}
          />
          <button
            type="button"
            onClick={() => setEditing(blankAutomation())}
            style={buttonStyle(colors)}
          >
            Create workflow
          </button>
        </div>

        <div style={{ display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <strong style={{ color: colors.textPrimary, fontSize: 13 }}>Your workflows</strong>
            <Tooltip text="Each card is one saved workflow. Select a card or its Edit button to change its trigger, conditions, or actions.">
              <span style={helpLabelStyle(colors)}>What is this?</span>
            </Tooltip>
          </div>
          {definitions === null && (
            <div style={emptyStyle(colors)}>Loading workflows…</div>
          )}
          {definitions?.length === 0 && !editing && (
            <div style={emptyStyle(colors)}>
              No workflows yet. Create one, or start from a template below.
            </div>
          )}
          {definitions?.map((definition) => (
            <WorkflowCard
              key={definition.id}
              definition={definition}
              project={projectIds.includes(definition.id)}
              onEdit={() => setEditing(definition)}
              onToggle={() => toggle(definition)}
            />
          ))}
        </div>

        {editing && (
          <AutomationEditor
            definition={editing}
            aiAuthorized={aiAuthorized}
            onCancel={() => setEditing(null)}
            onSave={save}
          />
        )}
        {!editing && (
          <div style={{ display: 'grid', gap: 5, marginTop: 10 }}>
            <span style={{ color: colors.textSecondary, fontSize: 12 }}>
              Start from a template
            </span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
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
      </SettingSection>

      <SettingHeading>Recent activity</SettingHeading>
      <SettingSection description="Select an activity row to see the stored evaluation path. Older runs without trace data still show their final outcome.">
        {history.length === 0 ? (
          <div style={emptyStyle(colors)}>No workflow activity yet.</div>
        ) : (
          <div style={{ display: 'grid', gap: 5 }}>
            {history.slice(-10).reverse().map((item) => (
              <ActivityRow
                key={item.id}
                item={item}
                workflowName={definitions?.find((definition) => definition.id === item.automationId)?.name ?? item.automationId}
                expanded={expandedHistoryId === item.id}
                onToggle={() =>
                  setExpandedHistoryId((current) =>
                    current === item.id ? null : item.id,
                  )
                }
              />
            ))}
          </div>
        )}
      </SettingSection>
    </>
  )
}

function WorkflowCard({
  definition,
  project,
  onEdit,
  onToggle,
}: {
  definition: AutomationDefinition
  project: boolean
  onEdit(): void
  onToggle(): void
}) {
  const colors = useColors()
  const steps = definition.steps ?? definition.actions ?? []
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Edit workflow ${definition.name}`}
      onClick={onEdit}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onEdit()
        }
      }}
      style={{
        display: 'grid',
        gap: 6,
        padding: 9,
        border: `1px solid ${colors.containerBorder}`,
        borderRadius: 6,
        background: colors.surfaceSecondary,
        cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          aria-label={`Enable ${definition.name}`}
          type="checkbox"
          checked={definition.enabled}
          onClick={(event) => event.stopPropagation()}
          onChange={onToggle}
        />
        <strong style={{ flex: 1, color: colors.textPrimary, fontSize: 13 }}>
          {definition.name}
        </strong>
        {project && <span style={tagStyle(colors)}>Project</span>}
        <span style={tagStyle(colors)}>{definition.enabled ? 'Enabled' : 'Paused'}</span>
        <span style={{ color: colors.accent, fontSize: 12 }}>Edit</span>
      </div>
      <div style={{ display: 'grid', gap: 3, color: colors.textSecondary, fontSize: 12 }}>
        <span><strong>When:</strong> {eventLabel(definition.trigger.event)}</span>
        <span><strong>Then:</strong> {actionSummary(steps)}</span>
      </div>
      {definition.id === 'builtin.worktree-pin-advance-stage' && (
        <div style={{ color: colors.textTertiary, fontSize: 11, lineHeight: 1.35 }}>
          When an <strong>Issue found</strong> worktree receives new committed work in the integration bench, move it to <strong>Needs testing</strong>.
        </div>
      )}
    </div>
  )
}

function ActivityRow({
  item,
  workflowName,
  expanded,
  onToggle,
}: {
  item: AutomationHistoryEntry
  workflowName: string
  expanded: boolean
  onToggle(): void
}) {
  const colors = useColors()
  const outcomeColor = item.outcome === 'succeeded'
    ? colors.successFg
    : item.outcome === 'failed'
      ? colors.statusError
      : colors.statusWarning
  return (
    <div style={{ border: `1px solid ${colors.containerBorder}`, borderRadius: 6 }}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        style={{
          width: '100%',
          display: 'grid',
          gridTemplateColumns: '1fr auto',
          gap: 8,
          padding: '7px 8px',
          border: 'none',
          background: 'transparent',
          color: colors.textSecondary,
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span style={{ display: 'grid', gap: 2 }}>
          <strong style={{ color: colors.textPrimary, fontSize: 12 }}>{workflowName}</strong>
          <span style={{ fontSize: 11 }}>Trigger: {eventLabel(item.eventType)} · {new Date(item.finishedAt).toLocaleString()}</span>
        </span>
        <span style={{ color: outcomeColor, fontSize: 12 }}>{expanded ? 'Hide' : 'Show'} {item.outcome}</span>
      </button>
      {expanded && (
        <div style={{ borderTop: `1px solid ${colors.containerBorder}`, padding: 8 }}>
          {item.trace ? <TraceView trace={item.trace} /> : (
            <span style={emptyStyle(colors)}>This older activity record has no step-by-step trace.</span>
          )}
          {item.error && (
            <div style={{ color: colors.statusError, fontSize: 12, marginTop: 7 }}>
              Error: {item.error}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function TraceView({ trace }: { trace: AutomationEvaluationTrace }) {
  const colors = useColors()
  const rows = [
    `Trigger received: ${eventLabel(trace.trigger.eventType)}`,
    `Conditions: ${describeCondition(trace.condition)}`,
    `Causation: ${describeCausation(trace)}`,
    ...trace.steps.flatMap(describeStep),
  ]
  return (
    <ol style={{ display: 'grid', gap: 5, margin: 0, paddingLeft: 20, color: colors.textSecondary, fontSize: 12 }}>
      {rows.map((row, index) => <li key={`${index}-${row}`}>{row}</li>)}
    </ol>
  )
}

function describeStep(step: AutomationStepDecision): string[] {
  if (step.type === 'action') {
    return [`Action ${step.outcome}: ${step.kind}${step.error ? ` (${step.error})` : ''}`]
  }
  return [
    `Branch selected: ${step.selected === 'then' ? 'Then actions' : 'Else actions'} (${describeGroup(step.condition)})`,
    ...step.steps.flatMap(describeStep),
  ]
}

function describeCondition(decision: AutomationConditionDecisionResult): string {
  if (decision.type === 'none') return 'No conditions configured; workflow is eligible.'
  return describeDecisionTree(decision)
}

function describeGroup(decision: Extract<AutomationConditionDecisionResult, { type: 'group' }>): string {
  const parts = [
    ...decision.all.map(describeDecisionTree),
    ...decision.any.map(describeDecisionTree),
  ]
  return `${decision.matched ? 'Matched' : 'Did not match'}${parts.length ? `: ${parts.join('; ')}` : ''}`
}

function describeDecisionTree(decision: Exclude<AutomationConditionDecisionResult, { type: 'none' }>): string {
  return decision.type === 'group' ? describeGroup(decision) : describeLeaf(decision)
}

function describeLeaf(decision: Extract<AutomationConditionDecisionResult, { type: 'condition' }>): string {
  const expected = decision.expected === undefined ? '' : ` ${decision.operator} ${formatValue(decision.expected)}`
  return `${decision.path}${expected} (${decision.matched ? 'matched' : `was ${formatValue(decision.actual)}`})`
}

function describeCausation(trace: AutomationEvaluationTrace): string {
  switch (trace.causation.decision) {
    case 'continued': return 'Allowed to run.'
    case 'cycle': return 'Skipped to prevent an automation cycle.'
    case 'max-depth': return 'Skipped because the automation chain reached its depth limit.'
    default: return 'Not evaluated after the condition did not match.'
  }
}

function actionSummary(steps: AutomationStep[]): string {
  if (steps.length === 0) return 'No actions configured.'
  const actionNames = steps.map((step) =>
    'type' in step ? 'choose a branch' : actionLabel(step),
  )
  return actionNames.join(', ')
}

function formatValue(value: AutomationValue | undefined): string {
  if (value === undefined) return 'no value'
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function labelStyle(colors: ReturnType<typeof useColors>): React.CSSProperties {
  return { display: 'grid', gap: 3, color: colors.textSecondary, fontSize: 12, marginBottom: 8 }
}

function inputStyle(colors: ReturnType<typeof useColors>): React.CSSProperties {
  return { background: colors.surfacePrimary, color: colors.textPrimary, border: `1px solid ${colors.containerBorder}`, borderRadius: 5, padding: '5px 7px' }
}

function buttonStyle(colors: ReturnType<typeof useColors>): React.CSSProperties {
  return { background: colors.surfaceSecondary, color: colors.textSecondary, border: `1px solid ${colors.containerBorder}`, borderRadius: 5, padding: '5px 8px', fontSize: 12 }
}

function emptyStyle(colors: ReturnType<typeof useColors>): React.CSSProperties {
  return { color: colors.textTertiary, fontSize: 12 }
}

function helpLabelStyle(colors: ReturnType<typeof useColors>): React.CSSProperties {
  return { color: colors.textTertiary, fontSize: 11, borderBottom: `1px dotted ${colors.textTertiary}`, cursor: 'help' }
}

function tagStyle(colors: ReturnType<typeof useColors>): React.CSSProperties {
  return { color: colors.textTertiary, fontSize: 11, border: `1px solid ${colors.containerBorder}`, borderRadius: 10, padding: '1px 5px' }
}

const toolbarStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 8,
  alignItems: 'center',
  marginBottom: 8,
}
