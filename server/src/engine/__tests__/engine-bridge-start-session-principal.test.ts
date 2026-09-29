import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userInfo } from 'os'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startSession } from '../engine-bridge-start-session'
import type { EngineBridge } from '../engine-bridge'
import type { EngineConfig } from '@ion/shared/types'
import { registerPrincipal, _resetPrincipalRegistryForTest } from '../../identity/principal-registry'
import { _resetPrincipalIndexForTest } from '../../protocol/tabs-index'
import { execFileSync } from 'child_process'
import { _resetGitCredentialStoreForTest, gitCredentialStore } from '../../git/identity/credential-store'

const signedIn = vi.hoisted(() => ({ identity: null as { user: string; oid: string } | null }))
vi.mock('../../oauth/entra-flow', () => ({
  getSignedInIdentityIfEngineConnected: vi.fn(() => Promise.resolve(signedIn.identity)),
}))

/**
 * Pins the manifest-C1-default wiring `engine-bridge-start-session.ts` adds:
 * every `start_session` dispatch carries `principal: localPrincipal()` so
 * the engine attributes the session (and logs "session principal set",
 * `engine/internal/session/start_session.go`) rather than leaving it
 * unowned. `local-principal.ts`'s own docblock already documented this as
 * the intended default before this wiring existed -- this test is the
 * regression pin for that documented, now-implemented behavior.
 */
function fakeBridge(sendWithData: ReturnType<typeof vi.fn>): EngineBridge {
  return {
    activeSessions: new Map(),
    retirePendingAbort: vi.fn(),
    nextSessionGeneration: vi.fn(() => 1),
    connect: vi.fn(() => Promise.resolve()),
    _sendWithData: sendWithData,
    updateSessionConversationId: vi.fn(),
    sendReconcileState: vi.fn(),
  } as unknown as EngineBridge
}

let dataDir: string
let originalIonDataDir: string | undefined

beforeEach(() => {
  originalIonDataDir = process.env.ION_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'ion-start-session-principal-'))
  process.env.ION_DATA_DIR = dataDir
})

