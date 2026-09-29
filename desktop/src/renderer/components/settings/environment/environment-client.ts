/**
 * environment-client — the renderer's typed face on the `environment.*`,
 * `gitIdentity.*`, and `auth.*` studio_actions the Environment page runs
 * against ONE environment (ADR-033), plus the hooks that keep its lists
 * live: projects re-list on `ion:projects-changed`, jobs update on every
 * `ion:project-job` snapshot. The local environment is reached the same
 * way (`action('local', …)`), so the local environment's page is the one
 * projects UI rather than a second implementation.
 */
import { useCallback, useEffect, useState } from 'react'
import type {
  EnvironmentProject, EnvironmentFsBrowse, EnvironmentToolchains, EnvironmentServerInfo, EnvironmentLogFile,
  EnvironmentJob, EnvironmentGitTest, EnvironmentGitAuthor, EnvironmentPurgeAppraisal, EnvironmentPurgeLevels, EnvironmentPurgeResult, EnvironmentDiscoveryStatus, PairedDevice,
} from '@ion/shared/types-environment-admin'
import { PROJECT_JOB_CHANNEL, PROJECTS_CHANGED_CHANNEL } from '@ion/shared/types-environment-admin'
import type { GitIdentitySummary } from '@ion/shared/types-git-identity'
import type { Scope } from '@ion/shared/studio-wire/types'
import { host, action } from '../../../host/host-instance'
import { rInfo, rWarn } from '../../../rendererLogger'

export interface PairedClient {
  clientId: string
  scopes: Scope[]
  subject: string
  createdAt: number
  lastSeen: number
  revokedAt: number | null
  kind: 'desktop' | 'mobile'
  label?: string
  /** Whether a connection from this device is open now. Absent from a server that predates it. */
  connected?: boolean
}

/** A one-time pairing link as a server minted it. The link is a bearer secret. */
export interface MintedPairingLink {
  url: string
  code: string
  expiresAt: number
}

export interface RemovalAppraisal {
  dir: string
  registered: boolean
  clonedByIon: boolean
  exists: boolean
  dirty: boolean
  worktrees: number
}

function call<T>(environmentId: string, name: string, args: unknown[] = []): Promise<T> {
  return action(environmentId, name, args) as Promise<T>
}

