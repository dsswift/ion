import { describe, expect, it } from 'vitest'
import {
  ALL_DEVELOPER_SURFACES_ENABLED,
  classifiedDeveloperSurfaceActions,
  deriveDeviceDeveloperSurfaces,
  deriveEnvironmentDeveloperSurfaces,
  developerSurfaceBlock,
  developerSurfaceChannelAllowed,
  developerSurfaceThinEventAllowed,
  developerSurfacesOfAction,
  intersectDeveloperSurfaces,
  isDeveloperSurfaceWire,
  parseDeveloperSurfaces,
  projectWorktreeSnapshotForSurfaces,
  readDeveloperSurfaces,
  repositoryFeedOffered,
} from '../developer-surfaces'
import { FORWARDED_ACTIONS } from '../studio-wire/actions'
import type { EnterprisePolicy } from '../types-enterprise'

const policy = (namespace: string, developerSurfaces: unknown): EnterprisePolicy => ({ customFields: { [namespace]: { developerSurfaces } } })

describe('parseDeveloperSurfaces', () => {
  it('leaves every surface on when nothing is configured', () => {
    expect(parseDeveloperSurfaces(undefined)).toEqual(ALL_DEVELOPER_SURFACES_ENABLED)
    expect(deriveEnvironmentDeveloperSurfaces(null)).toEqual(ALL_DEVELOPER_SURFACES_ENABLED)
    expect(deriveDeviceDeveloperSurfaces({})).toEqual(ALL_DEVELOPER_SURFACES_ENABLED)
  })

  it('controls each surface independently', () => {
    expect(parseDeveloperSurfaces({ sourceControl: 'disabled', commitGraph: 'disabled', repositoryStatus: 'enabled', worktrees: 'disabled' })).toEqual({
      sourceControl: false,
      commitGraph: false,
      repositoryStatus: true,
      worktrees: false,
      profiling: true,
    })
  })

  it('treats any value other than "disabled" as on', () => {
    expect(parseDeveloperSurfaces({ sourceControl: false, worktrees: 'off' })).toEqual(ALL_DEVELOPER_SURFACES_ENABLED)
  })

  it('reads the server and the device namespaces separately', () => {
    const server = policy('ion-server', { worktrees: 'disabled' })
    expect(deriveEnvironmentDeveloperSurfaces(server).worktrees).toBe(false)
    expect(deriveDeviceDeveloperSurfaces(server).worktrees).toBe(true)
    const device = policy('ion-desktop', { sourceControl: 'disabled' })
    expect(deriveDeviceDeveloperSurfaces(device).sourceControl).toBe(false)
    expect(deriveEnvironmentDeveloperSurfaces(device).sourceControl).toBe(true)
  })

  it('intersects two states', () => {
    const a = parseDeveloperSurfaces({ sourceControl: 'disabled' })
    const b = parseDeveloperSurfaces({ worktrees: 'disabled' })
    expect(intersectDeveloperSurfaces(a, b)).toEqual({ sourceControl: false, commitGraph: true, repositoryStatus: true, worktrees: false, profiling: true })
  })

  it('guards the wire shape', () => {
    expect(isDeveloperSurfaceWire(ALL_DEVELOPER_SURFACES_ENABLED)).toBe(true)
    expect(isDeveloperSurfaceWire({ sourceControl: true })).toBe(true)
    expect(isDeveloperSurfaceWire({ sourceControl: 'enabled' })).toBe(false)
    expect(isDeveloperSurfaceWire([])).toBe(false)
    expect(isDeveloperSurfaceWire(null)).toBe(false)
  })

  it('reads a surface the server does not name as on', () => {
    expect(readDeveloperSurfaces(undefined)).toEqual(ALL_DEVELOPER_SURFACES_ENABLED)
    expect(readDeveloperSurfaces({ sourceControl: false, commitGraph: true, repositoryStatus: true, worktrees: true })).toEqual({
      sourceControl: false,
      commitGraph: true,
      repositoryStatus: true,
      worktrees: true,
      profiling: true,
    })
  })
})

