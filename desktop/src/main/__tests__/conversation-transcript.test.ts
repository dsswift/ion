import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  load: vi.fn(),
  active: new Map<string, { id: string; content: string }>(),
  log: vi.fn(),
}))

vi.mock('../remote/handlers/tabs-session-chain', () => ({ resolveTabSessionChain: mocks.resolve }))
vi.mock('../state', () => ({ engineBridge: { loadChainHistory: mocks.load }, activeAssistantMessages: mocks.active }))
vi.mock('../logger', () => ({ log: mocks.log }))

import { loadConversationTranscript } from '../conversation-transcript'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.active.clear()
  mocks.resolve.mockResolvedValue({ sessionIds: ['old', 'current'], conversationId: 'current', tabStatus: 'idle', source: 'renderer_cache' })
  mocks.load.mockResolvedValue([
    { id: 'u1', role: 'user', content: 'First', timestamp: 1 },
    { id: 'a1', role: 'assistant', content: 'Second', timestamp: 2 },
  ])
})

describe('loadConversationTranscript', () => {
  it('loads the complete session chain and formats it', async () => {
    await expect(loadConversationTranscript('tab-1')).resolves.toBe('[user]: First\n\n[assistant]: Second')
    expect(mocks.load).toHaveBeenCalledWith(['old', 'current'])
  })

  it('appends the active assistant tail while streaming', async () => {
    mocks.resolve.mockResolvedValue({ sessionIds: ['current'], conversationId: 'current', tabStatus: 'running', source: 'renderer_cache' })
    mocks.active.set('tab-1', { id: 'live', content: 'Still streaming' })
    const result = await loadConversationTranscript('tab-1')
    expect(result).toContain('[assistant]: Still streaming')
  })

  it('returns an empty transcript when history has no human rows', async () => {
    mocks.load.mockResolvedValue([{ id: 't1', role: 'tool', content: 'tool result', timestamp: 1 }])
    await expect(loadConversationTranscript('tab-1')).resolves.toEqual('')
  })

  it('rejects when the target has no session chain', async () => {
    mocks.resolve.mockResolvedValue(null)
    await expect(loadConversationTranscript('missing')).rejects.toThrow('conversation session chain not found')
  })

  it('logs and propagates an engine failure', async () => {
    mocks.load.mockRejectedValue(new Error('engine unavailable'))
    await expect(loadConversationTranscript('tab-1')).rejects.toThrow('engine unavailable')
    expect(mocks.log).toHaveBeenCalledWith('main', 'conversation_transcript: failed', expect.objectContaining({ tab_id: 'tab-1' }))
  })
})
