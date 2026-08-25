/**
 * Behavior tests for the user-turn echo funnel (`main/user-turn-echo.ts`).
 *
 * The structural sibling (`user-turn-echo-funnel.test.ts`) proves every call
 * site routes through the funnel. These prove the funnel makes the right
 * decision once it is reached — the two halves together are what close the
 * "hidden message class reappeared on one surface" defect class.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const studioEcho = vi.fn()
vi.mock('../studio-window-manager', () => ({
  notifyStudioUserMessageEcho: (tabId: string, echo: unknown) => studioEcho(tabId, echo),
}))

const sent: Array<Record<string, unknown>> = []
vi.mock('../state', () => ({
  state: {
    get remoteTransport() {
      return { send: (payload: Record<string, unknown>) => sent.push(payload) }
    },
  },
}))

vi.mock('../logger', () => ({
  log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
}))

import { echoUserTurn } from '../user-turn-echo'

/** The iOS payload of the single send, if any. */
function iosMessage(): Record<string, unknown> | undefined {
  const frame = sent.find((p) => p.type === 'desktop_message_added')
  return frame?.message as Record<string, unknown> | undefined
}

beforeEach(() => {
  studioEcho.mockClear()
  sent.length = 0
})

describe('echoUserTurn — an ordinary typed turn', () => {
  it('publishes to BOTH the Studio mirror and iOS', () => {
    const published = echoUserTurn({ tabId: 'tab-1', id: 'req-1', content: 'a turn I typed' })

    expect(published).toBe(true)
    expect(studioEcho).toHaveBeenCalledTimes(1)
    expect(iosMessage()).toMatchObject({ id: 'req-1', role: 'user', content: 'a turn I typed' })
  })

  it("still echoes to iOS when source is 'remote' (that frame is the canonical row)", () => {
    // `source` is a provenance LABEL, not a routing instruction. The canonical
    // echo for an iOS-originated prompt is stamped 'remote' and carries the
    // server-assigned id the phone reconciles its optimistic bubble against —
    // inferring a skip from the label silently dropped it.
    echoUserTurn({ tabId: 'tab-1', id: 'req-1', content: 'from the phone', source: 'remote' })

    expect(studioEcho).toHaveBeenCalledTimes(1)
    expect(iosMessage()).toMatchObject({ id: 'req-1', source: 'remote' })
  })

  it('skips iOS only when the caller says so (a duplicate-frame guard)', () => {
    echoUserTurn({ tabId: 'tab-1', id: 'req-1', content: 'x', source: 'remote' }, { ios: false })

    expect(studioEcho).toHaveBeenCalledTimes(1)
    expect(iosMessage()).toBeUndefined()
  })
})

describe('echoUserTurn — a machine-authored turn', () => {
  it('publishes to NO surface', () => {
    // The whole point: one classification, every surface. Before the funnel,
    // the owner store suppressed this and the Studio mirror did not.
    //
    // Uses agent_completion — a turn no human ever saw. structured_answer was
    // the example here until it was reclassified as user-authored: a Guided
    // Questions submission is real operator input and now RENDERS with a
    // label, so it is no longer an example of suppression.
    const published = echoUserTurn({
      tabId: 'tab-1',
      id: 'req-1',
      content: '[dev-lead] done in 4m',
      injectionKind: 'agent_completion',
    })

    expect(published).toBe(false)
    expect(studioEcho).not.toHaveBeenCalled()
    expect(sent).toEqual([])
  })

  it('RENDERS a structured answer — real operator input, labelled not hidden', () => {
    expect(
      echoUserTurn({ tabId: 'tab-1', id: 'r', content: 'My answers...', injectionKind: 'structured_answer' }),
    ).toBe(true)
    expect(studioEcho).toHaveBeenCalledTimes(1)
  })

  it('suppresses a kind the engine flags machine-authored, with no edit here', () => {
    // The property that ends the recurrence: agent callbacks were already
    // suppressed by the shared policy's legacy set, and a NEW kind added to
    // the engine reaches this funnel through the same read.
    expect(
      echoUserTurn({ tabId: 'tab-1', id: 'r', content: '[Agent done]', injectionKind: 'agent_completion' }),
    ).toBe(false)
    expect(studioEcho).not.toHaveBeenCalled()
  })

  it('still publishes an unknown kind (a client cannot hide a turn by inventing one)', () => {
    expect(
      echoUserTurn({ tabId: 'tab-1', id: 'r', content: 'visible', injectionKind: 'invented_kind' }),
    ).toBe(true)
    expect(studioEcho).toHaveBeenCalledTimes(1)
  })
})

describe('echoUserTurn — target selection', () => {
  it('honours studio:false (the caller owns that surface)', () => {
    echoUserTurn({ tabId: 'tab-1', id: 'r', content: 'x' }, { studio: false })

    expect(studioEcho).not.toHaveBeenCalled()
    expect(iosMessage()).toBeDefined()
  })

  it('honours ios:false', () => {
    echoUserTurn({ tabId: 'tab-1', id: 'r', content: 'x' }, { ios: false })

    expect(studioEcho).toHaveBeenCalledTimes(1)
    expect(iosMessage()).toBeUndefined()
  })

  it('suppression outranks explicit targets', () => {
    // A caller asking for both surfaces still gets neither for a
    // machine-authored turn — the classification is not overridable per site,
    // which is what makes the funnel a rule rather than a default.
    const published = echoUserTurn(
      { tabId: 'tab-1', id: 'r', content: '[dev-lead] done', injectionKind: 'agent_completion' },
      { studio: true, ios: true },
    )

    expect(published).toBe(false)
    expect(studioEcho).not.toHaveBeenCalled()
    expect(sent).toEqual([])
  })
})

describe('echoUserTurn — payload fidelity', () => {
  it('forwards attachments and slash provenance to iOS', () => {
    echoUserTurn({
      tabId: 'tab-1',
      id: 'req-1',
      content: '/spec args',
      attachments: [{ id: '/tmp/a.png', type: 'image', name: 'a.png', path: '/tmp/a.png' }],
      slashCommand: '/spec',
      slashArgs: 'args',
    })

    expect(iosMessage()).toMatchObject({
      slashCommand: '/spec',
      slashArgs: 'args',
      attachments: [{ name: 'a.png', path: '/tmp/a.png' }],
    })
  })

  it('uses the caller timestamp when supplied so both surfaces agree', () => {
    echoUserTurn({ tabId: 'tab-1', id: 'req-1', content: 'x', timestamp: 1234 })

    expect(iosMessage()).toMatchObject({ timestamp: 1234 })
    expect(studioEcho).toHaveBeenCalledWith('tab-1', expect.objectContaining({ timestamp: 1234 }))
  })
})
