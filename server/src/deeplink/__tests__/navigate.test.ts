/**
 * Navigation links run nothing, so their only job is to name something real.
 * Each refusal here is a link the server must not move a client toward.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({
  tabs: [] as Array<{ id: string; conversationId: string | null }>,
  resume: vi.fn(),
  conversationsDir: '',
}))

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))
vi.mock('../../store/sessionStore', () => ({
  useSessionStore: { getState: () => ({ tabs: mocks.tabs, resumeSession: (...a: any[]) => mocks.resume(...a) }) },
}))
vi.mock('../../conversation/principal-paths', () => ({ resolveConversationsDirSync: () => mocks.conversationsDir }))
vi.mock('../../protocol/tabs-index', () => ({ principalSubjectForConversation: () => undefined }))
vi.mock('../../projectable-settings', () => ({ projectablePages: () => [{ id: 'defaults' }] }))

import { resolveNavigation } from '../navigate'

let root: string
beforeEach(() => {
  vi.clearAllMocks()
  root = mkdtempSync(join(tmpdir(), 'ion-nav-'))
  mocks.conversationsDir = join(root, 'conversations')
  mkdirSync(mocks.conversationsDir)
  mocks.tabs = []
})

describe('conversation', () => {
  it('targets the tab already showing the conversation', async () => {
    mocks.tabs = [{ id: 'tab-1', conversationId: 'c1' }]
    expect(await resolveNavigation({ action: 'conversation', id: 'c1' })).toEqual({ ok: true, target: { route: 'conversation', conversationId: 'c1', tabId: 'tab-1' } })
    expect(mocks.resume).not.toHaveBeenCalled()
  })

  it('resumes a saved conversation that is not open', async () => {
    writeFileSync(join(mocks.conversationsDir, 'c2.tree.jsonl'), '')
    mocks.resume.mockResolvedValue('tab-new')
    expect(await resolveNavigation({ action: 'conversation', id: 'c2' })).toMatchObject({ ok: true, target: { tabId: 'tab-new' } })
  })

  it('refuses a conversation that does not exist', async () => {
    expect(await resolveNavigation({ action: 'conversation', id: 'nope' })).toMatchObject({ ok: false })
    expect(mocks.resume).not.toHaveBeenCalled()
  })
})

describe('settings', () => {
  it('resolves a section id to its page and says whether a phone can show it', async () => {
    expect(await resolveNavigation({ action: 'settings', panel: 'defaults-thinking' })).toEqual({
      ok: true, target: { route: 'settings', panel: 'defaults-thinking', pageId: 'defaults', projectable: true },
    })
    expect(await resolveNavigation({ action: 'settings', panel: 'keyboard' })).toMatchObject({ ok: true, target: { projectable: false } })
  })

  it('refuses an unknown panel', async () => {
    expect(await resolveNavigation({ action: 'settings', panel: 'no-such-page' })).toMatchObject({ ok: false })
  })
})

describe('file', () => {
  it('resolves a file inside its dir to an absolute path', async () => {
    writeFileSync(join(root, 'a.ts'), '')
    expect(await resolveNavigation({ action: 'file', dir: root, path: 'a.ts' })).toEqual({ ok: true, target: { route: 'file', dir: root, path: join(root, 'a.ts') } })
  })

  it('refuses a path that leaves its dir', async () => {
    expect(await resolveNavigation({ action: 'file', dir: join(root, 'conversations'), path: '../a.ts' })).toMatchObject({ ok: false })
    expect(await resolveNavigation({ action: 'file', dir: join(root, 'conversations'), path: '/etc/hosts' })).toMatchObject({ ok: false })
  })

  it('refuses a relative dir and a missing file', async () => {
    expect(await resolveNavigation({ action: 'file', dir: 'relative', path: 'a.ts' })).toMatchObject({ ok: false })
    expect(await resolveNavigation({ action: 'file', dir: root, path: 'missing.ts' })).toMatchObject({ ok: false })
  })
})
