/**
 * use-host-install — a server restarting or updating itself, as the Fleet
 * page and a server's Overview show it.
 *
 * The request is answered before the host goes down, and a host a desktop
 * runs reports what happens next on `ion:host-install-progress`. This keeps
 * the newest step per server: what was asked, why it was refused, or that
 * the server is going down for it.
 */
import { useCallback, useEffect, useState } from 'react'
import { HOST_INSTALL_PROGRESS_CHANNEL, type HostInstallProgress } from '@ion/shared/host-install'
import { environmentClient, onEnvironmentEvent } from '../environment/environment-client'
import { rInfo, rWarn } from '../../../rendererLogger'

/** What a host install is doing on one server, in a sentence. */
export interface HostInstallStatus {
  tone: 'muted' | 'error'
  text: string
}

function describe(progress: HostInstallProgress, label: string): HostInstallStatus {
  const what = progress.kind === 'restart' ? 'restart' : 'update'
  switch (progress.stage) {
    case 'requested': return { tone: 'muted', text: `${label}: ${what} requested.` }
    case 'downloading': return { tone: 'muted', text: `${label} is downloading the update.` }
    case 'installing': return { tone: 'muted', text: `${label} is installing the update.` }
    case 'restarting': return { tone: 'muted', text: `${label} is restarting. It will drop and reconnect in a moment.` }
    case 'refused': return { tone: 'error', text: `${label} will not ${what}: ${progress.message ?? progress.code ?? 'no reason given'}` }
    case 'failed': return { tone: 'error', text: `${label} could not ${what}: ${progress.message ?? 'no reason given'}` }
    case 'completed': return { tone: 'muted', text: progress.version ? `${label} is back, running ${progress.version}.` : `${label} is back.` }
  }
}

function isProgress(payload: unknown): payload is HostInstallProgress {
  return !!payload && typeof payload === 'object' && typeof (payload as { stage?: unknown }).stage === 'string' && typeof (payload as { kind?: unknown }).kind === 'string'
}

export interface HostInstall {
  /** The newest step per server id. */
  status: Record<string, HostInstallStatus>
  restart(server: { id: string; label: string }): void
  update(server: { id: string; label: string }): void
}

/** Follows host installs on the servers given, and starts them. */
export function useHostInstall(servers: ReadonlyArray<{ id: string; label: string }>): HostInstall {
  const [status, setStatus] = useState<Record<string, HostInstallStatus>>({})
  const key = servers.map((s) => `${s.id}=${s.label}`).join('|')

  useEffect(() => {
    const offs = servers.map((server) => onEnvironmentEvent(server.id, HOST_INSTALL_PROGRESS_CHANNEL, (payload) => {
      if (!isProgress(payload)) return
      setStatus((prev) => ({ ...prev, [server.id]: describe(payload, server.label) }))
    }))
    return () => { for (const off of offs) off() }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` names the servers; the array's identity changes every render
  }, [key])

  const run = useCallback((server: { id: string; label: string }, kind: 'restart' | 'release', call: (id: string) => Promise<unknown>) => {
    setStatus((prev) => ({ ...prev, [server.id]: { tone: 'muted', text: `Asking ${server.label} to ${kind === 'restart' ? 'restart' : 'update'}…` } }))
    rInfo('settings.fleet', 'host install requested', { environment_id: server.id, kind })
    call(server.id).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      rWarn('settings.fleet', 'host install refused or failed', { environment_id: server.id, kind, error: message })
      setStatus((prev) => ({ ...prev, [server.id]: describe({ stage: 'refused', kind, message, at: Date.now() }, server.label) }))
    })
  }, [])

  const restart = useCallback((server: { id: string; label: string }) => run(server, 'restart', environmentClient.restart), [run])
  const update = useCallback((server: { id: string; label: string }) => run(server, 'release', environmentClient.update), [run])
  return { status, restart, update }
}
