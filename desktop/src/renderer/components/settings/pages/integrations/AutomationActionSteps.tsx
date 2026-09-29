/**
 * AutomationActionSteps — the editor's Then step: the ordered plain actions,
 * each a catalog action whose config controls come from its spec and whose
 * target comes from the event (never a raw worktree or tab id). Branch steps
 * the rule already has are preserved by the editor and reported read-only.
 */
import React from 'react'
import { ArrowDown, ArrowUp, Plus, X } from '@phosphor-icons/react'
import { AUTOMATION_ACTIONS, automationAction, type AutomationActionConfigField, type AutomationActionSpec, type AutomationTriggerSpec } from '@ion/shared/automation-catalog'
import type { AutomationAction } from '@ion/shared/types-automation'
import { PILL_COLOR_PRESETS } from '../../../pill-presets'
import { SLASH_COMMANDS } from '../../../SlashCommandMenu'
import { host } from '../../../../host/host-instance'
import { rWarn } from '../../../../rendererLogger'
import { actionTargetSatisfied, defaultActionFor } from '../../automation-draft'
import { Button, Field, Group, GroupHeader, IconButton, Inline, Muted, Select, Stack, TextInput } from '../../kit'
import { WarnText } from './WarnText'

export function AutomationActionSteps({ trigger, actions, onChange, branchCount }: {
  trigger: AutomationTriggerSpec | undefined
  actions: AutomationAction[]
  onChange(next: AutomationAction[]): void
  branchCount: number
}): React.JSX.Element {
  const replace = (index: number, next: AutomationAction): void => onChange(actions.map((a, i) => (i === index ? next : a)))
  const move = (index: number, delta: number): void => {
    const target = index + delta
    if (target < 0 || target >= actions.length) return
    const next = [...actions]
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }
  return (
    <Stack gap={6}>
      <GroupHeader title="Then" actions={<Button icon={Plus} onClick={() => onChange([...actions, defaultActionFor('record')])}>Add action</Button>} />
      {actions.length === 0 && <Muted>No actions yet. Add at least one for this rule to do anything.</Muted>}
      {actions.map((action, index) => (
        <Group key={index} padded>
          <Stack gap={8}>
            <Inline>
              <Select aria-label="Action" value={action.kind} onChange={(e) => replace(index, defaultActionFor(e.target.value))}>
                {AUTOMATION_ACTIONS.map((a) => <option key={a.kind} value={a.kind}>{a.label}</option>)}
              </Select>
              <IconButton icon={ArrowUp} label="Move action up" disabled={index === 0} onClick={() => move(index, -1)} />
              <IconButton icon={ArrowDown} label="Move action down" disabled={index === actions.length - 1} onClick={() => move(index, 1)} />
              <IconButton icon={X} label="Remove action" onClick={() => onChange(actions.filter((_, i) => i !== index))} />
            </Inline>
            <ActionFields trigger={trigger} action={action} onChange={(next) => replace(index, next)} />
          </Stack>
        </Group>
      ))}
      {branchCount > 0 && (
        <WarnText>This rule also has {branchCount} conditional branch{branchCount === 1 ? '' : 'es'} kept read-only here; edit them in the JSON file.</WarnText>
      )}
    </Stack>
  )
}

function ActionFields({ trigger, action, onChange }: { trigger: AutomationTriggerSpec | undefined; action: AutomationAction; onChange(next: AutomationAction): void }): React.JSX.Element | null {
  const spec = automationAction(action.kind)
  if (!spec) return null
  const setConfig = (key: string, value: unknown): void => {
    const payload = { ...(action.payload ?? {}) }
    if (value === '' || value === undefined) delete payload[key]
    else payload[key] = value
    onChange({ ...action, payload })
  }
  return (
    <>
      <TargetLine trigger={trigger} spec={spec} action={action} onChange={onChange} />
      {spec.config.map((configField) => (
        <Field key={configField.key} label={configField.label}>
          <ConfigControl kind={action.kind} field={configField} value={action.payload?.[configField.key]} onChange={(value) => setConfig(configField.key, value)} />
        </Field>
      ))}
    </>
  )
}

function TargetLine({ trigger, spec, action, onChange }: { trigger: AutomationTriggerSpec | undefined; spec: AutomationActionSpec; action: AutomationAction; onChange(next: AutomationAction): void }): React.JSX.Element | null {
  const satisfied = trigger ? actionTargetSatisfied(spec, trigger, action) : false
  if (spec.target === 'none') return null
  if (spec.target === 'worktree') return satisfied ? <Muted>Target: the triggering worktree</Muted> : <WarnText>This event cannot supply a worktree for this action</WarnText>
  if (spec.target === 'conversation') return satisfied ? <Muted>Target: the triggering conversation</Muted> : <WarnText>This event cannot supply a conversation for this action</WarnText>
  if (trigger?.provides.worktree) return <Muted>Target: the triggering worktree</Muted>
  const directory = typeof action.payload?.directory === 'string' ? action.payload.directory : ''
  return (
    <Inline>
      <div style={{ flex: 1, minWidth: 0 }}>{directory ? <Muted mono>Target directory: {directory}</Muted> : <WarnText>Choose a target directory</WarnText>}</div>
      <Button onClick={() => {
        // The host seam answers on both clients: Electron opens the native
        // dialog; a browser tab resolves null and the button does nothing.
        void host.pickDirectory()
          .then((picked) => { if (picked) onChange({ ...action, payload: { ...(action.payload ?? {}), directory: picked } }) })
          .catch((err: unknown) => rWarn('automation.settings', 'directory pick failed', { error: String(err) }))
      }}>Choose…</Button>
    </Inline>
  )
}

function ConfigControl({ kind, field, value, onChange }: { kind: string; field: AutomationActionConfigField; value: unknown; onChange(value: unknown): void }): React.JSX.Element {
  const text = typeof value === 'string' ? value : ''
  // Renderer-sourced choice lists for tab decoration and slash commands.
  if (kind === 'tab:set-color' && field.key === 'color') {
    return (
      <Select aria-label={field.label} value={text} onChange={(e) => onChange(e.target.value)}>
        {PILL_COLOR_PRESETS.map((preset) => <option key={preset.label} value={preset.color ?? ''}>{preset.label}</option>)}
      </Select>
    )
  }
  if (kind === 'conversation:slash' && field.key === 'command') {
    return (
      <>
        <TextInput aria-label={field.label} list="automation-slash-commands" value={text} placeholder="align" onChange={(e) => onChange(e.target.value)} />
        <datalist id="automation-slash-commands">
          {SLASH_COMMANDS.map((c) => <option key={c.command} value={c.command.replace(/^\//, '')} />)}
        </datalist>
      </>
    )
  }
  if (field.type === 'enum') {
    return (
      <Select aria-label={field.label} value={text} onChange={(e) => onChange(e.target.value)}>
        {!field.required && <option value="">— any —</option>}
        {(field.values ?? []).map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
      </Select>
    )
  }
  if (field.type === 'boolean') {
    return (
      <Select aria-label={field.label} value={value === true ? 'true' : 'false'} onChange={(e) => onChange(e.target.value === 'true')}>
        <option value="false">No</option>
        <option value="true">Yes</option>
      </Select>
    )
  }
  if (field.type === 'number') {
    return <TextInput aria-label={field.label} type="number" value={typeof value === 'number' ? value : 0} onChange={(e) => onChange(Number(e.target.value))} />
  }
  return <TextInput aria-label={field.label} value={text} onChange={(e) => onChange(e.target.value)} />
}
