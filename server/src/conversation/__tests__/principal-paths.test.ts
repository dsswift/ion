import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { principalDir, principalConversationsDir, resolveConversationsDir, resolveConversationsDirSync } from '../principal-paths'

let originalIonDataDir: string | undefined

beforeEach(() => {
  originalIonDataDir = process.env.ION_DATA_DIR
  process.env.ION_DATA_DIR = '/tmp/ion-principal-paths-test'
})

afterEach(() => {
  if (originalIonDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = originalIonDataDir
  vi.restoreAllMocks()
})

// Cross-checked against the Go implementation (conversation.PrincipalDir) --
// these exact values were printed by a one-off `go test` run against the
// real engine function, not just re-derived from the TS side. A drift
// between the two implementations would silently split a principal's
// conversations across two different directories on disk.
describe('principalDir: cross-language parity with the Go implementation', () => {
  it.each([
    ['oidc:alice', 'oidc-alice--edbcc36c119ba282'],
    ['oidc/alice', 'oidc-alice--f6b38e5ed118f838'],
    ['local:bob-smith', 'local-bob-smith--5ff9a0229183f5c8'],
    ['', 'principal--e3b0c44298fc1c14'],
  ])('principalDir(%j) === %j', (subject, expected) => {
    expect(principalDir(subject)).toBe(expected)
  })

  it('is deterministic', () => {
    expect(principalDir('oidc:alice')).toBe(principalDir('oidc:alice'))
  })

  it('two subjects that sanitize to the same prefix never collide', () => {
    expect(principalDir('oidc:alice')).not.toBe(principalDir('oidc/alice'))
  })
})

describe('principalConversationsDir', () => {
  it('builds the principals/<dir>/conversations path under dataDir', () => {
    const got = principalConversationsDir('oidc:alice')
    expect(got).toBe(join('/tmp/ion-principal-paths-test', 'principals', 'oidc-alice--edbcc36c119ba282', 'conversations'))
  })
})

vi.mock('../../engine/engine-bridge-fs', () => ({
  getEngineHostInfo: vi.fn(),
  peekEngineHostInfo: vi.fn(),
}))

describe('resolveConversationsDir', () => {
  it('returns the flat root for an unattributed caller regardless of partitioning state', async () => {
    const { getEngineHostInfo } = await import('../../engine/engine-bridge-fs')
    vi.mocked(getEngineHostInfo).mockResolvedValue({ ok: true, data: { principalPartitioning: { enabled: true, enforcement: 'strict', root: '/x' } } } as never)

    const got = await resolveConversationsDir(undefined)
    expect(got).toBe(join('/tmp/ion-principal-paths-test', 'conversations'))
  })

  it('returns the flat root when the engine reports partitioning disabled', async () => {
    const { getEngineHostInfo } = await import('../../engine/engine-bridge-fs')
    vi.mocked(getEngineHostInfo).mockResolvedValue({ ok: true, data: { principalPartitioning: { enabled: false, enforcement: 'none', root: '/x' } } } as never)

    const got = await resolveConversationsDir('oidc:alice')
    expect(got).toBe(join('/tmp/ion-principal-paths-test', 'conversations'))
  })

  it('returns the flat root when get_host_info fails (fail open to today\'s behavior)', async () => {
    const { getEngineHostInfo } = await import('../../engine/engine-bridge-fs')
    vi.mocked(getEngineHostInfo).mockResolvedValue({ ok: false, error: 'disconnected' } as never)

    const got = await resolveConversationsDir('oidc:alice')
    expect(got).toBe(join('/tmp/ion-principal-paths-test', 'conversations'))
  })

  it('returns the partition dir for an attributed caller when partitioning is enabled', async () => {
    const { getEngineHostInfo } = await import('../../engine/engine-bridge-fs')
    vi.mocked(getEngineHostInfo).mockResolvedValue({ ok: true, data: { principalPartitioning: { enabled: true, enforcement: 'strict', root: '/x' } } } as never)

    const got = await resolveConversationsDir('oidc:alice')
    expect(got).toBe(principalConversationsDir('oidc:alice'))
  })
})

describe('resolveConversationsDirSync', () => {
  it('returns the flat root for an unattributed caller', async () => {
    const { peekEngineHostInfo } = await import('../../engine/engine-bridge-fs')
    vi.mocked(peekEngineHostInfo).mockReturnValue({ principalPartitioning: { enabled: true, enforcement: 'strict', root: '/x' } } as never)

    expect(resolveConversationsDirSync(undefined)).toBe(join('/tmp/ion-principal-paths-test', 'conversations'))
  })

  it('returns the flat root when the host-info cache is cold (never fetched yet)', async () => {
    const { peekEngineHostInfo } = await import('../../engine/engine-bridge-fs')
    vi.mocked(peekEngineHostInfo).mockReturnValue(null)

    expect(resolveConversationsDirSync('oidc:alice')).toBe(join('/tmp/ion-principal-paths-test', 'conversations'))
  })

  it('returns the flat root when the cached info says partitioning is disabled', async () => {
    const { peekEngineHostInfo } = await import('../../engine/engine-bridge-fs')
    vi.mocked(peekEngineHostInfo).mockReturnValue({ principalPartitioning: { enabled: false, enforcement: 'none', root: '/x' } } as never)

    expect(resolveConversationsDirSync('oidc:alice')).toBe(join('/tmp/ion-principal-paths-test', 'conversations'))
  })

  it('returns the partition dir when the cache says partitioning is enabled', async () => {
    const { peekEngineHostInfo } = await import('../../engine/engine-bridge-fs')
    vi.mocked(peekEngineHostInfo).mockReturnValue({ principalPartitioning: { enabled: true, enforcement: 'strict', root: '/x' } } as never)

    expect(resolveConversationsDirSync('oidc:alice')).toBe(principalConversationsDir('oidc:alice'))
  })
})
