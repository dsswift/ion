/** environment.* actions — scope requirements per verb, argument validation, and that a refused mutation comes back as a refusal rather than a thrown error. */
import { describe, expect, it, vi } from 'vitest'
import type { Connection } from '../../protocol/connection'

vi.mock('../../broadcast', () => ({ broadcast: vi.fn() }))
vi.mock('../../engine/engine-bridge-fs', () => ({ peekEngineHostInfo: () => ({ version: '9.9.9' }) }))
const { engineRequest } = vi.hoisted(() => ({
  engineRequest: vi.fn(async (cmd: string) => cmd === 'health'
    ? { ok: true, data: { version: '9.9.9', compat: [{ id: 'conversation-file', owner: 'engine', version: '2', rule: 'host-storage', meaning: 'm' }] } }
    : { ok: true, data: [{ key: 'a', hasActiveRun: true }, { key: 'b', hasActiveRun: false }, { key: 'c', hasActiveRun: true }] }),
}))
vi.mock('../../state', () => ({ engineBridge: { request: engineRequest } }))
const { startClone } = vi.hoisted(() => ({ startClone: vi.fn(async () => ({ jobId: 'j', dir: '/src/r' })) }))
vi.mock('../clone', () => ({ startClone }))
const { metrics } = vi.hoisted(() => ({ metrics: { publisher: null as null | { latest: () => unknown; watch: (...a: unknown[]) => unknown } } }))
vi.mock('../../system-metrics/runtime', () => ({ systemMetricsPublisher: () => metrics.publisher }))
vi.mock('../../engine/telemetry-health', () => ({ telemetryHealthState: () => [{ target: 'otlp', healthy: true }] }))

import { ENVIRONMENT_ACTIONS, setEnvironmentServerVersion } from '../actions'

const conn = { id: 'c', scopes: ['admin'], principal: { subject: 'paired:x', displayName: 'x' }, send: () => true } as unknown as Connection

describe('scopes', () => {
  it('reads need conversations:read, project and git mutations need git:write, server control and purge need admin', () => {
    const by = (scope: string) => Object.entries(ENVIRONMENT_ACTIONS).filter(([, s]) => s.requiredScope === scope).map(([n]) => n).sort()
    expect(by('conversations:read')).toEqual(['environment.discovery.status', 'environment.fs.browse', 'environment.git.author.get', 'environment.git.hostKeys', 'environment.host.toolchains', 'environment.jobs.list', 'environment.projects.appraiseRemoval', 'environment.projects.list', 'environment.server.info', 'environment.systemMetrics.history', 'environment.systemMetrics.latest', 'environment.systemMetrics.watch'])
    expect(by('git:write')).toEqual(['environment.git.author.set', 'environment.git.test', 'environment.jobs.cancel', 'environment.projects.add', 'environment.projects.clone', 'environment.projects.relocate', 'environment.projects.remove', 'environment.projects.setup', 'environment.projects.trust'])
    expect(by('admin')).toEqual(['environment.discovery.close', 'environment.discovery.mintCode', 'environment.discovery.open', 'environment.purge.appraise', 'environment.purge.run', 'environment.server.logTail', 'environment.server.restart', 'environment.server.update'])
  })
})

describe('argument validation and outcomes', () => {
  it('names the missing argument and reports server info with the booted version', async () => {
    expect(await ENVIRONMENT_ACTIONS['environment.projects.add'].handler(conn, [{}])).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    expect(await ENVIRONMENT_ACTIONS['environment.projects.clone'].handler(conn, [{ url: 'x' }])).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    expect(await ENVIRONMENT_ACTIONS['environment.server.logTail'].handler(conn, [{ file: 'other' }])).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    expect(await ENVIRONMENT_ACTIONS['environment.jobs.cancel'].handler(conn, [{ jobId: 'nope' }])).toEqual({ ok: true, value: { cancelled: false } })
    setEnvironmentServerVersion('0.4.2')
    const info = await ENVIRONMENT_ACTIONS['environment.server.info'].handler(conn, [])
    expect(info).toMatchObject({ ok: true, value: { serverVersion: '0.4.2', engineVersion: '9.9.9', bundle: null } })
    const value = (info as { value: import('@ion/shared/types-environment-admin').EnvironmentServerInfo }).value
    expect(value.runningConversations).toBe(2)
    expect(value.engineMinVersion).toBe('0.0.0')
    expect(value.engineMeetsMin).toBe(true)
    expect(value.formats?.find((f) => f.id === 'transfer-archive')?.owner).toBe('server')
    expect(value.formats?.find((f) => f.id === 'conversation-file')?.owner).toBe('engine')
    const add = await ENVIRONMENT_ACTIONS['environment.projects.add'].handler(conn, [{ dir: '/definitely/not/here' }])
    expect(add).toMatchObject({ ok: false, error: { code: 'add_failed' } })
    const restart = await ENVIRONMENT_ACTIONS['environment.server.restart'].handler(conn, [])
    expect(restart).toMatchObject({ ok: false, refusal: { code: 'no_bundle' } })
  })
})

describe('environment.projects.clone', () => {
  // Trust is only ever the operator's explicit yes: a boolean true, never
  // a truthy string or an absent field.
  it('passes trust through only when it is true', async () => {
    await ENVIRONMENT_ACTIONS['environment.projects.clone'].handler(conn, [{ url: 'u', parentDir: '~/src', trust: true }])
    await ENVIRONMENT_ACTIONS['environment.projects.clone'].handler(conn, [{ url: 'u', parentDir: '~/src', trust: 'yes' }])
    await ENVIRONMENT_ACTIONS['environment.projects.clone'].handler(conn, [{ url: 'u', parentDir: '~/src' }])
    expect(startClone.mock.calls.map((c) => (c as unknown as [{ trust: boolean }])[0].trust)).toEqual([true, false, false])
  })
})

describe('environment.systemMetrics.latest', () => {
  it('returns the newest sample and telemetry health without touching any watch', async () => {
    const watch = vi.fn()
    metrics.publisher = { latest: () => ({ sampledAt: 7 }), watch }
    expect(await ENVIRONMENT_ACTIONS['environment.systemMetrics.latest'].handler(conn, [])).toEqual({
      ok: true, value: { latest: { sampledAt: 7 }, telemetryHealth: [{ target: 'otlp', healthy: true }] },
    })
    expect(watch).not.toHaveBeenCalled()
  })

  it('answers a null sample, not a refusal, where the server samples nothing', async () => {
    metrics.publisher = null
    expect(await ENVIRONMENT_ACTIONS['environment.systemMetrics.latest'].handler(conn, [])).toMatchObject({ ok: true, value: { latest: null } })
  })
})
