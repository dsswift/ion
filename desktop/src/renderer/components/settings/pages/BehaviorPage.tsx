/**
 * BehaviorPage — how Studio behaves on this device: the surface on a
 * conversation switch, the task list and agent panel, sound, the browser
 * preview's network shield, the plan card's extra action, and, in the
 * desktop app, whether Ion opens at login. The device
 * half of the git panel is its own section, filed under the git group.
 */
import React from 'react'
import type { StudioSurfaceSwitchMode } from '@ion/server/preferences-types'
import { host } from '../../../host/host-instance'
import { useSettingsPreferences } from '../settings-target'
import { FormGroup, FormRow, KIT, Segmented, Stack, ToggleRow } from '../kit'

const SURFACE_MODES = [
  { value: 'preserve', label: 'Keep pinned' },
  { value: 'per-conversation', label: 'Per conversation' },
] as const

export function BehaviorPage(): React.JSX.Element {
  const p = useSettingsPreferences
  const studioSurfaceSwitchMode = p((s) => s.studioSurfaceSwitchMode)
  const setStudioSurfaceSwitchMode = p((s) => s.setStudioSurfaceSwitchMode)
  const showTodoList = p((s) => s.showTodoList)
  const setShowTodoList = p((s) => s.setShowTodoList)
  const agentPanelDefaultOpen = p((s) => s.agentPanelDefaultOpen)
  const setAgentPanelDefaultOpen = p((s) => s.setAgentPanelDefaultOpen)
  const soundEnabled = p((s) => s.soundEnabled)
  const setSoundEnabled = p((s) => s.setSoundEnabled)
  const browserPreviewNetworkShield = p((s) => s.browserPreviewNetworkShield)
  const setBrowserPreviewNetworkShield = p((s) => s.setBrowserPreviewNetworkShield)
  const showImplementClearContext = p((s) => s.showImplementClearContext)
  const setShowImplementClearContext = p((s) => s.setShowImplementClearContext)
  const openAtLogin = p((s) => s.openAtLogin)
  const setOpenAtLogin = p((s) => s.setOpenAtLogin)
  // The desktop app is what a login opens; a browser tab has nothing to open.
  const desktopApp = host.capabilities().includes('nativeShell')

  return (
    <Stack gap={KIT.groupGap}>
      <FormGroup title="Conversations">
        <FormRow
          anchor="surface-switch"
          label="Studio surface on conversation switch" settingKey="studioSurfaceSwitchMode"
          description={studioSurfaceSwitchMode === 'preserve' ? 'Keep the surface pinned when switching tabs.' : 'Remember the surface expanded state per conversation.'}
        >
          <Segmented<StudioSurfaceSwitchMode> label="Studio surface on conversation switch" value={studioSurfaceSwitchMode} options={SURFACE_MODES} onChange={setStudioSurfaceSwitchMode} />
        </FormRow>
        <ToggleRow anchor="task-list" label="Show task list" settingKey="showTodoList" description="Show the agent's task checklist at the bottom of the conversation while it works. Dispatch previews always show their task list." checked={showTodoList} onChange={setShowTodoList} />
        <ToggleRow anchor="agent-panel" label="Agent panel open by default" settingKey="agentPanelDefaultOpen" description="Expand the agent panel when agents are dispatched. Off keeps it collapsed." checked={agentPanelDefaultOpen} onChange={setAgentPanelDefaultOpen} />
        <ToggleRow
          anchor="implement-clear"
          label={'Show "Implement, clear context" button'} settingKey="showImplementClearContext"
          description="Adds a second action to the plan-approval card that starts a fresh conversation for implementation. Implement always keeps the conversation; /clear clears it at any time."
          checked={showImplementClearContext}
          onChange={setShowImplementClearContext}
        />
      </FormGroup>
      <FormGroup title="Alerts and previews">
        <ToggleRow anchor="sound" label="Notification sound" settingKey="soundEnabled" description="Play a sound when a task completes." checked={soundEnabled} onChange={setSoundEnabled} />
        <ToggleRow anchor="network-shield" label="Browser preview network shield" settingKey="browserPreviewNetworkShield" description="Block network requests from browser previews until you allow them in that preview." checked={browserPreviewNetworkShield} onChange={setBrowserPreviewNetworkShield} />
      </FormGroup>
      {desktopApp && (
        <FormGroup title="Startup">
          <ToggleRow anchor="open-at-login" label="Open Ion at login" settingKey="openAtLogin" description="Start Ion when you sign in to this computer, so it is running after a restart. A computer other devices connect to should have this on." checked={openAtLogin} onChange={setOpenAtLogin} />
        </FormGroup>
      )}
    </Stack>
  )
}

export function DeviceGitSection(): React.JSX.Element {
  const gitChangesTreeView = useSettingsPreferences((s) => s.gitChangesTreeView)
  const setGitChangesTreeView = useSettingsPreferences((s) => s.setGitChangesTreeView)
  return (
    <FormGroup title="Git panel">
      <ToggleRow anchor="changes-tree" label="Tree view for changes" settingKey="gitChangesTreeView" description="Group changed files by directory in the git panel." checked={gitChangesTreeView} onChange={setGitChangesTreeView} />
    </FormGroup>
  )
}
