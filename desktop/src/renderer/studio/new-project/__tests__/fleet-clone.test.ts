/** fleet-clone — every target clones at once into its own folder and is followed to done or failed through its server's job snapshots. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FleetCloneState } from '../fleet-clone'

const mocks = vi.hoisted(() => ({
  action: vi.fn(),
  frameListeners: new Set<(envId: string, frame: unknown) => void>(),
  settings: {} as Record<string, unknown>,
}))

vi.mock('../../../host/host-instance', () => ({
  host: {
    onFrame: (cb: (envId: string, frame: unknown) => void) => { mocks.frameListeners.add(cb); return () => mocks.frameListeners.delete(cb) },
    deviceSettings: async () => mocks.settings,
  },
  action: (...args: unknown[]) => mocks.action(...args),
}))
vi.mock('../../../rendererLogger', () => ({ rError: vi.fn(), rWarn: vi.fn(), rInfo: vi.fn(), rDebug: vi.fn() }))

const { startFleetClone, isSettled } = await import('../fleet-clone')

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
function job(env: string, snapshot: Record<string, unknown>): void {
  for (const cb of [...mocks.frameListeners]) cb(env, { type: 'studio_event', channel: 'ion:project-job', payload: { kind: 'clone', startedAt: 1, stage: '', ...snapshot } })
}
const remote = { sshUrl: 'git@github.com:example-org/app.git', httpsUrl: 'https://github.com/example-org/app.git' }
const targets = [{ environmentId: 'local', label: 'This Mac' }, { environmentId: 'devbox', label: 'devbox' }]

let states: Record<string, FleetCloneState[]>
const onState = (env: string, state: FleetCloneState): void => { (states[env] ??= []).push(state) }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.frameListeners.clear()
  mocks.settings = { environmentCloneBaseDirectories: { devbox: '/srv/src' } }
  states = {}
})

describe('startFleetClone', () => {
  it('clones onto every target at once, each into its own base folder, and follows each job to done', async () => {
    mocks.action.mockImplementation(async (env: string) => ({ jobId: `job-${env}`, dir: env === 'devbox' ? '/srv/src/app' : '/home/src/app' }))
    startFleetClone({ targets, source: remote, name: 'app', trust: true, onState })
    await flush()
    expect(mocks.action.mock.calls).toEqual([
      ['local', 'environment.projects.clone', [{ remote, parentDir: '~/source', name: 'app', trust: true }]],
      ['devbox', 'environment.projects.clone', [{ remote, parentDir: '/srv/src', name: 'app', trust: true }]],
    ])
    job('devbox', { id: 'job-devbox', dir: '/srv/src/app', phase: 'running', stage: 'receiving objects', percent: 40 })
    job('devbox', { id: 'job-other', dir: '/srv/src/else', phase: 'failed', error: 'not ours' })
    job('devbox', { id: 'job-devbox', dir: '/srv/src/app', phase: 'done', stage: 'registering' })
    job('local', { id: 'job-local', dir: '/home/src/app', phase: 'done', stage: 'registering' })
    expect(states.devbox).toEqual([
      { phase: 'queued' },
      { phase: 'cloning', dir: '/srv/src/app', stage: 'starting' },
      { phase: 'cloning', dir: '/srv/src/app', stage: 'receiving objects', percent: 40 },
      { phase: 'done', dir: '/srv/src/app' },
    ])
    expect(states.local.at(-1)).toEqual({ phase: 'done', dir: '/home/src/app' })
    expect(mocks.frameListeners.size).toBe(0)
  })

  it('reports one server\'s refusal and one server\'s failed job without touching the other', async () => {
    mocks.action.mockImplementation(async (env: string) => {
      if (env === 'local') throw new Error('/home/src/app already exists on this host.')
      return { jobId: 'job-devbox', dir: '/srv/src/app' }
    })
    startFleetClone({ targets, source: 'git@github.com:example-org/app.git', name: 'app', trust: false, onState })
    await flush()
    expect(mocks.action.mock.calls[0][2]).toEqual([{ url: 'git@github.com:example-org/app.git', parentDir: '~/source', name: 'app' }])
    expect(states.local.at(-1)).toEqual({ phase: 'failed', error: '/home/src/app already exists on this host.' })
    expect(isSettled(states.devbox.at(-1))).toBe(false)
    job('devbox', { id: 'job-devbox', dir: '/srv/src/app', phase: 'failed', stage: 'cloning', error: 'git clone exited 128:\nPermission denied (publickey).' })
    expect(states.devbox.at(-1)).toEqual({ phase: 'failed', error: 'git clone exited 128:\nPermission denied (publickey).' })
  })

  it('applies a job snapshot that arrived before the clone action answered', async () => {
    let answer: (value: { jobId: string; dir: string }) => void = () => {}
    mocks.action.mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    startFleetClone({ targets: [targets[1]], source: remote, name: 'app', trust: true, onState })
    await flush()
    job('devbox', { id: 'job-devbox', dir: '/srv/src/app', phase: 'done', stage: 'registering' })
    expect(states.devbox).toEqual([{ phase: 'queued' }])
    answer({ jobId: 'job-devbox', dir: '/srv/src/app' })
    await flush()
    expect(states.devbox.at(-1)).toEqual({ phase: 'done', dir: '/srv/src/app' })
  })
})