export const environmentClient = {
  listProjects: (env: string) => call<EnvironmentProject[]>(env, 'environment.projects.list'),
  addProject: (env: string, dir: string, name?: string) => call<EnvironmentProject>(env, 'environment.projects.add', [{ dir, ...(name ? { name } : {}) }]),
  appraiseRemoval: (env: string, dir: string) => call<RemovalAppraisal>(env, 'environment.projects.appraiseRemoval', [{ dir }]),
  removeProject: (env: string, dir: string, opts: { deleteFiles?: boolean; force?: boolean } = {}) => call<{ removed: boolean; deletedFiles: boolean }>(env, 'environment.projects.remove', [{ dir, ...opts }]),
  relocateProject: (env: string, from: string, to: string) => call<EnvironmentProject>(env, 'environment.projects.relocate', [{ from, to }]),
  setupProject: (env: string, dir: string) => call<{ jobId: string }>(env, 'environment.projects.setup', [{ dir }]),
  trustProject: (env: string, dir: string) => call<EnvironmentProject>(env, 'environment.projects.trust', [{ dir }]),
  cloneProject: (env: string, url: string, parentDir: string, name?: string) => call<{ jobId: string; dir: string }>(env, 'environment.projects.clone', [{ url, parentDir, ...(name ? { name } : {}) }]),
  listJobs: (env: string) => call<EnvironmentJob[]>(env, 'environment.jobs.list'),
  cancelJob: (env: string, jobId: string) => call<{ cancelled: boolean }>(env, 'environment.jobs.cancel', [{ jobId }]),
  browse: (env: string, path: string, showHidden: boolean) => call<EnvironmentFsBrowse>(env, 'environment.fs.browse', [{ path, showHidden }]),
  toolchains: (env: string) => call<EnvironmentToolchains>(env, 'environment.host.toolchains'),
  serverInfo: (env: string) => call<EnvironmentServerInfo>(env, 'environment.server.info'),
  logTail: (env: string, file: EnvironmentLogFile, lines: number) => call<{ path: string; lines: string[] }>(env, 'environment.server.logTail', [{ file, lines }]),
  restart: (env: string) => call<{ scheduled: boolean }>(env, 'environment.server.restart'),
  update: (env: string) => call<{ scheduled: boolean }>(env, 'environment.server.update'),
  gitTest: (env: string, url: string) => call<EnvironmentGitTest>(env, 'environment.git.test', [{ url }]),
  gitHostKeys: (env: string) => call<Array<{ file: string; type: string; comment: string }>>(env, 'environment.git.hostKeys'),
  gitAuthorGet: (env: string) => call<EnvironmentGitAuthor>(env, 'environment.git.author.get'),
  gitAuthorSet: (env: string, author: EnvironmentGitAuthor) => call<EnvironmentGitAuthor>(env, 'environment.git.author.set', [author]),
  gitIdentityList: (env: string) => call<GitIdentitySummary[]>(env, 'gitIdentity.list'),
  gitIdentityMint: (env: string, gitHost: string) => call<{ publicKey: string }>(env, 'gitIdentity.mintSshKey', [{ host: gitHost }]),
  gitIdentitySetKey: (env: string, gitHost: string, privateKey: string) => call<{ publicKey: string }>(env, 'gitIdentity.setSshKey', [{ host: gitHost, privateKey }]),
  gitIdentityAuthorize: (env: string, gitHost: string) => call<{ started: boolean }>(env, 'gitIdentity.authorize', [{ host: gitHost }]),
  gitIdentitySetToken: (env: string, gitHost: string, token: string, username?: string) => call<void>(env, 'gitIdentity.setToken', [{ host: gitHost, token, ...(username ? { username } : {}) }]),
  gitIdentityRemove: (env: string, gitHost: string) => call<{ removed: boolean }>(env, 'gitIdentity.remove', [{ host: gitHost }]),
  purgeAppraise: (env: string) => call<EnvironmentPurgeAppraisal>(env, 'environment.purge.appraise'),
  purgeRun: (env: string, levels: Omit<EnvironmentPurgeLevels, 'studio'>) => call<EnvironmentPurgeResult>(env, 'environment.purge.run', [levels]),
  listClients: (env: string) => call<PairedClient[]>(env, 'auth.listClients'),
  revokeClient: (env: string, clientId: string) => call<{ revoked: boolean }>(env, 'auth.revokeClient', [{ clientId }]),
  mintPairingLink: (env: string, label: string, scopes?: Scope[]) => call<MintedPairingLink>(env, 'auth.createPairingLink', [{ label, ...(scopes ? { scopes } : {}) }]),
  /** A link for one of the caller's own devices; needs no admin. The device acts as the caller, with the caller's scopes. */
  mintOwnPairingLink: (env: string, label: string) => call<MintedPairingLink>(env, 'auth.createOwnPairingLink', [{ label }]),
  /** The caller's own paired devices; needs no admin. */
  listOwnDevices: (env: string) => call<PairedDevice[]>(env, 'environment.devices'),
  discoveryStatus: (env: string) => call<EnvironmentDiscoveryStatus>(env, 'environment.discovery.status'),
  discoveryOpen: (env: string, minutes: number) => call<EnvironmentDiscoveryStatus>(env, 'environment.discovery.open', [{ minutes }]),
  discoveryClose: (env: string) => call<EnvironmentDiscoveryStatus>(env, 'environment.discovery.close'),
  discoveryMintCode: (env: string) => call<{ code: string; expiresAt: number }>(env, 'environment.discovery.mintCode'),
}

function isStudioEvent(frame: unknown): frame is { type: 'studio_event'; channel: string; payload: unknown } {
  return !!frame && typeof frame === 'object' && (frame as { type?: unknown }).type === 'studio_event'
}

