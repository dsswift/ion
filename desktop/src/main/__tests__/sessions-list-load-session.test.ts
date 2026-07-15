/**
 * LOAD_SESSION history-loader selection. Pins the per-conversation store
 * decision that replaced the global backend mode: an Ion conversation file
 * (written only by the API backend) is loaded Ion-first; a conversation with
 * no Ion file falls back to the Claude CLI store. No global flag consulted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { handlers, sessionMeta, plane } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  sessionMeta: {
    conversationExists: vi.fn(() => false),
    loadClaudeSessionMessages: vi.fn((): unknown[] => []),
    loadEngineConversationMessages: vi.fn((): unknown[] => []),
  },
  plane: {
    loadSessionHistory: vi.fn(async (): Promise<unknown[]> => []),
  },
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)),
    on: vi.fn(),
  },
}))
vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../state', () => ({ sessionPlane: plane, engineBridge: {} }))
vi.mock('../session-meta', () => ({
  cleanCliTags: vi.fn((s: string) => s),
  collapseSessionChains: vi.fn((s: unknown[]) => s),
  conversationExists: sessionMeta.conversationExists,
  decodeProjectPath: vi.fn(),
  extractBashEntries: vi.fn(),
  extractTag: vi.fn(),
  loadClaudeSessionMessages: sessionMeta.loadClaudeSessionMessages,
  loadEngineConversationMessages: sessionMeta.loadEngineConversationMessages,
  parseSessionMeta: vi.fn(),
}))
vi.mock('../settings-store', () => ({
  loadSessionLabels: vi.fn(() => ({})),
  readClaudeCompat: vi.fn(() => true),
}))
vi.mock('../ipc-validation', () => ({
  isValidProjectPath: vi.fn(() => true),
  isValidSessionId: vi.fn(() => true),
  resolveDiscoveryWorkingDir: vi.fn(),
}))

import { registerSessionsListIpc } from '../ipc/sessions-list'
import { IPC } from '../../shared/types'

registerSessionsListIpc()

async function loadSession(sessionId: string): Promise<unknown> {
  const handler = handlers.get(IPC.LOAD_SESSION)
  if (!handler) throw new Error('no LOAD_SESSION handler')
  return handler({}, { sessionId, projectPath: '/proj', encodedDir: '-proj' })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('LOAD_SESSION store selection', () => {
  it('loads engine history when an Ion conversation file exists (never the CLI store)', async () => {
    sessionMeta.conversationExists.mockReturnValue(true)
    plane.loadSessionHistory.mockResolvedValue([{ role: 'user', content: 'hi' }])

    const msgs = (await loadSession('conv-ion')) as unknown[]
    expect(msgs).toHaveLength(1)
    expect(sessionMeta.loadClaudeSessionMessages).not.toHaveBeenCalled()
  })

  it('falls back to the direct engine file reader when the plane returns empty for an Ion conversation', async () => {
    sessionMeta.conversationExists.mockReturnValue(true)
    plane.loadSessionHistory.mockResolvedValue([])
    sessionMeta.loadEngineConversationMessages.mockReturnValue([{ role: 'user', content: 'direct' }])

    const msgs = (await loadSession('conv-ion')) as unknown[]
    expect(msgs).toHaveLength(1)
    expect(sessionMeta.loadClaudeSessionMessages).not.toHaveBeenCalled()
  })

  it('falls back to the Claude CLI store when no Ion file exists', async () => {
    sessionMeta.conversationExists.mockReturnValue(false)
    sessionMeta.loadClaudeSessionMessages.mockReturnValue([{ role: 'user', content: 'cli' }])

    const msgs = (await loadSession('conv-cli')) as unknown[]
    expect(msgs).toHaveLength(1)
    expect(sessionMeta.loadClaudeSessionMessages).toHaveBeenCalledWith('conv-cli', '/proj', '-proj')
    expect(plane.loadSessionHistory).not.toHaveBeenCalled()
  })

  it('asks the engine as a last resort when neither store has a file', async () => {
    sessionMeta.conversationExists.mockReturnValue(false)
    sessionMeta.loadClaudeSessionMessages.mockReturnValue([])
    plane.loadSessionHistory.mockResolvedValue([{ role: 'user', content: 'live' }])

    const msgs = (await loadSession('conv-live')) as unknown[]
    expect(msgs).toHaveLength(1)
  })
})
