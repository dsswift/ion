/**
 * FR-01: session-meta.ts's direct conversation-file readers must resolve a
 * conversation ID's OWNER's partition directory once partitioning is
 * enabled, not the flat root -- otherwise conversationExists() silently
 * says "no" for every attributed session's own conversations, breaking the
 * restore/resume decision path (#230/#231's own regression class, this
 * time caused by partitioning rather than a stale id).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

vi.mock('../protocol/tabs-index', () => ({
  principalSubjectForConversation: vi.fn(),
}))
vi.mock('../engine/engine-bridge-fs', () => ({
  peekEngineHostInfo: vi.fn(),
}))

let originalIonDataDir: string | undefined

beforeEach(() => {
  originalIonDataDir = process.env.ION_DATA_DIR
  process.env.ION_DATA_DIR = '/tmp/ion-session-meta-partition-test'
})

afterEach(() => {
  if (originalIonDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = originalIonDataDir
  vi.restoreAllMocks()
})

describe('conversationExists: partition-aware resolution', () => {
  it('finds a conversation that lives in its owner\'s partition, not the flat root', async () => {
    const { principalSubjectForConversation } = await import('../protocol/tabs-index')
    const { peekEngineHostInfo } = await import('../engine/engine-bridge-fs')
    vi.mocked(principalSubjectForConversation).mockReturnValue('oidc:alice')
    vi.mocked(peekEngineHostInfo).mockReturnValue({ principalPartitioning: { enabled: true, enforcement: 'strict', root: '/x' } } as never)

    const { principalConversationsDir } = await import('../conversation/principal-paths')
    const partitionDir = principalConversationsDir('oidc:alice')
    mkdirSync(partitionDir, { recursive: true })
    writeFileSync(join(partitionDir, 'conv-1.llm.jsonl'), '{"meta":true}\n')
    writeFileSync(join(partitionDir, 'conv-1.tree.jsonl'), '{"meta":true}\n')

    const { conversationExists } = await import('../session-meta')
    expect(conversationExists('conv-1')).toBe(true)
  })

  it('does not find a conversation in the flat root that actually lives in a partition', async () => {
    const { principalSubjectForConversation } = await import('../protocol/tabs-index')
    const { peekEngineHostInfo } = await import('../engine/engine-bridge-fs')
    vi.mocked(principalSubjectForConversation).mockReturnValue('oidc:alice')
    vi.mocked(peekEngineHostInfo).mockReturnValue({ principalPartitioning: { enabled: true, enforcement: 'strict', root: '/x' } } as never)

    // No file written anywhere for 'conv-missing'.
    const { conversationExists } = await import('../session-meta')
    expect(conversationExists('conv-missing')).toBe(false)
  })

  it('falls back to the flat root when the conversation has no known owner', async () => {
    const { principalSubjectForConversation } = await import('../protocol/tabs-index')
    const { peekEngineHostInfo } = await import('../engine/engine-bridge-fs')
    vi.mocked(principalSubjectForConversation).mockReturnValue(undefined)
    vi.mocked(peekEngineHostInfo).mockReturnValue({ principalPartitioning: { enabled: true, enforcement: 'strict', root: '/x' } } as never)

    const flatDir = join('/tmp/ion-session-meta-partition-test', 'conversations')
    mkdirSync(flatDir, { recursive: true })
    writeFileSync(join(flatDir, 'conv-flat.llm.jsonl'), '{"meta":true}\n')
    writeFileSync(join(flatDir, 'conv-flat.tree.jsonl'), '{"meta":true}\n')

    const { conversationExists } = await import('../session-meta')
    expect(conversationExists('conv-flat')).toBe(true)
  })
})
