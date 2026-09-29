/**
 * automation-describe — plain-language text for automations: the editor's
 * finalized definition and one-line preview, the list's source and action
 * summaries, and the activity trace. Pure functions, no UI.
 */
import { automationAction, automationField, automationTrigger } from '@ion/shared/automation-catalog'
import type {
  AutomationAction,
  AutomationCondition,
  AutomationConditionDecisionResult,
  AutomationConditionOperator,
  AutomationDefinition,
  AutomationEvaluationTrace,
  AutomationSourceEntry,
  AutomationStep,
  AutomationStepDecision,
  AutomationValue,
} from '@ion/shared/types-automation'
import { flatConditions, hasBranchSteps, plainActions } from '../../automation-draft'
import { newId, toSteps } from '../../automation-editor-helpers'

export const OPERATOR_LABELS: Record<AutomationConditionOperator, string> = {
  equals: 'is',
  'not-equals': 'is not',
  exists: 'is present',
  'not-exists': 'is absent',
  contains: 'contains',
  'not-contains': 'does not contain',
  matches: 'matches pattern',
  'greater-than': 'is greater than',
  'greater-than-or-equals': 'is at least',
  'less-than': 'is less than',
  'less-than-or-equals': 'is at most',
}

export function blankAutomation(): AutomationDefinition {
  const now = new Date().toISOString()
  return { id: '', name: '', enabled: true, trigger: { kind: 'event', event: '' }, steps: [], createdAt: now, updatedAt: now }
}

/** The definition Save sends: a real id and name, steps only, a fresh timestamp. */
export function finalizeAutomation(draft: AutomationDefinition): AutomationDefinition {
  return {
    ...draft,
    id: draft.id.trim() || `user.${newId()}`,
    name: draft.name.trim() || 'Untitled automation',
    trigger: { kind: 'event', event: draft.trigger.event.trim() },
    steps: toSteps(draft),
    actions: undefined,
    updatedAt: new Date().toISOString(),
  }
}

export function triggerLabel(event: string): string {
  return automationTrigger(event)?.label ?? event
}

export function actionLabel(kind: string): string {
  return automationAction(kind)?.label ?? kind
}

export function sourceLabel(source: AutomationSourceEntry['source']): string {
  switch (source) {
    case 'user': return 'You'
    case 'project': return 'Project'
    case 'enterprise': return 'Enterprise'
    case 'built-in': return 'Built-in'
  }
}

export function actionSummary(steps: AutomationStep[]): string {
  if (steps.length === 0) return 'No actions configured.'
  return steps.map((step) => ('type' in step ? 'choose a branch' : actionLabel(step.kind))).join(', ')
}

/** Plain-language summary of a runnable rule. */
export function previewAutomation(definition: AutomationDefinition): string {
  const trigger = automationTrigger(definition.trigger.event)
  const when = trigger?.label ?? definition.trigger.event
  const conditions = flatConditions(definition.condition) ?? []
  const ifPart = conditions.length ? ` if ${conditions.map((c) => describeCondition(trigger, c)).join(' and ')}` : ''
  const actions = plainActions(toSteps(definition))
  const branches = hasBranchSteps(toSteps(definition))
  const thenPart = actions.length
    ? ` then ${actions.map(describeAction).join(', ')}`
    : branches ? ' then run its conditional branches' : ' then do nothing'
  return `When ${when.toLowerCase()},${ifPart}${thenPart}.`
}

function describeCondition(trigger: ReturnType<typeof automationTrigger>, condition: AutomationCondition): string {
  const field = trigger && automationField(trigger, condition.path)
  const label = field?.label ?? condition.path
  if (condition.operator === 'exists') return `${label} is present`
  if (condition.operator === 'not-exists') return `${label} is absent`
  const value = field?.values?.find((choice) => choice.value === condition.value)?.label
  return `${label} ${condition.operator} ${value ?? String(condition.value)}`
}

function describeAction(action: AutomationAction): string {
  if (action.kind === 'worktree:set-stage') return `set the stage to ${String(action.payload?.stage ?? '')}`
  if (action.kind === 'desktop:notification') return 'show a notification'
  if (action.kind === 'conversation:slash') return `run /${String(action.payload?.command ?? '')}`
  if (action.kind === 'conversation:run') return 'start a conversation'
  return action.kind
}

/** The stored evaluation path of one run, one line per decision. */
export function traceRows(trace: AutomationEvaluationTrace): string[] {
  return [
    `Trigger received: ${triggerLabel(trace.trigger.eventType)}`,
    `Conditions: ${describeDecision(trace.condition)}`,
    `Causation: ${describeCausation(trace)}`,
    ...trace.steps.flatMap(describeStep),
  ]
}

function describeStep(step: AutomationStepDecision): string[] {
  if (step.type === 'action') return [`Action ${step.outcome}: ${actionLabel(step.kind)}${step.error ? ` (${step.error})` : ''}`]
  return [
    `Branch selected: ${step.selected === 'then' ? 'Then actions' : 'Else actions'} (${describeGroup(step.condition)})`,
    ...step.steps.flatMap(describeStep),
  ]
}

function describeDecision(decision: AutomationConditionDecisionResult): string {
  if (decision.type === 'none') return 'No conditions configured; workflow is eligible.'
  return describeDecisionTree(decision)
}

function describeGroup(decision: Extract<AutomationConditionDecisionResult, { type: 'group' }>): string {
  const parts = [...decision.all.map(describeDecisionTree), ...decision.any.map(describeDecisionTree)]
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

function formatValue(value: AutomationValue | undefined): string {
  if (value === undefined) return 'no value'
  return typeof value === 'string' ? value : JSON.stringify(value)
}
