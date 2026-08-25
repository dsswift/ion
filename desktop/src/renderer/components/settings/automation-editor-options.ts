import type {
  AutomationAction,
  AutomationConditionOperator,
} from '../../../shared/types-automation'

export type PickerOption = { value: string; label: string; help?: string }

export const EVENT_OPTIONS: readonly PickerOption[] = [
  { value: 'worktree:pin-advanced', label: 'Worktree update reaches the integration bench' },
  { value: 'worktree:stage-changed', label: 'Worktree workflow stage changes' },
  { value: 'conversation:completed', label: 'Conversation completes' },
  { value: 'conversation:slash-resolved', label: 'Slash command resolves' },
  { value: 'plan:implemented', label: 'Plan is implemented' },
  { value: 'prompt:submitted', label: 'Prompt is submitted' },
  { value: 'engine:status', label: 'Engine status changes' },
]

export const CONDITION_FIELD_OPTIONS: readonly PickerOption[] = [
  { value: 'payload.stage', label: 'Current worktree stage' },
  { value: 'payload.previousStage', label: 'Previous worktree stage' },
  { value: 'payload.source', label: 'Change source' },
  { value: 'payload.slashCommand', label: 'Slash command name' },
  { value: 'payload.lastSlashCommand', label: 'Last slash command name' },
  { value: 'payload.worktreePath', label: 'Worktree exists' },
  { value: 'payload.permissionMode', label: 'Permission mode' },
  { value: 'payload.endedWithQuestion', label: 'Conversation ended with a question' },
  { value: 'payload.completionReason', label: 'Completion reason' },
]

export const OPERATOR_LABELS: Record<AutomationConditionOperator, string> = {
  equals: 'is exactly',
  'not-equals': 'is not',
  exists: 'exists',
  'not-exists': 'does not exist',
  contains: 'contains',
  'not-contains': 'does not contain',
  matches: 'matches pattern',
  'greater-than': 'is greater than',
  'greater-than-or-equals': 'is at least',
  'less-than': 'is less than',
  'less-than-or-equals': 'is at most',
}

export const STAGE_LABELS: Record<string, string> = {
  plan: 'Planning',
  build: 'Building',
  test: 'Needs testing',
  bug: 'Issue found',
  verified: 'Verified',
  merge: 'Merge checks',
  ready: 'Ready to land',
}

export const ACTION_LABELS: Record<string, string> = {
  record: 'Record this run only',
  'worktree:set-stage': 'Set worktree workflow stage',
  'desktop:notification': 'Show desktop notification',
  'conversation:run': 'Start AI conversation',
  'conversation:slash': 'Run a slash command',
  'tab:set-color': 'Set tab color',
  'tab:set-icon': 'Set tab icon',
  'tab:set-group': 'Move tab to group',
}

export function eventLabel(event: string): string {
  return EVENT_OPTIONS.find((option) => option.value === event)?.label ?? event
}

export function actionLabel(action: Pick<AutomationAction, 'kind'>): string {
  return ACTION_LABELS[action.kind] ?? action.kind
}
