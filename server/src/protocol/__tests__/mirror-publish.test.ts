/**
 * The owner-published mirror snapshots and the automation renderer command
 * must actually reach the wire.
 *
 * Both were stubs carrying the comment "no-op until the Studio wire (child
 * 07) lands" / "no client is attached to the server yet". The wire landed;
 * the stubs did not. Reverting either to its no-op turns these red.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { IPC } from '@ion/shared/types'

const sent = vi.hoisted(() => ({ calls: [] as Array<[string, unknown[]]> }))
vi.mock('../../broadcast', () => ({
  broadcast: (channel: string, ...args: unknown[]) => { sent.calls.push([channel, args]) },
}))

import {
  studioPublishTabsSync,
  studioPublishWorktreeSync,
  studioPublishConversationTerminals,
} from '../../store/host-api-misc'
import {
  runAutomationRendererCommand,
  resolveAutomationRendererCommand,
  resetAutomationRendererCommandsForTests,
} from '../../automation/renderer-command'
import type { AutomationAction } from '@ion/shared/types-automation'

beforeEach(() => { sent.calls = [] })

describe('owner-published mirror snapshots', () => {
  it('broadcasts each snapshot on its own channel instead of dropping it', () => {
    studioPublishTabsSync({ tabs: [] })
    studioPublishWorktreeSync({ worktrees: [] })
    studioPublishConversationTerminals({ panes: [], openTabIds: ['tab-1'] })

    expect(sent.calls.map(([channel]) => channel)).toEqual([
      IPC.STUDIO_TABS_SYNC,
      IPC.STUDIO_WORKTREE_SYNC,
      IPC.STUDIO_CONVERSATION_TERMINALS,
    ])
    // The payload travels intact -- `openTabIds` is what tells a client its
    // conversation terminal panel is open.
    expect(sent.calls[2][1][0]).toMatchObject({ panes: [], openTabIds: ['tab-1'] })
  })
})

describe('automation renderer command', () => {
  const action = { kind: 'open-conversation' } as unknown as AutomationAction

  it('dispatches on the wire and resolves when a client reports success', async () => {
    const pending = runAutomationRendererCommand(action)
    const [channel, args] = sent.calls[0]
    expect(channel).toBe(IPC.AUTOMATION_COMMAND)
    const { id } = args[0] as { id: string; action: AutomationAction }
    expect(id).toBeTruthy()
    expect((args[0] as { action: AutomationAction }).action).toBe(action)

    resolveAutomationRendererCommand(id, { ok: true })
    await expect(pending).resolves.toBeUndefined()
  })

  it('rejects with the client-reported reason on failure', async () => {
    const pending = runAutomationRendererCommand(action)
    const { id } = (sent.calls[0][1][0]) as { id: string }
    resolveAutomationRendererCommand(id, { ok: false, error: 'operator declined' })
    await expect(pending).rejects.toThrow('operator declined')
  })

  it('does not settle on its own before a client answers', async () => {
    const pending = runAutomationRendererCommand(action)
    let settled = false
    void pending.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    resetAutomationRendererCommandsForTests()
    await expect(pending).rejects.toThrow()
  })
})
