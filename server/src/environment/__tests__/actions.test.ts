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

const { inbound } = vi.hoisted(() => ({ inbound: { path: '' } }))
vi.mock('../../transfer/inbound-transfer', () => ({ registerInboundTransfer: vi.fn(async () => inbound.path) }))

import { createHash } from 'crypto'
import { existsSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ENVIRONMENT_ACTIONS, setEnvironmentServerVersion } from '../actions'

const conn = { id: 'c', scopes: ['admin'], principal: { subject: 'paired:x', displayName: 'x' }, send: () => true } as unknown as Connection

describe('scopes', () => {
  it('reads need conversations:read, project and git mutations need git:write, server control and purge need admin', () => {
    const by = (scope: string) => Object.entries(ENVIRONMENT_ACTIONS).filter(([, s]) => s.requiredScope === scope).map(([n]) => n).sort()
    expect(by('conversations:read')).toEqual(['environment.discovery.status', 'environment.fs.browse', 'environment.git.author.get', 'environment.host.toolchains', 'environment.jobs.list', 'environment.projects.appraiseRemoval', 'environment.projects.list', 'environment.server.info', 'environment.systemMetrics.history', 'environment.systemMetrics.latest', 'environment.systemMetrics.watch'])
    expect(by('git:write')).toEqual(['environment.git.author.set', 'environment.git.test', 'environment.jobs.cancel', 'environment.projects.add', 'environment.projects.clone', 'environment.projects.relocate', 'environment.projects.remove', 'environment.projects.setup', 'environment.projects.trust'])
    expect(by('admin')).toEqual(['environment.discovery.close', 'environment.discovery.mintCode', 'environment.discovery.open', 'environment.purge.appraise', 'environment.purge.run', 'environment.server.installArtifact', 'environment.server.installNotice', 'environment.server.logTail', 'environment.server.reportInstall', 'environment.server.restart', 'environment.server.update'])
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

  // The test home has no ssh key and the connection no stored credential, so this host picks https.
  it('picks one url from a repository\'s ssh and https pair', async () => {
    startClone.mockClear()
    const remote = { sshUrl: 'git@github.com:example-org/app.git', httpsUrl: 'https://github.com/example-org/app.git' }
    await ENVIRONMENT_ACTIONS['environment.projects.clone'].handler(conn, [{ remote, parentDir: '~/src' }])
    expect((startClone.mock.calls[0] as unknown as [{ url: string }])[0].url).toBe(remote.httpsUrl)
    expect(await ENVIRONMENT_ACTIONS['environment.projects.clone'].handler(conn, [{ remote: { sshUrl: remote.sshUrl }, parentDir: '~/src' }])).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
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

describe('environment.server.installArtifact', () => {
  const install = ENVIRONMENT_ACTIONS['environment.server.installArtifact'].handler
  const build = Buffer.from('a build')
  const sha256 = createHash('sha256').update(build).digest('hex')
  const arrive = (): string => {
    inbound.path = join(mkdtempSync(join(tmpdir(), 'ion-artifact-')), 'build.tar.gz')
    writeFileSync(inbound.path, build)
    return inbound.path
  }

  it('needs a transfer id, a size, and a checksum', async () => {
    expect(await install(conn, [{ transferId: 't', totalBytes: 7 }])).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    expect(await install(conn, [{ sha256, totalBytes: 7 }])).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
  })

  it('refuses a build that is not the one that was sent, and deletes it', async () => {
    const path = arrive()
    const other = createHash('sha256').update('another build').digest('hex')
    expect(await install(conn, [{ transferId: 't1', totalBytes: build.length, sha256: other, name: 'build.tar.gz' }])).toMatchObject({ ok: false, refusal: { code: 'checksum_mismatch' } })
    expect(existsSync(path)).toBe(false)
  })

  it('hands a verified build to the host, which here has nothing to install with, and deletes the build nobody will read', async () => {
    const path = arrive()
    expect(await install(conn, [{ transferId: 't2', totalBytes: build.length, sha256, name: 'build.tar.gz' }])).toMatchObject({ ok: false, refusal: { code: 'no_bundle' } })
    expect(existsSync(path)).toBe(false)
  })

  it('takes an install report only from the desktop on the host', async () => {
    const report = ENVIRONMENT_ACTIONS['environment.server.reportInstall'].handler
    const onHost = { ...conn, transport: 'local' } as unknown as Connection
    const remote = { ...conn, transport: 'relay' } as unknown as Connection
    expect(await report(remote, [{ stage: 'installing', kind: 'release' }])).toMatchObject({ ok: false, refusal: { code: 'not_on_host' } })
    expect(await report(onHost, [{ stage: 'installing', kind: 'release' }])).toEqual({ ok: true, value: null })
    expect(await report(onHost, [{ stage: 'requested', kind: 'release' }])).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
  })
})