describe('developerSurfaceBlock', () => {
  it('blocks a single-surface action when its surface is off', () => {
    const state = parseDeveloperSurfaces({ sourceControl: 'disabled' })
    expect(developerSurfaceBlock('git.commit', state)).toEqual(['sourceControl'])
    expect(developerSurfaceBlock('git.graph', state)).toBeNull()
    expect(developerSurfaceBlock('convertToWorktree', state)).toBeNull()
  })

  it('keeps a shared read while any surface it feeds is on', () => {
    const statusOnly = parseDeveloperSurfaces({ sourceControl: 'disabled', commitGraph: 'disabled', worktrees: 'disabled' })
    expect(developerSurfaceBlock('git.changes', statusOnly)).toBeNull()
    expect(developerSurfaceBlock('git.subscribe', statusOnly)).toBeNull()
    expect(developerSurfaceBlock('git.diff', statusOnly)).not.toBeNull()
    const allOff = parseDeveloperSurfaces({ sourceControl: 'disabled', commitGraph: 'disabled', repositoryStatus: 'disabled', worktrees: 'disabled' })
    expect(developerSurfaceBlock('git.changes', allOff)).not.toBeNull()
    expect(developerSurfaceBlock('git.subscribe', allOff)).not.toBeNull()
  })

  it('never blocks an action outside the table', () => {
    const allOff = parseDeveloperSurfaces({ sourceControl: 'disabled', commitGraph: 'disabled', repositoryStatus: 'disabled', worktrees: 'disabled' })
    expect(developerSurfaceBlock('renameTab', allOff)).toBeNull()
    expect(developerSurfaceBlock('git.isRepo', allOff)).toBeNull()
    expect(developerSurfaceBlock('git.ignoredFiles', allOff)).toBeNull()
  })

  it('classifies every forwarded worktree and bench store action', () => {
    // renameTabAndWorktree renames the conversation first, which every
    // deployment needs, so it is deliberately not a worktree-surface action.
    const exempt = new Set(['renameTabAndWorktree'])
    const unclassified = Object.keys(FORWARDED_ACTIONS)
      .filter((name) => /worktree|bench/i.test(name) && !exempt.has(name))
      .filter((name) => developerSurfacesOfAction(name) === undefined)
    expect(unclassified).toEqual([])
  })

  it('classifies only store actions that are forwarded', () => {
    const stray = classifiedDeveloperSurfaceActions().filter((name) => !name.includes('.') && !(name in FORWARDED_ACTIONS))
    expect(stray).toEqual([])
  })
})

describe('developer surface events', () => {
  it('withholds worktree channels when worktrees are off', () => {
    const state = parseDeveloperSurfaces({ worktrees: 'disabled' })
    expect(developerSurfaceChannelAllowed('ion:worktree-landed', state)).toBe(false)
    expect(developerSurfaceChannelAllowed('ion:git-event', state)).toBe(true)
    expect(developerSurfaceChannelAllowed('ion:tab-status-change', state)).toBe(true)
    expect(developerSurfaceThinEventAllowed('desktop_bench_state', state)).toBe(false)
    expect(developerSurfaceThinEventAllowed('desktop_worktree_state', state)).toBe(false)
    expect(developerSurfaceThinEventAllowed('desktop_git_changes_response', state)).toBe(true)
  })

  it('withholds repository events only when no repository surface is on', () => {
    const statusOnly = parseDeveloperSurfaces({ sourceControl: 'disabled', commitGraph: 'disabled' })
    expect(developerSurfaceChannelAllowed('ion:git-event', statusOnly)).toBe(true)
    const none = parseDeveloperSurfaces({ sourceControl: 'disabled', commitGraph: 'disabled', repositoryStatus: 'disabled' })
    expect(developerSurfaceChannelAllowed('ion:git-event', none)).toBe(false)
    expect(developerSurfaceThinEventAllowed('desktop_git_changes_response', none)).toBe(false)
    expect(developerSurfaceThinEventAllowed('desktop_text_chunk', none)).toBe(true)
  })
})

describe('projectWorktreeSnapshotForSurfaces', () => {
  const snapshot = {
    revision: 4,
    ready: true,
    inventory: { '/repo': [] },
    workspaces: { '/repo': [] },
    benchSourceTips: [['/repo', { main: 'abc' }]],
    benchRetired: [['/repo', []]],
    gitConflictAlerts: [['/repo', { source: 'sync', dismissed: false, recordedAt: 1 }]],
    worktreePipeline: null,
    workspaceOperationLedger: [],
  } as unknown as import('../types-studio').StudioWorktreeSnapshot

  it('returns the snapshot untouched when both surfaces are on', () => {
    expect(projectWorktreeSnapshotForSurfaces(snapshot, ALL_DEVELOPER_SURFACES_ENABLED)).toBe(snapshot)
  })

  it('empties worktree and bench state, and keeps conflict alerts, when only worktrees are off', () => {
    const projected = projectWorktreeSnapshotForSurfaces(snapshot, parseDeveloperSurfaces({ worktrees: 'disabled' }))
    expect(projected.inventory).toEqual({})
    expect(projected.workspaces).toEqual({})
    expect(projected.benchSourceTips).toEqual([])
    expect(projected.benchRetired).toEqual([])
    expect(projected.gitConflictAlerts).toHaveLength(1)
    expect(projected.revision).toBe(4)
  })

  it('empties conflict alerts, and keeps worktree state, when only source control is off', () => {
    const projected = projectWorktreeSnapshotForSurfaces(snapshot, parseDeveloperSurfaces({ sourceControl: 'disabled' }))
    expect(projected.gitConflictAlerts).toEqual([])
    expect(projected.inventory).toEqual({ '/repo': [] })
  })
})

describe('repositoryFeedOffered', () => {
  it('is off only when no surface reads a repository', () => {
    expect(repositoryFeedOffered(parseDeveloperSurfaces({ sourceControl: 'disabled', commitGraph: 'disabled' }))).toBe(true)
    expect(repositoryFeedOffered(parseDeveloperSurfaces({ sourceControl: 'disabled', commitGraph: 'disabled', repositoryStatus: 'disabled' }))).toBe(false)
  })
})
