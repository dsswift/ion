/**
 * `POST /log` (spec 18): bearer- or session-cookie-authenticated log
 * forwarding for a browser Studio client's `rendererLogger`. Pins the auth
 * gate (no oidc / no credential / invalid bearer / unknown session -> 401)
 * and that an accepted line lands in `server.jsonl` stamped `component:
 * 'web'` with the tag prefixed `web:`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startHealth, type HealthHandle } from '../health'
import { logIngestRoute } from '../log-ingest'
import { BrowserSessionStore, newSessionId } from '../../auth/browser-session-store'
import { flushLogs, setLogLevel, _resetForTest as resetLoggerForTest, configureLogger } from '../../logger'
import { startJwksFixture, signToken, type JwksFixture } from '../../auth/__tests__/jwks-fixture'
import { _resetBearerJwksCacheForTest } from '../../auth/bearer'
import { _budgetLimitsForTest, _resetBudgetForTest } from '../log-ingest-budget'
import { _resetSeenForTest } from '../log-ingest-seen'
import type { ServerOidcConfig } from '../../config/server-config'

let health: HealthHandle | null = null
let dataDir: string | null = null
let fixture: JwksFixture | null = null
let previousDataDir: string | undefined
let sessions: BrowserSessionStore

function baseUrl(h: HealthHandle): string {
  const address = h.tcpServer?.address()
  if (!address || typeof address === 'string') throw new Error('expected an AddressInfo from the ephemeral TCP listener')
  return `http://127.0.0.1:${address.port}`
}

function oidcConfig(overrides: Partial<ServerOidcConfig> = {}): ServerOidcConfig {
  return {
    issuer: fixture!.issuer,
    audience: 'api://studio-server',
    scope: 'Studio.Access',
    clientId: 'spa-client-id',
    rolesToScopes: {},
    defaultScopes: ['conversations:read'],
    allowedSubjects: [],
    clientSecret: '',
    ...overrides,
  }
}

beforeEach(async () => {
  previousDataDir = process.env.ION_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'ion-log-ingest-test-'))
  process.env.ION_DATA_DIR = dataDir
  sessions = new BrowserSessionStore(dataDir)
  resetLoggerForTest()
  configureLogger({ disableRotation: true })
  _resetBudgetForTest()
  _resetSeenForTest()
  fixture = await startJwksFixture()
})

afterEach(async () => {
  flushLogs()
  if (health) await health.close()
  health = null
  await fixture?.close()
  fixture = null
  _resetBearerJwksCacheForTest()
  resetLoggerForTest()
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
  dataDir = null
  if (previousDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = previousDataDir
})

describe('POST /log', () => {
  it('refuses 401 when server.json has no oidc block', async () => {
    health = startHealth({ port: 0, routes: { '/log': logIngestRoute({ getOidc: () => null, sessions }) } })
    const res = await fetch(`${baseUrl(health)}/log`, { method: 'POST', body: JSON.stringify({ level: 'INFO', msg: 'x' }) })
    expect(res.status).toBe(401)
  })

  it('refuses 401 with no bearer token or session cookie presented', async () => {
    health = startHealth({ port: 0, routes: { '/log': logIngestRoute({ getOidc: () => oidcConfig(), sessions }) } })
    const res = await fetch(`${baseUrl(health)}/log`, { method: 'POST', body: JSON.stringify({ level: 'INFO', msg: 'x' }) })
    expect(res.status).toBe(401)
  })

  it('refuses 401 with an invalid bearer token', async () => {
    health = startHealth({ port: 0, routes: { '/log': logIngestRoute({ getOidc: () => oidcConfig(), sessions }) } })
    const res = await fetch(`${baseUrl(health)}/log`, {
      method: 'POST',
      headers: { Authorization: 'Bearer not-a-real-token' },
      body: JSON.stringify({ level: 'INFO', msg: 'x' }),
    })
    expect(res.status).toBe(401)
  })

  it('refuses 401 with an unknown session cookie', async () => {
    health = startHealth({ port: 0, routes: { '/log': logIngestRoute({ getOidc: () => oidcConfig(), sessions }) } })
    const res = await fetch(`${baseUrl(health)}/log`, {
      method: 'POST',
      headers: { Cookie: 'ion_session=not-a-real-session' },
      body: JSON.stringify({ level: 'INFO', msg: 'x' }),
    })
    expect(res.status).toBe(401)
  })

  it('accepts a valid bearer and appends component:web to server.jsonl', async () => {
    const token = await signToken(fixture!, { sub: 'web-user-1', aud: 'api://studio-server', scp: 'Studio.Access' })
    health = startHealth({ port: 0, routes: { '/log': logIngestRoute({ getOidc: () => oidcConfig(), sessions }) } })
    const res = await fetch(`${baseUrl(health)}/log`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ level: 'WARN', tag: 'BrowserStudioHost', msg: 'token renew failed', fields: { attempt: 2 } }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, written: true })

    flushLogs()
    const lines = readFileSync(join(dataDir!, 'server.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    const line = lines.find((l) => l.msg === 'token renew failed')
    expect(line).toBeDefined()
    expect(line?.component).toBe('web')
    expect(line?.level).toBe('WARN')
    expect(line?.tag).toBe('web:BrowserStudioHost')
    expect((line?.fields as Record<string, unknown>)?.attempt).toBe(2)
    expect((line?.fields as Record<string, unknown>)?.subject).toBe('web-user-1')
  })

  it('accepts a valid ion_session cookie and appends component:web to server.jsonl', async () => {
    const sessionId = newSessionId()
    sessions.create({
      sessionId,
      principal: { subject: 'web-session-user', displayName: 'Web Session User' },
      scopes: ['conversations:read'],
      accessToken: 'a',
      refreshToken: null,
      accessExpiresAt: Date.now() + 3600_000,
    })
    health = startHealth({ port: 0, routes: { '/log': logIngestRoute({ getOidc: () => oidcConfig(), sessions }) } })
    const res = await fetch(`${baseUrl(health)}/log`, {
      method: 'POST',
      headers: { Cookie: `ion_session=${sessionId}` },
      body: JSON.stringify({ level: 'INFO', tag: 'BrowserStudioHost', msg: 'session-authenticated log line' }),
    })
    expect(res.status).toBe(200)

    flushLogs()
    const lines = readFileSync(join(dataDir!, 'server.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    const line = lines.find((l) => l.msg === 'session-authenticated log line')
    expect(line).toBeDefined()
    expect((line?.fields as Record<string, unknown>)?.subject).toBe('web-session-user')
  })

  // A browser span line keeps tag `span` (the marker the span exporters read)
  // and its trace_id becomes the line's top-level trace_id.
  it('keeps a span line canonical: tag span, top-level trace_id', async () => {
    const token = await signToken(fixture!, { sub: 'web-user-1', aud: 'api://studio-server', scp: 'Studio.Access' })
    health = startHealth({ port: 0, routes: { '/log': logIngestRoute({ getOidc: () => oidcConfig(), sessions }) } })
    const trace = '4bf92f3577b34da6a3ce929d0e0e4736'
    const res = await fetch(`${baseUrl(health)}/log`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        level: 'INFO', tag: 'span', msg: 'prompt.send',
        fields: { trace_id: trace, span_id: '00f067aa0ba902b7', duration_ms: 42, span_kind: 'client', surface: 'studio-web' },
      }),
    })
    expect(res.status).toBe(200)

    flushLogs()
    const lines = readFileSync(join(dataDir!, 'server.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    const line = lines.find((l) => l.msg === 'prompt.send')
    expect(line).toMatchObject({ component: 'web', tag: 'span', trace_id: trace })
    expect(line?.fields).toMatchObject({ span_id: '00f067aa0ba902b7', duration_ms: 42, span_kind: 'client' })
    expect(line?.fields).not.toHaveProperty('trace_id')
  })

  it('refuses 400 when msg is missing', async () => {
    const token = await signToken(fixture!, { sub: 'web-user-2', aud: 'api://studio-server', scp: 'Studio.Access' })
    health = startHealth({ port: 0, routes: { '/log': logIngestRoute({ getOidc: () => oidcConfig(), sessions }) } })
    const res = await fetch(`${baseUrl(health)}/log`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ level: 'INFO' }),
    })
    expect(res.status).toBe(400)
  })

  it('refuses 405 on a non-POST method', async () => {
    health = startHealth({ port: 0, routes: { '/log': logIngestRoute({ getOidc: () => oidcConfig(), sessions }) } })
    const res = await fetch(`${baseUrl(health)}/log`, { method: 'GET' })
    expect(res.status).toBe(405)
  })
})

describe('POST /log reports whether the line actually landed', () => {
  /**
   * The route answered `{ok:true}` whether the line reached `server.jsonl` or
   * was discarded by the level filter. A browser client was told its
   * diagnostics had landed when they had not, and an investigation looking for
   * them afterwards could not tell a dropped line from a client that never
   * logged at all. `written` is what makes those two cases distinguishable.
   */
  it('answers written:false and writes nothing when the level filter discards the line', async () => {
    const sessionId = newSessionId()
    sessions.create({
      sessionId,
      principal: { subject: 'web-level-user', displayName: 'Web Level User' },
      scopes: ['conversations:read'],
      accessToken: 'a',
      refreshToken: null,
      accessExpiresAt: Date.now() + 3600_000,
    })
    health = startHealth({ port: 0, routes: { '/log': logIngestRoute({ getOidc: () => oidcConfig(), sessions }) } })
    setLogLevel('ERROR')
    try {
      const res = await fetch(`${baseUrl(health)}/log`, {
        method: 'POST',
        headers: { Cookie: `ion_session=${sessionId}` },
        body: JSON.stringify({ level: 'DEBUG', tag: 'probe', msg: 'discarded by the level filter' }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, written: false })

      flushLogs()
      expect(readFileSync(join(dataDir!, 'server.jsonl'), 'utf-8')).not.toContain('discarded by the level filter')
    } finally {
      setLogLevel('INFO')
    }
  })

  it('refuses a caller that is over its budget, and says how many it dropped', async () => {
    // The logger's shared limiter keys on (level, tag, msg) and never limits
    // ERROR -- correct for the server's own lines, and an open door for a
    // caller that picks its own tag, message and level. A browser could
    // otherwise write without bound and rotate away the evidence of it doing
    // so.
    const token = await signToken(fixture!, { sub: 'noisy-user', aud: 'api://studio-server', scp: 'Studio.Access' })
    health = startHealth({ port: 0, routes: { '/log': logIngestRoute({ getOidc: () => oidcConfig(), sessions }) } })
    const url = `${baseUrl(health)}/log`
    const send = (i: number) => fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      // A distinct message and ERROR each time: both are what slipped past
      // the shared limiter.
      body: JSON.stringify({ level: 'ERROR', tag: 'flood', msg: `line ${i}` }),
    })

    const limit = _budgetLimitsForTest.LINES_PER_WINDOW
    for (let i = 0; i < limit; i++) expect((await send(i)).status).toBe(200)

    const refused = await send(limit)
    expect(refused.status).toBe(429)
    expect(await refused.json()).toEqual({ error: 'rate_limited', written: false })

    flushLogs()
    const raw = readFileSync(join(dataDir!, 'server.jsonl'), 'utf-8')
    expect(raw).toContain('caller is over its budget')
  })

  it('budgets each caller separately, so one noisy client cannot mute another', async () => {
    const noisy = await signToken(fixture!, { sub: 'noisy-user', aud: 'api://studio-server', scp: 'Studio.Access' })
    const quiet = await signToken(fixture!, { sub: 'quiet-user', aud: 'api://studio-server', scp: 'Studio.Access' })
    health = startHealth({ port: 0, routes: { '/log': logIngestRoute({ getOidc: () => oidcConfig(), sessions }) } })
    const url = `${baseUrl(health)}/log`
    const send = (token: string, msg: string) => fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ level: 'INFO', tag: 'x', msg }),
    })

    for (let i = 0; i < _budgetLimitsForTest.LINES_PER_WINDOW + 1; i++) await send(noisy, `noise ${i}`)
    expect((await send(quiet, 'a quiet line')).status).toBe(200)
  })

  it('drops the fields the server owns, so a caller cannot misattribute its lines', async () => {
    // The logger lets caller fields win on collision, so an unfiltered client
    // could stamp another process's pid or another machine's identity onto
    // its own lines and have a central collector believe it.
    const token = await signToken(fixture!, { sub: 'web-user-1', aud: 'api://studio-server', scp: 'Studio.Access' })
    health = startHealth({ port: 0, routes: { '/log': logIngestRoute({ getOidc: () => oidcConfig(), sessions }) } })
    const res = await fetch(`${baseUrl(health)}/log`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'TestBrowser/1.0' },
      body: JSON.stringify({
        level: 'INFO',
        tag: 'forge',
        msg: 'a line claiming to be someone else',
        fields: { pid: 1, host: 'someone-elses-mac', machine_id: 'MID-X', subject: 'admin', keep_me: 'yes' },
      }),
    })
    expect(res.status).toBe(200)

    flushLogs()
    const lines = readFileSync(join(dataDir!, 'server.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    const line = lines.find((l) => l.msg === 'a line claiming to be someone else')
    const fields = line?.fields as Record<string, unknown>
    expect(fields.pid).toBe(process.pid)
    expect(fields.host).toBeUndefined()
    expect(fields.machine_id).toBeUndefined()
    expect(fields.subject).toBe('web-user-1')
    // Everything the client legitimately knows survives, plus who sent it.
    expect(fields.keep_me).toBe('yes')
    expect(fields.user_agent).toBe('TestBrowser/1.0')
  })
})

