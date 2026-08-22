/**
 * session-store-helpers must be importable without a DOM.
 *
 * The module owns `makeLocalTab` / `nextMsgId`, which every store slice imports,
 * and it used to construct `new Audio(...)` at module load. That single
 * side-effect made the module unloadable in the Node test environment, so suites
 * that only wanted a tab factory replaced the whole module with a hand-written
 * mock — and those mocks then drifted from the real export list. Two suites
 * failed outright with `ReferenceError: Audio is not defined`.
 *
 * These tests pin the property that removed the need for those mocks: importing
 * the module never touches the audio constructor, and the notification path
 * degrades observably when the constructor is absent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => ({ soundEnabled: true }) },
}))

const rTrace = vi.fn()
vi.mock('../../rendererLogger', () => ({
  rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(),
  rTrace: (...args: unknown[]) => rTrace(...args),
}))

vi.mock('../model-store', () => ({
  useModelStore: { getState: () => ({ findModel: () => null }) },
}))

import { makeLocalTab, nextMsgId, playNotificationIfHidden } from '../session-store-helpers'

describe('session-store-helpers without a DOM audio constructor', () => {
  beforeEach(() => {
    rTrace.mockClear()
  })

  afterEach(() => {
    delete (globalThis as { Audio?: unknown }).Audio
    delete (globalThis as { window?: unknown }).window
  })

  it('imports and produces a tab with no Audio global present', () => {
    expect(typeof (globalThis as { Audio?: unknown }).Audio).not.toBe('function')
    expect(makeLocalTab().title).toBe('New Tab')
    expect(nextMsgId()).toMatch(/^msg-\d+$/)
  })

  it('skips the notification and logs instead of throwing when Audio is absent', async () => {
    await expect(playNotificationIfHidden()).resolves.toBeUndefined()
    expect(rTrace).toHaveBeenCalledWith(
      'notify',
      'notification skipped because the audio constructor is unavailable',
    )
  })

  it('builds the element on first play once a constructor exists', async () => {
    const play = vi.fn().mockResolvedValue(undefined)
    let constructed = 0
    ;(globalThis as { Audio?: unknown }).Audio = class {
      volume = 0
      currentTime = 0
      play = play
      constructor() { constructed++ }
    }
    ;(globalThis as { window?: unknown }).window = { ion: { isVisible: async () => false } }

    await playNotificationIfHidden()
    await playNotificationIfHidden()

    expect(constructed).toBe(1)
    expect(play).toHaveBeenCalledTimes(2)
  })
})
