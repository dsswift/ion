/**
 * AgentToggleSections — two server settings about what the agent may touch:
 * whether it may edit this server's Ion settings files, and whether Studio's
 * built-in browser tools are offered to it.
 */
import React from 'react'
import { deriveEnterpriseSettingsEditsPolicy } from '@ion/shared/enterprise-settings-edits-policy'
import { useSettingsPreferences, useSettingsTargetEnvironmentId } from '../../settings-target'
import { useEnvironmentEnterprisePolicy } from '../../use-environment-enterprise-policy'
import { FormGroup, ToggleRow } from '../../kit'

export function AgentAccessSection(): React.JSX.Element {
  const saved = useSettingsPreferences((s) => s.allowSettingsEdits)
  const setAllowSettingsEdits = useSettingsPreferences((s) => s.setAllowSettingsEdits)
  // The organization's seal on this server outranks the saved value. The
  // server refuses the save too; this only keeps the control honest.
  const seal = deriveEnterpriseSettingsEditsPolicy(useEnvironmentEnterprisePolicy(useSettingsTargetEnvironmentId()))
  return (
    <FormGroup title="Agent access">
      <ToggleRow
        anchor="settings-edits"
        label="Allow settings edits by the agent"
        description="Off: the agent can never change this server's Ion settings files (engine.json, settings.json). On: the agent is still stopped, and the person at the conversation is asked to approve each file."
        checked={seal ? seal.allowed : saved}
        onChange={setAllowSettingsEdits}
        warning="An approved agent can change what the engine on this server permits."
        lockedReason={seal ? 'Set by your organization.' : undefined}
      />
    </FormGroup>
  )
}

export function AgentToolsSection(): React.JSX.Element {
  const studioPlaywrightEnabled = useSettingsPreferences((s) => s.studioPlaywrightEnabled)
  const setStudioPlaywrightEnabled = useSettingsPreferences((s) => s.setStudioPlaywrightEnabled)
  return (
    <FormGroup title="Tools">
      <ToggleRow
        anchor="playwright"
        label="Built-in Playwright browser tools"
        description="Agents in Studio can operate the Chromium tabs in their conversation's Surface panel. Turning this off removes the tools without closing tabs or signing you out."
        checked={studioPlaywrightEnabled}
        onChange={setStudioPlaywrightEnabled}
      />
    </FormGroup>
  )
}