describe('POST /log repeated lines', () => {
  // A browser re-sends, after a page load, a line whose reply it never read.
  // The server already wrote it once.
  it('writes a line_id once and answers the repeat as delivered', async () => {
    const token = await signToken(fixture!, { sub: 'web-user-dup', aud: 'api://studio-server', scp: 'Studio.Access' })
    health = startHealth({ port: 0, routes: { '/log': logIngestRoute({ getOidc: () => oidcConfig(), sessions }) } })
    const send = () => fetch(`${baseUrl(health!)}/log`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ level: 'INFO', tag: 'studio', msg: 'visibility changed', fields: { line_id: 'line-1' } }),
    })
    expect(await (await send()).json()).toEqual({ ok: true, written: true })
    expect(await (await send()).json()).toEqual({ ok: true, written: false, duplicate: true })

    flushLogs()
    const written = readFileSync(join(dataDir!, 'server.jsonl'), 'utf-8').trim().split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.msg === 'visibility changed')
    expect(written).toHaveLength(1)
  })

  it('keeps each subject\'s ids apart', async () => {
    const a = await signToken(fixture!, { sub: 'web-user-a', aud: 'api://studio-server', scp: 'Studio.Access' })
    const b = await signToken(fixture!, { sub: 'web-user-b', aud: 'api://studio-server', scp: 'Studio.Access' })
    health = startHealth({ port: 0, routes: { '/log': logIngestRoute({ getOidc: () => oidcConfig(), sessions }) } })
    const send = (token: string) => fetch(`${baseUrl(health!)}/log`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ level: 'INFO', msg: 'same id', fields: { line_id: 'shared-id' } }),
    })
    expect(await (await send(a)).json()).toMatchObject({ written: true })
    expect(await (await send(b)).json()).toMatchObject({ written: true })
  })
})
