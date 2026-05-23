/**
 * Tests for the `/clear` checkpoint dispatch in InputBarCommandHandlers.
 *
 * These tests guard the central renderer behaviour change: `/clear` must
 *
 *   - call `window.ion.engineCommand(tab.id, 'clear', '')` so the engine
 *     wipes conv.Messages on disk and re-fires session_start;
 *   - NOT call `clearTab` (scrollback is intentionally preserved as a
 *     checkpoint marker — wiping the on-screen messages is the bug we're
 *     fixing);
 *   - call `addSystemMessage` with a divider-formatted string starting
 *     with the `── Cleared` sentinel that SystemMessage.tsx recognises.
 *
 * Also covers `formatClearDivider` for stability — it's the contract
 * surface that both the renderer and the main process (via slash-intercept)
 * rely on staying in sync.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { executeBuiltinCommand, formatClearDivider, type ExecuteCommandDeps } from '../InputBarCommandHandlers'
import type { TabState } from '../../../shared/types'

function makeFakeTab(id = 'tab-under-test'): TabState {
  // Minimal stub — the dispatcher only reads `tab.id`. Cast through unknown
  // to avoid having to construct every required field. If the dispatcher
  // ever starts reading more fields, this cast will fail and the test will
  // tell us to update.
  return { id } as unknown as TabState
}

function makeDeps(overrides?: Partial<ExecuteCommandDeps>): ExecuteCommandDeps {
  return {
    tab: makeFakeTab(),
    clearTab: vi.fn(),
    addSystemMessage: vi.fn(),
    ...overrides,
  }
}

describe('executeBuiltinCommand', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      ion: {
        engineCommand: vi.fn(),
      },
    })
  })

  describe('/clear', () => {
    it('dispatches engineCommand with the active tab id, command="clear", empty args', () => {
      const deps = makeDeps({ tab: makeFakeTab('tab-abc') })
      executeBuiltinCommand('/clear', deps)
      const engineCommand = (window as any).ion.engineCommand as ReturnType<typeof vi.fn>
      expect(engineCommand).toHaveBeenCalledTimes(1)
      expect(engineCommand).toHaveBeenCalledWith('tab-abc', 'clear', '')
    })

    it('does NOT call clearTab (scrollback must be preserved across checkpoint)', () => {
      const deps = makeDeps()
      executeBuiltinCommand('/clear', deps)
      expect(deps.clearTab).not.toHaveBeenCalled()
    })

    it('inserts a divider system message using the `── Cleared` sentinel', () => {
      const deps = makeDeps()
      executeBuiltinCommand('/clear', deps)
      const addSystemMessage = deps.addSystemMessage as ReturnType<typeof vi.fn>
      expect(addSystemMessage).toHaveBeenCalledTimes(1)
      const arg = addSystemMessage.mock.calls[0][0]
      expect(arg).toMatch(/^── Cleared at .+ ──$/)
    })

    it('still inserts the divider when tab is undefined (defensive)', () => {
      // tab can be undefined if the dispatcher is invoked with no active tab.
      // We should not crash; we also should not attempt the engineCommand
      // (no tab id to address), but the divider should still appear so the
      // user gets feedback.
      const deps = makeDeps({ tab: undefined })
      executeBuiltinCommand('/clear', deps)
      const engineCommand = (window as any).ion.engineCommand as ReturnType<typeof vi.fn>
      expect(engineCommand).not.toHaveBeenCalled()
      expect(deps.addSystemMessage).toHaveBeenCalledTimes(1)
    })
  })

  describe('unknown commands', () => {
    it('is a no-op and does not touch deps', () => {
      const deps = makeDeps()
      executeBuiltinCommand('/nonexistent', deps)
      expect(deps.clearTab).not.toHaveBeenCalled()
      expect(deps.addSystemMessage).not.toHaveBeenCalled()
      const engineCommand = (window as any).ion.engineCommand as ReturnType<typeof vi.fn>
      expect(engineCommand).not.toHaveBeenCalled()
    })
  })
})

describe('formatClearDivider', () => {
  it('produces the `── Cleared at <time> ──` sentinel shape', () => {
    const out = formatClearDivider(new Date('2024-01-01T12:34:56'))
    // Don't pin the exact time format — locale-dependent on toLocaleTimeString —
    // just guard the structural sentinel that SystemMessage.tsx switches on.
    expect(out.startsWith('── Cleared at ')).toBe(true)
    expect(out.endsWith(' ──')).toBe(true)
  })
})
