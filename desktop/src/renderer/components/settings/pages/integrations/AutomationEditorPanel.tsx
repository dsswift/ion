/**
 * AutomationEditorPanel — the Automation Editor, in a side panel. The whole
 * rule is visible at once as three steps: Name and When, If, Then. Every
 * control offers only what the chosen event and field allow, so a rule
 * cannot name a field the event never carries. Grouped conditions and
 * branch steps it cannot edit are kept verbatim and shown read-only. The
 * footer carries the plain-language preview, or why the rule cannot save.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { Plus, X } from '@phosphor-icons/react'
import { AUTOMATION_TRIGGERS, automationField, automationTrigger, validateUserDefinition, type AutomationFieldSpec, type AutomationTriggerSpec } from '@ion/shared/automation-catalog'
import type { AutomationAction, AutomationCondition, AutomationConditionOperator, AutomationDefinition } from '@ion/shared/types-automation'
import { conditionForField, conditionForOperator, defaultConditionFor, flatConditions, isPresenceOperator, keepValidActions, keepValidConditions, plainActions } from '../../automation-draft'
import { isBranch, normalize, toSteps } from '../../automation-editor-helpers'
import { Button, ErrorText, Field, GroupHeader, IconButton, Inline, Muted, Notice, Select, SidePanel, Stack, Switch, TextInput } from '../../kit'
import { AutomationActionSteps } from './AutomationActionSteps'
import { WarnText } from './WarnText'
import { OPERATOR_LABELS, finalizeAutomation, previewAutomation } from './automation-describe'

export function AutomationEditorPanel({ definition, title, error, onCancel, onSave }: {
  definition: AutomationDefinition | null
  title: string
  error: string | null
  onCancel(): void
  onSave(definition: AutomationDefinition): void
}): React.JSX.Element | null {
  if (!definition) return null
  return <EditorBody definition={definition} title={title} error={error} onCancel={onCancel} onSave={onSave} />
}

function EditorBody({ definition: source, title, error, onCancel, onSave }: {
  definition: AutomationDefinition
  title: string
  error: string | null
  onCancel(): void
  onSave(definition: AutomationDefinition): void
}): React.JSX.Element {
  const [draft, setDraft] = useState(() => normalize(source))
  useEffect(() => setDraft(normalize(source)), [source])

  const trigger = automationTrigger(draft.trigger.event)
  const flat = flatConditions(draft.condition)
  const steps = toSteps(draft)
  const actions = plainActions(steps)
  const branchSteps = steps.filter(isBranch)
  const finalized = useMemo(() => finalizeAutomation(draft), [draft])
  const validation = draft.trigger.event ? validateUserDefinition(finalized) : ({ ok: false, error: 'Select an event first.' } as const)

  const setEvent = (event: string): void => {
    const nextTrigger = automationTrigger(event)
    setDraft((current) => {
      const currentSteps = toSteps(current)
      const keptConditions = nextTrigger ? keepValidConditions(flatConditions(current.condition) ?? [], nextTrigger) : []
      const currentActions = plainActions(currentSteps)
      const keptActions = nextTrigger ? keepValidActions(currentActions, nextTrigger) : currentActions
      return {
        ...current,
        trigger: { kind: 'event', event },
        condition: keptConditions.length ? { all: keptConditions } : undefined,
        steps: [...keptActions, ...currentSteps.filter(isBranch)],
      }
    })
  }
  const setConditions = (next: AutomationCondition[]): void => setDraft((c) => ({ ...c, condition: next.length ? { all: next } : undefined }))
  const setActions = (next: AutomationAction[]): void => setDraft((c) => ({ ...c, steps: [...next, ...branchSteps] }))

  return (
    <SidePanel
      open
      title={title}
      onClose={onCancel}
      footer={<>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" disabled={!validation.ok} tooltip={validation.ok ? undefined : validation.error} onClick={() => onSave(finalized)}>Save</Button>
      </>}
    >
      <div aria-label="Automation Editor">
        <Stack gap={18}>
          <Stack>
            <Field label="Name">
              <TextInput aria-label="Automation name" value={draft.name} placeholder="Untitled automation" onChange={(e) => setDraft((c) => ({ ...c, name: e.target.value }))} />
            </Field>
            <Field label="When">
              <Select aria-label="Automation trigger" value={draft.trigger.event} onChange={(e) => setEvent(e.target.value)}>
                <option value="">Choose an event</option>
                {AUTOMATION_TRIGGERS.map((t) => <option key={t.event} value={t.event}>{t.label}</option>)}
              </Select>
            </Field>
            <Inline gap={8}>
              <Switch label="Enable automation" checked={draft.enabled} onChange={(next) => setDraft((c) => ({ ...c, enabled: next }))} />
              <Muted>Enabled</Muted>
            </Inline>
          </Stack>
          <ConditionsStep trigger={trigger} conditions={flat} onChange={setConditions} />
          <AutomationActionSteps trigger={trigger} actions={actions} onChange={setActions} branchCount={branchSteps.length} />
          <Notice tone={validation.ok ? 'muted' : 'warn'}>{validation.ok ? previewAutomation(finalized) : validation.error}</Notice>
          <ErrorText>{error}</ErrorText>
        </Stack>
      </div>
    </SidePanel>
  )
}

function ConditionsStep({ trigger, conditions, onChange }: {
  trigger: AutomationTriggerSpec | undefined
  /** Null when the rule uses grouped conditions the guided editor cannot edit. */
  conditions: AutomationCondition[] | null
  onChange(next: AutomationCondition[]): void
}): React.JSX.Element {
  if (!trigger) return <Stack gap={4}><GroupHeader title="If" /><Muted>Select an event first to add conditions.</Muted></Stack>
  if (conditions === null) {
    return (
      <Stack gap={4}>
        <GroupHeader title="If" />
        <WarnText>This rule uses advanced condition groups. They are kept as-is and shown read-only; edit them in the JSON file to change them.</WarnText>
      </Stack>
    )
  }
  const replace = (index: number, next: AutomationCondition): void => onChange(conditions.map((c, i) => (i === index ? next : c)))
  const next = defaultConditionFor(trigger)
  return (
    <Stack gap={6}>
      <GroupHeader
        title="If (all of)"
        actions={<Button icon={Plus} disabled={!next} onClick={() => { if (next) onChange([...conditions, next]) }}>Add condition</Button>}
      />
      {conditions.length === 0 && <Muted>No conditions — this rule runs on every {trigger.label.toLowerCase()}.</Muted>}
      {conditions.map((condition, index) => {
        const field = automationField(trigger, condition.path) ?? trigger.fields[0]
        return (
          <Inline key={index}>
            <Select aria-label="Condition field" value={condition.path} onChange={(e) => {
              const nextField = automationField(trigger, e.target.value)
              if (nextField) replace(index, conditionForField(e.target.value, nextField))
            }}>
              {trigger.fields.map((f) => <option key={f.path} value={f.path}>{f.label}</option>)}
            </Select>
            <Select aria-label="Condition operator" value={condition.operator} onChange={(e) => replace(index, conditionForOperator(condition, field, e.target.value as AutomationConditionOperator))}>
              {field.operators.map((op) => <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>)}
            </Select>
            {isPresenceOperator(condition.operator)
              ? <div style={{ width: '100%' }}><Muted>(no value)</Muted></div>
              : <ConditionValue field={field} value={condition.value} onChange={(value) => replace(index, { ...condition, value })} />}
            <IconButton icon={X} label="Remove condition" onClick={() => onChange(conditions.filter((_, i) => i !== index))} />
          </Inline>
        )
      })}
    </Stack>
  )
}

function ConditionValue({ field, value, onChange }: { field: AutomationFieldSpec; value: unknown; onChange(value: string | number | boolean): void }): React.JSX.Element {
  if (field.type === 'enum') {
    return (
      <Select aria-label="Condition value" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)}>
        {(field.values ?? []).map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
      </Select>
    )
  }
  if (field.type === 'boolean') {
    return (
      <Select aria-label="Condition value" value={value === true ? 'true' : 'false'} onChange={(e) => onChange(e.target.value === 'true')}>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </Select>
    )
  }
  if (field.type === 'number') {
    return <TextInput aria-label="Condition value" type="number" value={typeof value === 'number' ? value : 0} onChange={(e) => onChange(Number(e.target.value))} />
  }
  return <TextInput aria-label="Condition value" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />
}
