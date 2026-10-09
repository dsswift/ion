/**
 * `profile.capture` is a developer-surface action: refused with
 * `surface_disabled` (and logged) on a connection whose policy switched
 * `profiling` off, refused without the `admin` scope, and otherwise a CPU
 * profile of this process under `<data dir>/profiles/`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const logger = vi.hoisted(() => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn(), info: vi.fn(), logWeb: vi.fn(), flushLogs: vi.fn() }))
vi.mock('../../logger', () => logger)
vi.mock('../../state', () => ({
  engineBridge: { connected: true },
  deviceFocusMap: new Map(),
  state: { remoteTransport: null },
  enterprisePolicyCache: { policy: null },
  sessionPlane: {},
}))

import { handleAction } from '../actions'
import { recordingConnection } from './recording-connection'
import { developerSurfacesOfAction } from '@ion/shared/developer-surfaces'
import type { StudioFrame } from '@ion/shared/studio-wire/types'

type Result = Extract<StudioFrame, { type: 'studio_action_result' }>
let dataDir: string
let previous: string | undefined

beforeEach(() => {
  previous = process.env.ION_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'ion-profile-actions-'))
  process.env.ION_DATA_DIR = dataDir
  for (const fn of Object.values(logger)) fn.mockClear()
})
afterEach(() => {
  if (previous === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = previous
  rmSync(dataDir, { recursive: true, force: true })
})

describe('profile.capture', () => {
  it('belongs to the profiling developer surface', () => {
    expect(developerSurfacesOfAction('profile.capture')).toEqual(['profiling'])
  })

  it('is refused, with the reason logged, when the connection may not reach the profiling surface', async () => {
    const { conn, sent } = recordingConnection({ scopes: ['admin'] })
    conn.developerSurfaces = { ...conn.developerSurfaces, profiling: false }
    await handleAction(conn, { type: 'studio_action', id: 'p1', action: 'profile.capture', args: [{ kind: 'cpu', seconds: 1 }] })
    expect((sent[0] as Result).refusal?.code).toBe('surface_disabled')
    expect(logger.warn).toHaveBeenCalledWith('studio-actions', 'action refused: developer surface disabled', expect.objectContaining({ action: 'profile.capture', surfaces: ['profiling'] }))
    expect(existsSync(join(dataDir, 'profiles'))).toBe(false)
  })

  it('is refused without the admin scope', async () => {
    const { conn, sent } = recordingConnection({ scopes: ['conversations:operate', 'git:write', 'terminal:operate'] })
    await handleAction(conn, { type: 'studio_action', id: 'p2', action: 'profile.capture', args: [{ kind: 'heap' }] })
    expect((sent[0] as Result).refusal?.code).toBe('scope')
  })

  it('refuses a kind that is neither cpu nor heap', async () => {
    const { conn, sent } = recordingConnection({ scopes: ['admin'] })
    await handleAction(conn, { type: 'studio_action', id: 'p3', action: 'profile.capture', args: [{ kind: 'flame' }] })
    expect((sent[0] as Result).error?.code).toBe('invalid_argument')
  })

  it('captures a CPU profile into the data directory and answers its path', async () => {
    const { conn, sent } = recordingConnection({ scopes: ['admin'] })
    await handleAction(conn, { type: 'studio_action', id: 'p4', action: 'profile.capture', args: [{ kind: 'cpu', seconds: 1 }] })
    const result = sent[0] as Result
    expect(result.ok).toBe(true)
    const value = result.value as { kind: string; path: string; bytes: number }
    expect(value.kind).toBe('cpu')
    expect(value.path.startsWith(join(dataDir, 'profiles'))).toBe(true)
    expect(existsSync(value.path)).toBe(true)
    expect(logger.log).toHaveBeenCalledWith('profile-actions', 'profile captured', expect.objectContaining({ kind: 'cpu', path: value.path }))
  }, 15_000)
})