afterEach(() => {
  signedIn.identity = null
  _resetPrincipalIndexForTest()
  _resetPrincipalRegistryForTest()
  if (originalIonDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = originalIonDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

describe('startSession principal attribution', () => {
  it('stamps the tab owner\'s registered principal on the start_session wire payload', async () => {
    writeFileSync(join(dataDir, 'tabs.json'), JSON.stringify({ tabs: [{ id: 'key-1', principalSubject: 'alice' }] }))
    registerPrincipal({ subject: 'alice', displayName: 'Alice', provider: 'entra', kind: 'operator' })

    const sendWithData = vi.fn((_msg: Record<string, unknown>) => Promise.resolve({ ok: true, data: { conversationId: 'conv-1' } }))
    const bridge = fakeBridge(sendWithData)
    const config: EngineConfig = { workingDirectory: '/tmp' } as EngineConfig

    await startSession(bridge, 'key-1', config)

    const [payload] = sendWithData.mock.calls[0] as [Record<string, unknown>]
    expect(payload.principal).toEqual({
      subject: 'alice',
      provider: 'entra',
      kind: 'operator',
      username: undefined,
      displayName: 'Alice',
      multiTenant: true,
    })
  })

  it('falls back to localPrincipal() on the start_session wire payload when the tab has no registered owner', async () => {
    const sendWithData = vi.fn((_msg: Record<string, unknown>) => Promise.resolve({ ok: true, data: { conversationId: 'conv-1' } }))
    const bridge = fakeBridge(sendWithData)
    const config: EngineConfig = { workingDirectory: '/tmp' } as EngineConfig

    await startSession(bridge, 'key-1', config)

    expect(sendWithData).toHaveBeenCalledTimes(1)
    const [payload] = sendWithData.mock.calls[0] as [Record<string, unknown>]
    expect(payload.cmd).toBe('start_session')
    expect(payload.key).toBe('key-1')
    expect(payload.principal).toMatchObject({
      subject: `local:${userInfo().username}`,
      provider: 'os',
      kind: 'local',
    })
  })
})

describe('startSession signed-in attribution', () => {
  function startAndCapture(): Promise<Record<string, unknown>> {
    const sendWithData = vi.fn((_msg: Record<string, unknown>) => Promise.resolve({ ok: true, data: { conversationId: 'conv-1' } }))
    return startSession(fakeBridge(sendWithData), 'key-1', { workingDirectory: '/tmp' } as EngineConfig).then(
      () => (sendWithData.mock.calls[0] as [Record<string, unknown>])[0].principal as Record<string, unknown>,
    )
  }

  it('labels a local fallback session with the engine\'s signed-in identity, keeping the OS subject', async () => {
    signedIn.identity = { user: 'user@example.com', oid: 'oid-1' }

    const principal = await startAndCapture()

    expect(principal).toMatchObject({
      subject: `local:${userInfo().username}`,
      kind: 'local',
      displayName: userInfo().username,
      attribution: 'user@example.com',
    })
  })

  it('leaves a local fallback session unlabelled when nobody is signed in', async () => {
    const principal = await startAndCapture()

    expect(principal.attribution).toBeUndefined()
  })

  it('never relabels a registered owner', async () => {
    signedIn.identity = { user: 'user@example.com', oid: 'oid-1' }
    writeFileSync(join(dataDir, 'tabs.json'), JSON.stringify({ tabs: [{ id: 'key-1', principalSubject: 'alice' }] }))
    registerPrincipal({ subject: 'alice', displayName: 'Alice', provider: 'entra', kind: 'operator' })

    const principal = await startAndCapture()

    expect(principal.attribution).toBeUndefined()
    expect(principal.displayName).toBe('Alice')
  })
})

describe('startSession FR-04 git credential wiring', () => {
  it('merges a resolved workspace credential into the start_session config.toolEnv', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'ion-start-session-git-repo-'))
    execFileSync('git', ['init', '-q'], { cwd: repoDir })
    execFileSync('git', ['remote', 'add', 'origin', 'git@gitlab.example.com:org/repo.git'], { cwd: repoDir })
    _resetGitCredentialStoreForTest(dataDir)
    gitCredentialStore().set({ subject: 'alice', host: 'gitlab.example.com', source: 'user', kind: 'ssh', privateKey: 'FAKE-KEY', publicKey: 'ssh-ed25519 AAAA' })

    try {
      writeFileSync(join(dataDir, 'tabs.json'), JSON.stringify({ tabs: [{ id: 'key-1', principalSubject: 'alice' }] }))
      registerPrincipal({ subject: 'alice', displayName: 'Alice', provider: 'entra', kind: 'operator' })

      const sendWithData = vi.fn((_msg: Record<string, unknown>) => Promise.resolve({ ok: true, data: { conversationId: 'conv-1' } }))
      const bridge = fakeBridge(sendWithData)
      const config: EngineConfig = { workingDirectory: repoDir, toolEnv: { CUSTOM: 'x' } } as unknown as EngineConfig

      await startSession(bridge, 'key-1', config)

      const [payload] = sendWithData.mock.calls[0] as [{ config: EngineConfig }]
      expect(payload.config.toolEnv?.CUSTOM).toBe('x')
      expect(payload.config.toolEnv?.GIT_SSH_COMMAND).toContain('IdentitiesOnly=yes')
    } finally {
      rmSync(repoDir, { recursive: true, force: true })
    }
  })

  it('leaves config.toolEnv untouched when nothing resolves', async () => {
    writeFileSync(join(dataDir, 'tabs.json'), JSON.stringify({ tabs: [{ id: 'key-1', principalSubject: 'alice' }] }))
    registerPrincipal({ subject: 'alice', displayName: 'Alice', provider: 'entra', kind: 'operator' })

    const sendWithData = vi.fn((_msg: Record<string, unknown>) => Promise.resolve({ ok: true, data: { conversationId: 'conv-1' } }))
    const bridge = fakeBridge(sendWithData)
    const config: EngineConfig = { workingDirectory: '/tmp' } as EngineConfig

    await startSession(bridge, 'key-1', config)

    const [payload] = sendWithData.mock.calls[0] as [{ config: EngineConfig }]
    expect(payload.config.toolEnv).toBeUndefined()
  })
})
