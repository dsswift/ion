/**
 * DefaultsPage — what new conversations start with, yours on every server:
 * the permission mode, AI tab titles, bash entry, .claude compatibility,
 * and the early-stop nudge. The default thinking level is its own section,
 * filed under the AI group.
 */
import React from 'react'
import type { ThinkingEffort } from '@ion/shared/types'
import { thinkingEffortLabel } from '@ion/shared/thinking-options'
import { useSettingsPreferences } from '../settings-target'
import { FormGroup, FormRow, KIT, Segmented, Stack, ToggleRow } from '../kit'

type PermissionMode = 'plan' | 'auto'

const PERMISSION_MODES = [
  { value: 'plan', label: 'Plan' },
  { value: 'auto', label: 'Auto' },
] as const

const THINKING_LEVELS: readonly ThinkingEffort[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max']

export function DefaultsPage(): React.JSX.Element {
  const p = useSettingsPreferences
  const defaultPermissionMode = p((s) => s.defaultPermissionMode)
  const setDefaultPermissionMode = p((s) => s.setDefaultPermissionMode)
  const aiGeneratedTitles = p((s) => s.aiGeneratedTitles)
  const setAiGeneratedTitles = p((s) => s.setAiGeneratedTitles)
  const bashCommandEntry = p((s) => s.bashCommandEntry)
  const setBashCommandEntry = p((s) => s.setBashCommandEntry)
  const enableClaudeCompat = p((s) => s.enableClaudeCompat)
  const setEnableClaudeCompat = p((s) => s.setEnableClaudeCompat)
  const enableEarlyStopContinuation = p((s) => s.enableEarlyStopContinuation)
  const setEnableEarlyStopContinuation = p((s) => s.setEnableEarlyStopContinuation)

  return (
    <Stack gap={KIT.groupGap}>
      <FormGroup title="New conversations">
        <FormRow anchor="permission-mode" label="Default permission mode" description="The permission mode new tabs start with.">
          <Segmented<PermissionMode> label="Default permission mode" value={defaultPermissionMode} options={PERMISSION_MODES} onChange={setDefaultPermissionMode} />
        </FormRow>
        <ToggleRow anchor="ai-titles" label="AI tab titles" description="Generate descriptive tab titles from your first message. Uses the fast model tier." checked={aiGeneratedTitles} onChange={setAiGeneratedTitles} />
        <ToggleRow anchor="bash-entry" label="Bash command entry" description="Type ! as the first character to run a bash command directly in the conversation." checked={bashCommandEntry} onChange={setBashCommandEntry} />
      </FormGroup>
      <FormGroup title="Engine behavior">
        <ToggleRow anchor="claude-compat" label="Claude compatibility" description="Load commands and skills from .claude/ directories. Commands in .ion/ directories always load." checked={enableClaudeCompat} onChange={setEnableClaudeCompat} />
        <ToggleRow
          anchor="early-stop"
          label="Early-stop continuation nudge"
          description="When the model stops below the engine's configured output-token target, answer the engine's continuation hook with a 'keep working' prompt. Off never nudges."
          checked={enableEarlyStopContinuation}
          onChange={setEnableEarlyStopContinuation}
        />
      </FormGroup>
    </Stack>
  )
}

export function ThinkingSection(): React.JSX.Element {
  const defaultThinkingEffort = useSettingsPreferences((s) => s.defaultThinkingEffort)
  const setDefaultThinkingEffort = useSettingsPreferences((s) => s.setDefaultThinkingEffort)
  return (
    <FormGroup title="Extended thinking">
      <FormRow
        anchor="thinking"
        stacked
        label="Default thinking level"
        description="Where new conversations start on models that take an explicit level. Models with adaptive reasoning (Claude) choose their own depth. Each conversation can change it from its status bar."
      >
        <Segmented<ThinkingEffort> label="Default thinking level" value={defaultThinkingEffort} options={THINKING_LEVELS.map((level) => ({ value: level, label: thinkingEffortLabel(level) }))} onChange={setDefaultThinkingEffort} />
      </FormRow>
    </FormGroup>
  )
}
