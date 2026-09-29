/**
 * Real-engine integration lane (manifest child 11 Acceptance Criteria):
 * builds and boots the actual `engine/cmd/ion` binary, starts the server
 * in-process against the SAME `ION_DATA_DIR`, and proves the two talk to
 * each other for real -- no mocked engine bridge (contrast
 * `src/__tests__/boot.test.ts`, which mocks `../state` deliberately).
 *
 * `ION_DATA_DIR` is set by `setup-data-dir.ts` (this config's `setupFiles`)
 * BEFORE this file's own imports resolve -- see that file's docblock. Do not
 * reassign `process.env.ION_DATA_DIR` here: `server/src/logger.ts` already
 * captured it into a top-level constant the moment any server module was
 * first imported (including transitively, via the `harness` import below),
 * so a later reassignment would desync the log file location from
 * `dataDir()`'s per-call resolution everywhere else.
 *
 * Requires Go on PATH (`go build ./cmd/ion`). Run via
 * `npm -w server run test:integration`, never as part of the fast
 * `npm -w server test` suite (see `vitest.integration.config.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import WebSocket from 'ws'
import { startEngine, cleanupEngineDataDir, type EngineHandle } from './engine-harness'
import { closeSocket, helloFrame, nextFrame, sendFrame, waitOpen } from '../../src/protocol/__tests__/harness'
import type { ServerHandle } from '../../src/main'
import type { AddressInfo } from 'net'
import { createAuthProof, deriveChannelId } from '@ion/shared/e2e'
import { sealRelayFrame, openRelayFrame } from '@ion/shared/studio-wire/relay-envelope'
import { encodeFrame, decodeFrame } from '@ion/shared/studio-wire/codec'
import { PROTOCOL_VERSION } from '@ion/shared/studio-wire/version'
import type { StudioFrame } from '@ion/shared/studio-wire/types'

const ALLOWED_MODELS = ['integration-test-model-a', 'integration-test-model-b']

// Set by setup-data-dir.ts before this module's imports resolved.
const dataDir = process.env.ION_DATA_DIR
if (!dataDir) throw new Error('ION_DATA_DIR was not set by setup-data-dir.ts')

let engine: EngineHandle
let server: ServerHandle

function readEngineLog(): string {
  try {
    return readFileSync(join(dataDir, 'engine.jsonl'), 'utf-8')
  } catch {
    return ''
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${description}`)
}

beforeAll(async () => {
  const enterpriseConfigPath = join(dataDir, 'enterprise.json')
  writeFileSync(enterpriseConfigPath, JSON.stringify({ allowedModels: ALLOWED_MODELS }))

  // startEngine spawns with `env: {...process.env, ION_DATA_DIR}`, so setting
  // ION_ENTERPRISE_CONFIG on THIS process's env before calling it is what
  // gets the engine child process to load the mounted policy file.
  process.env.ION_ENTERPRISE_CONFIG = enterpriseConfigPath
  engine = await startEngine({ dataDir, socketWaitMs: 20000 })

  // Ephemeral TCP port (0 = OS-assigned) so this suite never collides with a
  // real server.json on the machine running the test, and no oidc block so
  // the `local` credential hello resolves without a JWKS fixture.
  writeFileSync(join(dataDir, 'server.json'), JSON.stringify({ listen: { tcp: { port: 0 } }, web: { enabled: false } }))

  const { main } = await import('../../src/main')
  server = await main()

  await waitFor(() => server.getReadiness().ready === true, 15000, 'server readyz to become ready against the real engine')
}, 40000)

afterAll(async () => {
  await server?.close()
  await engine?.stop()
  cleanupEngineDataDir(dataDir)
}, 20000)

function studioSocketUrl(): string {
  return `ws+unix://${join(dataDir, 'studio.sock')}:/`
}

describe('server + real engine (child 11 integration lane)', () => {
  it('completes a real studio_hello/studio_welcome round trip', async () => {
    const ws = new WebSocket(studioSocketUrl())
    await waitOpen(ws)
    sendFrame(ws, helloFrame())
    const frame = await nextFrame(ws, 10000)
    expect(frame.type).toBe('studio_welcome')
    await closeSocket(ws)
  })

  it('reflects the mounted enterprise policy file in studio_welcome.enterprisePolicy', async () => {
    // `listener.ts` caches the enterprise policy and refreshes it
    // fire-and-forget on each new connection (never blocks `handleHello` on
    // an engine round trip) -- so the first hello right after boot can race
    // the first refresh. Reconnecting until the cache has caught up is the
    // real behavior a client observes on a fresh connection, not a fudge.
    const deadline = Date.now() + 10000
    let allowedModels: string[] | undefined
    while (Date.now() < deadline) {
      const ws = new WebSocket(studioSocketUrl())
      await waitOpen(ws)
      sendFrame(ws, helloFrame())
      const frame = await nextFrame(ws, 5000)
      if (frame.type !== 'studio_welcome') throw new Error(`expected studio_welcome, got ${frame.type}`)
      allowedModels = frame.enterprisePolicy?.allowedModels
      await closeSocket(ws)
      if (allowedModels && allowedModels.length > 0) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    expect(allowedModels).toEqual(ALLOWED_MODELS)
  })

  it('sends the session principal to the engine and the engine logs it', async () => {
    const { engineBridge } = await import('../../src/state')
    const key = 'integration-test-session'
    const result = await engineBridge.startSession(key, { workingDirectory: dataDir } as never)
    expect(result.ok).toBe(true)

    await waitFor(
      () => readEngineLog().includes('"msg":"session principal set"') && readEngineLog().includes(`"session_key":"${key}"`),
      10000,
      'engine.jsonl to contain a "session principal set" line for this session',
    )
    const line = readEngineLog()
      .split('\n')
      .find((l) => l.includes('"msg":"session principal set"') && l.includes(`"session_key":"${key}"`))
    expect(line).toBeDefined()
    expect(line).toContain('"kind":"local"')
  })

  // The whole point of the thin view: a phone can operate against a server
  // with no desktop Studio running anywhere. Nothing in this process is a
  // desktop; the only client is the sealed, paired, thin one dialed here.
  describe('a thin paired client with no desktop attached', () => {
    const secret = Buffer.alloc(32, 0x5a)
    const clientId = deriveChannelId(secret).slice(0, 16)

    interface Received { channel: string; payload: Record<string, unknown> | null }

    async function connectThin(): Promise<{ ws: WebSocket; welcome: Extract<StudioFrame, { type: 'studio_welcome' }>; events: Received[]; results: Map<string, Extract<StudioFrame, { type: 'studio_action_result' }>> }> {
      const { credentialsStore } = await import('../../src/auth/credentials-store')
      if (!credentialsStore().get(clientId)) {
        credentialsStore().add({ clientId, secret, scopes: ['conversations:read', 'conversations:operate', 'git:write', 'terminal:operate'], subject: (await import('../../src/identity/paired-subject')).hostSubject(), kind: 'mobile', label: 'integration phone' })
      }
      const port = (server.tcpServer!.address() as AddressInfo).port
      const config = (await (await fetch(`http://127.0.0.1:${port}/auth/config`)).json()) as { nonce: string; sealedTcp?: boolean }
      expect(config.sealedTcp).toBe(true)

      const ws = new WebSocket(`ws://127.0.0.1:${port}/studio?client=${clientId}`)
      await waitOpen(ws)
      const events: Received[] = []
      const results = new Map<string, Extract<StudioFrame, { type: 'studio_action_result' }>>()
      let resolveWelcome: (frame: Extract<StudioFrame, { type: 'studio_welcome' }>) => void = () => {}
      const welcomed = new Promise<Extract<StudioFrame, { type: 'studio_welcome' }>>((resolve) => { resolveWelcome = resolve })
      ws.on('message', (data) => {
        const opened = openRelayFrame(data.toString('utf-8'), secret)
        if (!opened || opened.isBinary) throw new Error('the server sent a frame this pairing could not open')
        const frame = decodeFrame(opened.bytes.toString('utf-8'))
        if (frame.type === 'studio_welcome') resolveWelcome(frame)
        else if (frame.type === 'studio_event') events.push({ channel: frame.channel, payload: frame.payload as Record<string, unknown> | null })
        else if (frame.type === 'studio_action_result') results.set(frame.id, frame)
        else if (frame.type === 'studio_refused') throw new Error(`refused: ${frame.reason}`)
      })
      ws.send(sealRelayFrame(encodeFrame({
        type: 'studio_hello', protocolVersion: PROTOCOL_VERSION, clientId, clientKind: 'mobile', capabilities: [], view: 'thin',
        credential: { kind: 'paired', clientId, proof: createAuthProof(config.nonce, secret) },
      }), secret))
      const welcome = await Promise.race([welcomed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no welcome within 10s')), 10000))])
      return { ws, welcome, events, results }
    }

    const thinTypes = (events: Received[]): unknown[] => events.filter((e) => e.channel === 'studio:thin-event').map((e) => e.payload?.type)

    it('is welcomed with an empty store and then painted entirely over studio:thin-event', async () => {
      const { ws, welcome, events } = await connectThin()
      expect(welcome.pairedClientId).toBe(clientId)
      expect(welcome.snapshot.tabs).toEqual([])

      await waitFor(() => thinTypes(events).includes('desktop_presence'), 15000, 'the thin first paint to finish (presence is its last event)')
      expect(thinTypes(events)).toEqual(expect.arrayContaining(['desktop_snapshot', 'desktop_engine_profiles', 'desktop_settings_snapshot', 'desktop_theme_manifest', 'desktop_presence']))
      expect(thinTypes(events)[0]).toBe('desktop_snapshot')
      // Nothing a mirror gets: no raw engine stream, no store syncs.
      const channels = new Set(events.map((e) => e.channel))
      for (const mirrorOnly of ['ion:normalized-event', 'studio:tabs-sync', 'studio:worktree-sync', 'studio:conversation-terminals']) expect(channels.has(mirrorOnly), mirrorOnly).toBe(false)
      expect(channels.has('studio:client-log-request')).toBe(true)
      await closeSocket(ws)
    })

    it('creates a conversation by action and sees it arrive, with no desktop to have made it', async () => {
      const { ws, events, results } = await connectThin()
      await waitFor(() => thinTypes(events).includes('desktop_presence'), 15000, 'first paint')
      ws.send(sealRelayFrame(encodeFrame({ type: 'studio_action', id: 'act-1', action: 'tabs.create', args: [{ workingDirectory: dataDir, clientCmdId: 'integration-create-1' }] }), secret))
      await waitFor(() => results.has('act-1'), 15000, 'tabs.create to answer')
      const result = results.get('act-1')!
      expect(result.ok, JSON.stringify(result)).toBe(true)
      const tabId = (result as { value: { tabId: string } }).value.tabId
      expect(typeof tabId).toBe('string')

      await waitFor(
        () => events.some((e) => e.channel === 'studio:thin-event' && (e.payload?.type === 'desktop_tab_created' ? (e.payload.tab as { id?: string } | undefined)?.id === tabId : e.payload?.type === 'desktop_snapshot' && Array.isArray(e.payload.tabs) && (e.payload.tabs as Array<{ id?: string }>).some((t) => t.id === tabId))),
        15000,
        'the new tab to reach the thin client as desktop_tab_created or in a snapshot',
      )
      await closeSocket(ws)
    })
  })

  it('flips readyz to false (engine_unreachable) after the engine process is killed', async () => {
    await engine.stop()
    await waitFor(() => server.getReadiness().ready === false, 10000, 'readiness to flip to not-ready after the engine dies')
    expect(server.getReadiness().reason).toBe('engine_unreachable')
  })
})
