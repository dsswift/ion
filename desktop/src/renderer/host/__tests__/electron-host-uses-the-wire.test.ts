// @vitest-environment jsdom
/**
 * The desktop renderer reaches shared work over the Studio wire, not through
 * Electron IPC.
 *
 * This is the property the whole host-surface audit exists to protect. When
 * `ElectronStudioHost.shell` was the preload bridge, the desktop and a browser
 * client reached the same `@ion/server` code by two different routes — and
 * only the browser ever took the wire. Every gap in that path therefore stayed
 * invisible in ordinary use: an unbridged verb, a mis-packed argument, a
 * missing server action. They surfaced only when a browser client finally hit
 * them, which is a bad place to find out.
 *
 * One transport for shared work means the desktop exercises the browser's path
 * on every run. The preload remains for verbs that genuinely need this
 * machine, and the second test pins that half — a client with an operating
 * system should use it rather than refuse.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { ElectronStudioHost } from '../ElectronStudioHost'

interface Sent {
  environmentId: string
  frame: StudioFrame
}

/** A preload stub that records frames and answers any action with `value`. */
function preloadStub(value: unknown): { sent: Sent[]; ion: Record<string, unknown>; listModels: ReturnType<typeof vi.fn> } {
  const sent: Sent[] = []
  const listeners = new Set<(environmentId: string, frame: StudioFrame) => void>()
  const listModels = vi.fn(async () => ['should-not-be-called'])
  const ion: Record<string, unknown> = {
    listModels,
    fsRevealInFinder: vi.fn(),
    hostSendFrame(environmentId: string, frame: StudioFrame) {
      sent.push({ environmentId, frame })
      if (frame.type !== 'studio_action') return
      for (const l of [...listeners]) {
        l(LOCAL_ENVIRONMENT_ID, { type: 'studio_action_result', id: frame.id, ok: true, value } as StudioFrame)
      }
    },
    onHostFrame(cb: (environmentId: string, frame: StudioFrame) => void) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
  return { sent, ion, listModels }
}

afterEach(() => {
  delete (window as unknown as { ion?: unknown }).ion
})

describe('ElectronStudioHost.shell', () => {
  it('sends a bridged verb as a studio_action instead of calling the preload', async () => {
    const { sent, ion, listModels } = preloadStub(['claude-opus-5'])
    ;(window as unknown as { ion: unknown }).ion = ion

    const result = await new ElectronStudioHost().shell.listModels()

    expect(result).toEqual(['claude-opus-5'])
    // The preload's own `listModels` must not run: the server answered.
    expect(listModels).not.toHaveBeenCalled()
    expect(sent).toHaveLength(1)
    expect(sent[0]?.environmentId).toBe(LOCAL_ENVIRONMENT_ID)
    expect(sent[0]?.frame).toMatchObject({ type: 'studio_action', action: 'model.list' })
  })

  it('falls through to the preload for a verb the wire does not carry', () => {
    const { ion } = preloadStub(null)
    ;(window as unknown as { ion: unknown }).ion = ion

    const host = new ElectronStudioHost()
    host.shell.fsRevealInFinder('/tmp/x')

    // Revealing a path needs a Finder, which has no server-side form. A
    // desktop client has one, so this is the half that must NOT go over the
    // wire — and must not be refused either.
    expect(ion.fsRevealInFinder).toHaveBeenCalledWith('/tmp/x')
  })

  it('writes an assignment through to the preload, where reads still see it', () => {
    const { ion } = preloadStub(null)
    ;(window as unknown as { ion: unknown }).ion = ion

    const host = new ElectronStudioHost()
    const replacement = vi.fn()
    ;(host.shell as unknown as Record<string, unknown>).fsRevealInFinder = replacement

    // `host.shell` used to BE the preload, so an override written onto it
    // landed there and died with it. A proxy that kept the value itself would
    // outlive the object the test replaced, leaking into the next case.
    expect((ion as Record<string, unknown>).fsRevealInFinder).toBe(replacement)
  })
})
