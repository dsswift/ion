import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../../engine/engine-bridge-fs', () => ({
  getEngineHostInfo: vi.fn(() => Promise.resolve({ ok: true, data: { version: '1.2.3' } })),
  getEnterprisePolicy: vi.fn(() => Promise.resolve(null)),
}))

vi.mock('../../state', async () => {
  const { enterprisePolicyCache } = await import('../../enterprise-policy-publish')
  return {
    engineBridge: { connected: true },
    deviceFocusMap: new Map(),
    state: { remoteTransport: null },
    enterprisePolicyCache,
  }
})

import { startHarness, connectLocal, waitOpen, sendFrame, nextFrame, helloFrame, closeSocket, resetConnectionRegistryForTest, type Harness } from './harness'
import { connectionRegistry, type Connection } from '../connection'
import { publishStudioEvent } from '../events'
import { registeredActionNames } from '../actions'
import { computeDeveloperSurfaces, projectSnapshotForSurfaces } from '../developer-surfaces'
import { enterprisePolicyCache, enterprisePolicyHash } from '../../enterprise-policy-publish'
import { developerSurfacesOfAction } from '@ion/shared/developer-surfaces'
import { gitWorktreeAdd, worktreesOffered } from '../../store/host-api-git'
import type { EnterprisePolicy } from '@ion/shared/types-enterprise'
import type { StudioFrame, StudioSnapshot } from '@ion/shared/studio-wire/types'

type ActionResult = Extract<StudioFrame, { type: 'studio_action_result' }>

const serverPolicy = (developerSurfaces: Record<string, string>): EnterprisePolicy => ({ customFields: { 'ion-server': { developerSurfaces } } })
const devicePolicy = (developerSurfaces: Record<string, string>): EnterprisePolicy => ({ customFields: { 'ion-desktop': { developerSurfaces } } })

let harness: Harness
let dataDir: string
let originalIonDataDir: string | undefined

beforeEach(async () => {
  originalIonDataDir = process.env.ION_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'ion-developer-surfaces-'))
  process.env.ION_DATA_DIR = dataDir
  enterprisePolicyCache.policy = null
  harness = await startHarness()
})

