/**
 * The paged and multi-conversation forms of the session read actions.
 *
 * The security-relevant half is the extractors: `actions.ts` ownership-checks
 * exactly the ids `tabIdAt` / `conversationIdsAt` return, so a new argument
 * form whose ids the extractor misses is a form that reads another
 * principal's conversation unchecked.
 */
import { describe, expect, it, vi } from 'vitest'

const transcript = 'Round one — naïve café ☕.\n'.repeat(200)

vi.mock('../../store/session-reads', () => ({
  loadConversationTranscriptForTab: vi.fn(async () => transcript),
  getConversationPage: vi.fn(async (p: unknown) => ({ page: p })),
  readPlan: vi.fn(async (path: string) => ({ content: `whole:${path}`, fileName: 'plan.md' })),
}))
vi.mock('../../plan-content-window', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../plan-content-window')>()),
  readPlanWindow: vi.fn((req: unknown) => ({ window: req })),
}))
vi.mock('../../state', () => ({ engineBridge: {}, sessionPlane: { getHealth: vi.fn() }, state: {} }))
vi.mock('../../engine/engine-bridge-fs', () => ({ getEnterprisePolicy: vi.fn(), getEnterprisePolicyNewConversationDefaults: vi.fn(), resolveNewConversationDefaults: vi.fn() }))
vi.mock('../engine-actions', () => ({ ENGINE_ACTIONS: {} }))

const { SESSION_ACTIONS } = await import('../session-actions')
import type { Connection } from '../connection'

const conn = { id: 'c1' } as Connection
async function run(action: string, args: unknown[]): Promise<unknown> {
  const result = await SESSION_ACTIONS[action].handler(conn, args)
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

describe('session.getConversation', () => {
  it('ownership-checks the conversation it reads', () => {
    const spec = SESSION_ACTIONS['session.getConversation']
    expect(spec.conversationIdsAt?.([{ conversationId: 'conv-a' }])).toEqual(['conv-a'])
  })

  it('reads a raw page', async () => {
    expect(await run('session.getConversation', [{ conversationId: 'conv-a', limit: 5 }])).toEqual({ page: { conversationId: 'conv-a', offset: 0, limit: 5 } })
  })

  it('reads fifty rows by default and every row when limit is 0', async () => {
    expect(await run('session.getConversation', [{ conversationId: 'conv-a' }])).toEqual({ page: { conversationId: 'conv-a', offset: 0, limit: 50 } })
    expect(await run('session.getConversation', [{ conversationId: 'conv-a', limit: 0 }])).toEqual({ page: { conversationId: 'conv-a', offset: 0, limit: 0 } })
  })
})

describe('session.loadTranscript', () => {
  it('ownership-checks the tab of both forms', () => {
    const spec = SESSION_ACTIONS['session.loadTranscript']
    expect(spec.tabIdAt?.(['tab-1'])).toBe('tab-1')
    expect(spec.tabIdAt?.([{ tabId: 'tab-1', offset: 10 }])).toBe('tab-1')
  })

  it('a tab id still reads the whole transcript', async () => {
    expect(await run('session.loadTranscript', ['tab-1'])).toBe(transcript)
  })

  it('windows reassemble to the whole transcript without splitting a character', async () => {
    let text = ''
    let offset = 0
    for (let guard = 0; guard < 10_000; guard++) {
      const win = (await run('session.loadTranscript', [{ tabId: 'tab-1', offset, length: 13 }])) as { content: string; hasMore: boolean; totalBytes: number }
      expect(win.totalBytes).toBe(Buffer.byteLength(transcript, 'utf-8'))
      text += win.content
      if (!win.hasMore) break
      offset += Buffer.byteLength(win.content, 'utf-8')
    }
    expect(text).toBe(transcript)
  })
})

describe('session.readPlan', () => {
  it('a path still reads the whole plan; an object asks for a window', async () => {
    expect(await run('session.readPlan', ['/p/plan.md'])).toEqual({ content: 'whole:/p/plan.md', fileName: 'plan.md' })
    expect(await run('session.readPlan', [{ planFilePath: '/p/plan.md', questionId: 'q1', offset: 64, length: 32 }]))
      .toEqual({ window: { planFilePath: '/p/plan.md', questionId: 'q1', offset: 64, length: 32 } })
  })
})