/** Subscribes to one environment's studio_event channel. */
export function onEnvironmentEvent(environmentId: string, channel: string, cb: (payload: unknown) => void): () => void {
  return host.onFrame((envId, frame) => {
    if (envId === environmentId && isStudioEvent(frame) && frame.channel === channel) cb(frame.payload)
  })
}

/** A load-once-then-refresh resource keyed by environment. */
export function useEnvironmentResource<T>(environmentId: string, load: (env: string) => Promise<T>, deps: unknown[] = []): { data: T | null; error: string | null; loading: boolean; refresh(): void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick((t) => t + 1), [])
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    load(environmentId).then((value) => {
      if (cancelled) return
      setData(value)
      setError(null)
    }).catch((err: unknown) => {
      if (cancelled) return
      rWarn('environment-client', 'resource load failed', { environment_id: environmentId, error: String(err) })
      setError(err instanceof Error ? err.message : String(err))
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` is the caller's cache key; `load` is a stable module function
  }, [environmentId, tick, ...deps])
  return { data, error, loading, refresh }
}

/** The environment's projects, re-listed whenever it announces a registry change. */
export function useEnvironmentProjects(environmentId: string) {
  const resource = useEnvironmentResource(environmentId, environmentClient.listProjects)
  useEffect(() => onEnvironmentEvent(environmentId, PROJECTS_CHANGED_CHANNEL, () => {
    rInfo('environment-client', 'projects changed; re-listing', { environment_id: environmentId })
    resource.refresh()
  }), [environmentId, resource.refresh]) // eslint-disable-line react-hooks/exhaustive-deps -- refresh is stable
  return resource
}

/** Every job the environment reports, newest first, kept current from `ion:project-job` snapshots. */
export function useEnvironmentJobs(environmentId: string): EnvironmentJob[] {
  const [jobs, setJobs] = useState<EnvironmentJob[]>([])
  useEffect(() => {
    let cancelled = false
    environmentClient.listJobs(environmentId).then((list) => { if (!cancelled) setJobs(list) }).catch((err: unknown) => {
      rWarn('environment-client', 'jobs list failed', { environment_id: environmentId, error: String(err) })
    })
    const off = onEnvironmentEvent(environmentId, PROJECT_JOB_CHANNEL, (payload) => {
      const job = payload as EnvironmentJob
      setJobs((prev) => {
        const rest = prev.filter((j) => j.id !== job.id)
        return [job, ...rest].sort((a, b) => b.startedAt - a.startedAt)
      })
    })
    return () => { cancelled = true; off() }
  }, [environmentId])
  return jobs
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** "just now", "3 min ago", "2 h ago", or a date. */
export function formatAgo(ms: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ms)
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`
  return new Date(ms).toLocaleDateString()
}

const CLONE_BASE_SETTING = 'environmentCloneBaseDirectories'

/** Where new clones land on an environment; a per-device preference keyed by environment id, defaulting to `~/src`. */
/** The folder clones land under on `environmentId` (a device setting per environment), defaulting to `~/source`. */
export async function readCloneBaseDir(environmentId: string): Promise<string> {
  const settings = await host.deviceSettings()
  const map = settings[CLONE_BASE_SETTING]
  const value = map && typeof map === 'object' ? (map as Record<string, unknown>)[environmentId] : undefined
  return typeof value === 'string' && value.trim() ? value : '~/source'
}

export function useCloneBaseDir(environmentId: string): [string, (next: string) => void] {
  const [base, setBase] = useState('~/source')
  useEffect(() => {
    void readCloneBaseDir(environmentId).then(setBase).catch((err: unknown) => rWarn('environment-client', 'clone base read failed', { error: String(err) }))
  }, [environmentId])
  const update = (next: string): void => {
    setBase(next)
    void host.deviceSettings().then((settings) => {
      const map = settings[CLONE_BASE_SETTING] && typeof settings[CLONE_BASE_SETTING] === 'object' ? { ...(settings[CLONE_BASE_SETTING] as Record<string, string>) } : {}
      map[environmentId] = next
      return host.setDeviceSetting(CLONE_BASE_SETTING, map)
    }).catch((err: unknown) => rWarn('environment-client', 'clone base write failed', { error: String(err) }))
  }
  return [base, update]
}