afterEach(async () => {
  await harness.close()
  resetConnectionRegistryForTest()
  enterprisePolicyCache.policy = null
  if (originalIonDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = originalIonDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

async function connectAndWelcome() {
  const ws = connectLocal(harness)
  await waitOpen(ws)
  sendFrame(ws, helloFrame())
  const welcome = (await nextFrame(ws)) as Extract<StudioFrame, { type: 'studio_welcome' }>
  const conn = connectionRegistry.all()[0]
  return { ws, conn, welcome }
}

/** Puts `policy` in force for `conn`, as a welcome or a policy change does. */
function apply(conn: Connection, policy: EnterprisePolicy): void {
  conn.developerSurfaces = computeDeveloperSurfaces(conn, policy)
  conn.policyHash = enterprisePolicyHash(policy)
}

async function act(ws: Awaited<ReturnType<typeof connectAndWelcome>>['ws'], action: string, args: unknown[]): Promise<ActionResult> {
  sendFrame(ws, { type: 'studio_action', id: `act-${action}`, action, args })
  return (await nextFrame(ws)) as ActionResult
}

describe('computeDeveloperSurfaces', () => {
  it('binds every connection to what the server offers', () => {
    const policy = serverPolicy({ sourceControl: 'disabled', worktrees: 'disabled' })
    for (const transport of ['local', 'tcp'] as const) {
      expect(computeDeveloperSurfaces({ transport }, policy)).toEqual({ sourceControl: false, commitGraph: true, repositoryStatus: true, worktrees: false })
    }
  })

  it('applies the device policy to the local connection only', () => {
    const policy = devicePolicy({ commitGraph: 'disabled' })
    expect(computeDeveloperSurfaces({ transport: 'local' }, policy).commitGraph).toBe(false)
    expect(computeDeveloperSurfaces({ transport: 'tcp' }, policy).commitGraph).toBe(true)
  })
})

describe('studio_welcome', () => {
  it('reports every surface on, and a policy hash, with no policy', async () => {
    const { ws, welcome } = await connectAndWelcome()
    expect(welcome.developerSurfaces).toEqual({ sourceControl: true, commitGraph: true, repositoryStatus: true, worktrees: true })
    expect(welcome.policyHash).toMatch(/^sha256:/)
    await closeSocket(ws)
  })
})

describe('studio_action under a disabled surface', () => {
  it('refuses a source-control write for a visiting connection', async () => {
    const { ws, conn } = await connectAndWelcome()
    ;(conn as unknown as { transport: string }).transport = 'tcp'
    apply(conn, serverPolicy({ sourceControl: 'disabled' }))
    const result = await act(ws, 'git.commit', [{ directory: dataDir, message: 'x' }])
    expect(result.ok).toBe(false)
    expect(result.refusal?.code).toBe('surface_disabled')
    await closeSocket(ws)
  })

  it('refuses it for the local connection too', async () => {
    const { ws, conn } = await connectAndWelcome()
    apply(conn, serverPolicy({ sourceControl: 'disabled' }))
    expect((await act(ws, 'git.stage', [{ directory: dataDir, paths: [] }])).refusal?.code).toBe('surface_disabled')
    await closeSocket(ws)
  })

  it('refuses the graph, worktree store actions, and worktree reads by their own surface', async () => {
    const { ws, conn } = await connectAndWelcome()
    apply(conn, serverPolicy({ commitGraph: 'disabled', worktrees: 'disabled' }))
    expect((await act(ws, 'git.graph', [{ directory: dataDir }])).refusal?.code).toBe('surface_disabled')
    expect((await act(ws, 'convertToWorktree', ['tab-1'])).refusal?.code).toBe('surface_disabled')
    expect((await act(ws, 'worktree.state', [{ repoPath: dataDir }])).refusal?.code).toBe('surface_disabled')
    expect((await act(ws, 'worktree.overlap.analyze', [{}, {}])).refusal?.code).toBe('surface_disabled')
    // Source control is still offered.
    expect((await act(ws, 'git.changes', [{ directory: dataDir }])).refusal?.code).not.toBe('surface_disabled')
    await closeSocket(ws)
  })

  it('keeps the repository feed while status is the only surface left on', async () => {
    const { ws, conn } = await connectAndWelcome()
    apply(conn, serverPolicy({ sourceControl: 'disabled', commitGraph: 'disabled', worktrees: 'disabled' }))
    expect((await act(ws, 'git.changes', [{ directory: dataDir }])).refusal?.code).not.toBe('surface_disabled')
    expect((await act(ws, 'git.diff', [{ directory: dataDir, path: 'a' }])).refusal?.code).toBe('surface_disabled')
    await closeSocket(ws)
  })

  it('refuses the local connection under a device policy and leaves a visiting one alone', async () => {
    const { ws, conn } = await connectAndWelcome()
    apply(conn, devicePolicy({ commitGraph: 'disabled' }))
    expect((await act(ws, 'git.graph', [{ directory: dataDir }])).refusal?.code).toBe('surface_disabled')
    ;(conn as unknown as { transport: string }).transport = 'tcp'
    apply(conn, devicePolicy({ commitGraph: 'disabled' }))
    expect((await act(ws, 'git.graph', [{ directory: dataDir }])).refusal?.code).not.toBe('surface_disabled')
    await closeSocket(ws)
  })

  it('answers the applied state without user content', async () => {
    const { ws, conn } = await connectAndWelcome()
    apply(conn, serverPolicy({ worktrees: 'disabled' }))
    const result = await act(ws, 'policy.getDeveloperSurfaces', [])
    expect(result.ok).toBe(true)
    const value = result.value as { developerSurfaces: unknown; policyHash: string }
    expect(Object.keys(value).sort()).toEqual(['developerSurfaces', 'policyHash'])
    expect(value.developerSurfaces).toEqual({ sourceControl: true, commitGraph: true, repositoryStatus: true, worktrees: false })
    expect(value.policyHash).toMatch(/^sha256:/)
    await closeSocket(ws)
  })
})

describe('events under a disabled surface', () => {
  it('withholds worktree state and delivers everything else', async () => {
    const { ws, conn } = await connectAndWelcome()
    apply(conn, serverPolicy({ worktrees: 'disabled' }))
    publishStudioEvent('ion:worktree-landed', [{ worktreePath: '/w' }])
    publishStudioEvent('ion:git-event', [{ directory: '/r' }])
    const frame = (await nextFrame(ws)) as Extract<StudioFrame, { type: 'studio_event' }>
    expect(frame.channel).toBe('ion:git-event')
    await closeSocket(ws)
  })
})

describe('worktree state under a disabled surface', () => {
  const full = { revision: 9, ready: true, inventory: { '/repo': [] }, workspaces: { '/repo': [] }, benchSourceTips: [], benchRetired: [], gitConflictAlerts: [], worktreePipeline: null, workspaceOperationLedger: [] }

  it('reaches a connection with its worktree and bench state emptied', async () => {
    const { ws, conn } = await connectAndWelcome()
    apply(conn, serverPolicy({ worktrees: 'disabled' }))
    publishStudioEvent('studio:worktree-sync', [full])
    const frame = (await nextFrame(ws)) as Extract<StudioFrame, { type: 'studio_event' }>
    expect(frame.channel).toBe('studio:worktree-sync')
    expect(frame.payload).toMatchObject({ revision: 9, inventory: {}, workspaces: {} })
    await closeSocket(ws)
  })

  it('is emptied in the snapshot a connection is welcomed with', () => {
    const snapshot = { worktrees: full } as unknown as StudioSnapshot
    const surfaces = computeDeveloperSurfaces({ transport: 'tcp' }, serverPolicy({ worktrees: 'disabled' }))
    expect(projectSnapshotForSurfaces(snapshot, surfaces).worktrees.inventory).toEqual({})
    expect(projectSnapshotForSurfaces(snapshot, computeDeveloperSurfaces({ transport: 'tcp' }, null))).toBe(snapshot)
  })
})

describe('worktree creation', () => {
  it('is refused at the one place a worktree is cut', async () => {
    enterprisePolicyCache.policy = serverPolicy({ worktrees: 'disabled' })
    expect(await worktreesOffered()).toBe(false)
    expect(await gitWorktreeAdd(dataDir, 'main')).toEqual({ ok: false, error: 'worktrees are not available on this server' })
  })
})

describe('action coverage', () => {
  it('classifies every registered git and worktree action', () => {
    // The directory picker and the file explorer need these two with every
    // developer surface off.
    const exempt = new Set(['git.isRepo', 'git.ignoredFiles'])
    const unclassified = [...registeredActionNames()]
      .filter((name) => name.startsWith('git.') || name.startsWith('worktree.'))
      .filter((name) => !exempt.has(name) && developerSurfacesOfAction(name) === undefined)
    expect(unclassified).toEqual([])
  })
})
