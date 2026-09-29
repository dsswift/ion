/**
 * PresetsSection — apply a bundle of settings in one step. Applying
 * overwrites the current values, so it asks first, in a side panel that
 * lists exactly what changes.
 */
import React, { useState } from 'react'
import { rInfo } from '../../../rendererLogger'
import { useSettingsPreferences } from '../settings-target'
import { Button, Chip, FormGroup, FormRow, Muted, SidePanel, Stack } from '../kit'
import { Tooltip } from '../../git/Tooltip'

interface Preset {
  id: string
  name: string
  description: string
  values: Record<string, unknown>
  summary: string[]
}

export const PRESETS: readonly Preset[] = [
  {
    id: 'operator',
    name: 'Operator',
    description: 'Simple, low-friction experience. Outputs are collapsed and auto mode is the default.',
    values: { defaultPermissionMode: 'auto', expandToolResults: false, bashCommandEntry: false, showTodoList: false },
    summary: ['Permission mode: Auto', 'Tool results: Collapsed', 'Bash entry: Off', 'Task list: Off'],
  },
  {
    id: 'developer',
    name: 'Developer',
    description: 'Verbose output with planning mode.',
    values: { defaultPermissionMode: 'plan', expandToolResults: true, bashCommandEntry: true, showTodoList: true },
    summary: ['Permission mode: Plan', 'Tool results: Expanded', 'Bash entry: On', 'Task list: On'],
  },
]

export function PresetsSection(): React.JSX.Element {
  const applyPreset = useSettingsPreferences((s) => s.applyPreset)
  const [confirming, setConfirming] = useState<Preset | null>(null)

  const apply = (preset: Preset): void => {
    applyPreset(preset.values)
    rInfo('settings', 'preset applied', { preset: preset.id })
    setConfirming(null)
  }

  return (
    <>
      <FormGroup title="Presets" description="Configure several settings at once. You can change any of them afterwards." anchor="presets">
        {PRESETS.map((preset) => (
          <FormRow key={preset.id} label={preset.name} description={preset.description}>
            <Tooltip text={preset.summary.join(' · ')}><Chip>{preset.summary.length} settings</Chip></Tooltip>
            <Button onClick={() => setConfirming(preset)}>Apply</Button>
          </FormRow>
        ))}
      </FormGroup>
      <SidePanel
        open={confirming !== null}
        title={confirming ? `Apply ${confirming.name}` : ''}
        subtitle="Overwrite current settings?"
        onClose={() => setConfirming(null)}
        footer={<>
          <Button onClick={() => setConfirming(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => { if (confirming) apply(confirming) }}>Confirm</Button>
        </>}
      >
        {confirming && (
          <Stack gap={8}>
            <Muted>{confirming.description}</Muted>
            {confirming.summary.map((line) => <div key={line}><Chip tone="accent">{line}</Chip></div>)}
          </Stack>
        )}
      </SidePanel>
    </>
  )
}
