/**
 * Whether Studio offers a terminal, and everything that runs a shell, for a
 * conversation.
 *
 * The answer belongs to the server a conversation lives on: it holds the
 * connection's scopes, and refuses terminal, bash, Quick Tool, and port-forward
 * actions from a connection without `terminal:operate`. This is the client half
 * of that refusal. A person without the scope sees no control for it, instead
 * of a control that can only fail. The scopes are the ones the welcome frame
 * granted (`environment-settings-store`), the same source the Settings page
 * reads to decide whether to offer an admin-only control.
 */
import { useEnvironmentSettingsStore, canOperateTerminal } from '../state/environment-settings-store'
import { activeTabEnvironmentId, environmentOfTab, useActiveTabEnvironmentId } from './tab-environment'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'

/** Whether `environmentId`'s server lets this connection run a terminal, re-rendering when its scopes change. */
export function useEnvironmentTerminalAccess(environmentId: string): boolean {
  return useEnvironmentSettingsStore((s) => canOperateTerminal(s, environmentId))
}

/** Whether the active conversation's server lets this connection run a terminal. */
export function useActiveTerminalAccess(): boolean {
  return useEnvironmentTerminalAccess(useActiveTabEnvironmentId())
}

/** Non-reactive read for handlers, shortcuts, and store actions. */
export function terminalAccessFor(environmentId: string): boolean {
  return canOperateTerminal(useEnvironmentSettingsStore.getState(), environmentId)
}

/** Non-reactive read for the conversation `tabId`; the local server's when the tab is unknown. */
export function terminalAccessForTab(tabId: string | null | undefined): boolean {
  return terminalAccessFor(environmentOfTab(tabId) ?? LOCAL_ENVIRONMENT_ID)
}

/** Non-reactive read for the active conversation. */
export function activeTerminalAccess(): boolean {
  return terminalAccessFor(activeTabEnvironmentId())
}
