/**
 * settings-shell — `host.shell`, addressed to the server the Settings dialog
 * is editing.
 *
 * A page under the Server heading shows and changes one server's state: its
 * MCP servers, its automations, its enterprise sign-in. A bare `host.shell`
 * call carries no target and lands on the local server, so with another
 * server picked the page would list this machine's entries under that
 * server's name and save edits here.
 *
 * Every verb is sent inside `withTargetEnvironment`, which the bridge reads
 * synchronously when the call is issued. The target is fixed when the shell
 * is made: the dialog remounts its pages when the picked server changes, so a
 * page never outlives its target.
 */
import { useMemo } from 'react'
import { host } from '../../host/host-instance'
import { withTargetEnvironment } from '../../studio/connection/tab-environment'
import { onEnvironmentEvent } from './environment/environment-client'
import { useSettingsTargetEnvironmentId } from './settings-target'

type Shell = typeof host.shell

/** `host.shell` with every call sent to `environmentId`. */
export function shellFor(environmentId: string): Shell {
  return new Proxy(host.shell, {
    get(target, property, receiver) {
      const member: unknown = Reflect.get(target, property, receiver)
      if (typeof member !== 'function') return member
      return (...args: unknown[]): unknown =>
        withTargetEnvironment(environmentId, () => (member as (...a: unknown[]) => unknown).apply(target, args))
    },
  })
}

export interface SettingsShell {
  environmentId: string
  shell: Shell
  /** Subscribe to one of the picked server's event channels. */
  on(channel: string, cb: (payload: unknown) => void): () => void
}

export function useSettingsShell(): SettingsShell {
  const environmentId = useSettingsTargetEnvironmentId()
  return useMemo(() => ({
    environmentId,
    shell: shellFor(environmentId),
    on: (channel: string, cb: (payload: unknown) => void) => onEnvironmentEvent(environmentId, channel, cb),
  }), [environmentId])
}
