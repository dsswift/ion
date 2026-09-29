/**
 * A restored conversation whose directory is gone says so.
 *
 * The Inbox files a conversation under its checkout path, so a path that
 * exists on no machine here becomes its own project named for someone
 * else's filesystem — and the conversation reads as though the transfer
 * that brought it vanished. Nothing in the log said a word.
 *
 * The check lives in `restoreOneTab`, above the branch, because that is the
 * one place EVERY restored tab passes: a normal conversation, an
 * extension-hosted one, a terminal-only one, and a sessionless one each
 * take a different arm below it. Put in one arm, it reports nothing for the
 * conversations most likely to have moved between machines — which is
 * exactly what happened the first time it was written.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const warn = vi.fn()
vi.mock('../../logger', () => ({
  debug: vi.fn(),
  warn: (...args: unknown[]) => warn(...args),
  log: vi.fn(),
  error: vi.fn(),
}))

const restoreNormalTab = vi.fn(async () => undefined)
const restoreConversationTab = vi.fn(async (..._a: unknown[]) => undefined)
const restoreTerminalOnlyTab = vi.fn(async () => undefined)
const restoreSessionlessTab = vi.fn(async () => undefined)

vi.mock('../useTabRestoration-engine', () => ({ restoreConversationTab: (...a: unknown[]) => restoreConversationTab(...a) }))
vi.mock('../../store/worktree-registration', () => ({ resolveRegisteredWorktree: async () => null }))
vi.mock('../../store/sessionStore', () => ({ useSessionStore: { getState: () => ({}), setState: vi.fn() } }))
vi.mock('../../store/host-api-engine', () => ({ adoptTab: vi.fn() }))

import * as bootRestore from '../boot-restore-tab'

/** The arms below the check are exercised by their own suites; here they only need to not run. */
function stubArms(): void {
  const mod = bootRestore as unknown as Record<string, unknown>
  for (const [name, stub] of Object.entries({ restoreNormalTab, restoreTerminalOnlyTab, restoreSessionlessTab })) {
    if (typeof mod[name] === 'function') mod[name] = stub
  }
}

function tab(over: Record<string, unknown> = {}) {
  return { id: 'a954adbe-cb43-45dd-b5cc-ba7fe024d020', conversationId: 'conv-1', workingDirectory: '/Users/someone-else/source/personal/ion', ...over }
}

beforeEach(() => {
  warn.mockClear()
  stubArms()
})

describe('restoreOneTab: a directory that is not on this machine', () => {
  it('warns with the path for an ordinary conversation, the arm a transferred one takes', async () => {
    const saved = [tab()] as never[]
    await bootRestore.restoreOneTab(saved, 0, null, null, [], new Map()).catch(() => undefined)

    expect(warn).toHaveBeenCalledWith(
      'boot-restore',
      'restored with a working directory that does not exist',
      expect.objectContaining({ working_directory: '/Users/someone-else/source/personal/ion', tab_id: 'a954adbe' }),
    )
  })

  it('says nothing for a directory that is there', async () => {
    const saved = [tab({ workingDirectory: process.cwd() })] as never[]
    await bootRestore.restoreOneTab(saved, 0, null, null, [], new Map()).catch(() => undefined)

    expect(warn).not.toHaveBeenCalledWith('boot-restore', 'restored with a working directory that does not exist', expect.anything())
  })
})
