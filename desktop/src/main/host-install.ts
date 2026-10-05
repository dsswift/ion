/**
 * host-install — this desktop restarts or updates itself when the server it
 * runs asks it to (`@ion/shared/host-install`).
 *
 * A server cannot replace the app that runs it. When a client asks that
 * server to restart, install a release, or install a build it sent, the
 * server hands the request to this desktop on its local connection. This
 * carries it out with the app's own updater and tells the server each step,
 * so the client that asked sees it. A request this desktop will not carry
 * out is refused with the reason.
 */
import { accessSync, constants } from 'node:fs'
import { dirname } from 'node:path'
import { app } from 'electron'
import {
  HOST_INSTALL_REFUSALS, HOST_INSTALL_REQUESTED_CHANNEL,
  type HostInstallProgress, type HostInstallRefusal, type HostInstallRequest,
} from '@ion/shared/host-install'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { installedAppPath } from './install-dispatch'
import { hasUpdateFeed, installArchiveNow, installLatestReleaseNow } from './updater'
import { quitForUpdate } from './app-lifecycle-quit'
import { log, warn } from './logger'

const TAG = 'host-install'

export interface HostInstallSource {
  onFrame(cb: (environmentId: string, frame: StudioFrame) => void): () => void
  sendAction(environmentId: string, action: string, args: unknown[]): Promise<unknown>
}

export interface HostInstallPolicy {
  /** Device policy turns this desktop's own updates off. */
  disableAutoUpdate: boolean
}

function isRequest(payload: unknown): payload is HostInstallRequest {
  if (!payload || typeof payload !== 'object') return false
  const p = payload as { kind?: unknown; path?: unknown; version?: unknown }
  if (p.kind === 'restart') return true
  if (p.kind === 'release') return p.version === undefined || typeof p.version === 'string'
  return p.kind === 'artifact' && typeof p.path === 'string' && p.path !== ''
}

/** Why this desktop will not replace its own app, or null when it will. */
export function installRefusal(policy: HostInstallPolicy, platform: NodeJS.Platform = process.platform): HostInstallRefusal | null {
  if (!app.isPackaged) return 'not_packaged'
  if (policy.disableAutoUpdate) return 'updates_disabled'
  if (platform === 'win32') return 'needs_administrator'
  if (platform === 'darwin') {
    try {
      // Replacing the bundle renames it, which needs write access to the folder it sits in.
      accessSync(dirname(installedAppPath()), constants.W_OK)
    } catch {
      // silent-ok: the missing access is the answer, reported as the refusal
      return 'not_admin'
    }
  }
  return null
}

/**
 * Carries out host install requests from the local server until the returned
 * function is called.
 */
export function wireHostInstall(source: HostInstallSource, policy: HostInstallPolicy): () => void {
  let busy = false

  const report = (progress: Omit<HostInstallProgress, 'at'>): void => {
    log(TAG, 'host install step', { stage: progress.stage, kind: progress.kind, code: progress.code ?? '', message: progress.message ?? '' })
    source.sendAction(LOCAL_ENVIRONMENT_ID, 'environment.server.reportInstall', [progress]).catch((err: unknown) => {
      // The server may already be going down with the app; the step is in this log either way.
      warn(TAG, 'host install step not reported to the server', { stage: progress.stage, error: String(err) })
    })
  }

  const run = async (request: HostInstallRequest): Promise<void> => {
    const kind = request.kind
    if (kind === 'restart') {
      report({ stage: 'restarting', kind })
      app.relaunch()
      await quitForUpdate()
      return
    }
    const refusal = installRefusal(policy)
    if (refusal) {
      report({ stage: 'refused', kind, code: refusal, message: HOST_INSTALL_REFUSALS[refusal] })
      return
    }
    if (kind === 'artifact') {
      await installArchiveNow(request.path, (stage) => report({ stage, kind }))
      return
    }
    if (request.version && request.version.replace(/^v/, '') === app.getVersion()) {
      report({ stage: 'refused', kind, code: 'up_to_date', message: `this desktop already runs ${app.getVersion()}` })
      return
    }
    if (!hasUpdateFeed()) {
      report({ stage: 'refused', kind, code: 'no_update_feed', message: 'this desktop is a local build with no release feed; send it a build instead' })
      return
    }
    const installed = await installLatestReleaseNow((stage) => report({ stage, kind }))
    if (!installed) report({ stage: 'refused', kind, code: 'up_to_date', message: `this desktop already runs the newest release (${app.getVersion()})` })
  }

  return source.onFrame((environmentId, frame) => {
    if (environmentId !== LOCAL_ENVIRONMENT_ID || frame.type !== 'studio_event' || frame.channel !== HOST_INSTALL_REQUESTED_CHANNEL) return
    if (!isRequest(frame.payload)) {
      warn(TAG, 'host install request malformed; ignored')
      return
    }
    const request = frame.payload
    if (busy) {
      report({ stage: 'refused', kind: request.kind, code: 'busy', message: 'this desktop is already installing' })
      return
    }
    busy = true
    log(TAG, 'host install requested by the local server', { kind: request.kind })
    run(request)
      .catch((err: unknown) => report({ stage: 'failed', kind: request.kind, message: err instanceof Error ? err.message : String(err) }))
      .finally(() => { busy = false })
  })
}
