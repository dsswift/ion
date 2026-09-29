/**
 * Behavior tests for the user-turn echo funnel (`server/src/user-turn-echo.ts`).
 *
 * The structural sibling (`user-turn-echo-funnel.test.ts`) proves every call
 * site routes through the funnel. These prove the funnel makes the right
 * decision once it is reached — the two halves together are what close the
 * "hidden message class reappeared on one surface" defect class.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const studioEcho = vi.fn()
vi.mock('../engine/studio-window-manager', () => ({
  notifyStudioUserMessageEcho: (tabId: string, echo: unknown) => studioEcho(tabId, echo),
}))

const sent: Array<Record<string, unknown>> = []
vi.mock('../thin-view/remote-out', () => ({
  remoteClientsPresent: () => true,
  sendRemoteEvent: (payload: Record<string, unknown>) => sent.push(payload),
}))

vi.mock('../logger', () => ({
  log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
}))

import { echoUserTurn } from '../user-turn-echo'

/** The payload the Studio mirror received on the single echo. */
function studioPayload(): Record<string, unknown> {
  return studioEcho.mock.calls[0][1] as Record<string, unknown>
}

beforeEach(() => {
  studioEcho.mockClear()
  sent.length = 0
})

describe('echoUserTurn — an ordinary typed turn', () => {
  it('publishes to the Studio mirror and sends a thin client nothing', () => {
    // A thin client receives the owner store's row on its transcript stream.
    const published = echoUserTurn({ tabId: 'tab-1', id: 'req-1', content: 'a turn I typed' })

    expect(published).toBe(true)
    expect(studioEcho).toHaveBeenCalledTimes(1)
    expect(studioPayload()).toMatchObject({ id: 'req-1', content: 'a turn I typed' })
    expect(sent).toEqual([])
  })
})

describe('echoUserTurn — attachments', () => {
  const image = { id: 'att-1', type: 'image' as const, name: 'shot.png', path: '/u/.ion/user-images/abc.png', dataUrl: 'data:image/png;base64,AAAA' }

  it('forwards the full attachments to the Studio mirror', () => {
    echoUserTurn({
      tabId: 'tab-1',
      id: 'req-1',
      content: 'Analyze the attached files.',
      studioAttachments: [image],
    })

    // The mirror builds its own Message from this payload, so a missing
    // attachments array is a bubble with words and no image.
    expect(studioEcho).toHaveBeenCalledWith('tab-1', expect.objectContaining({ attachments: [image] }))
  })

  it('omits the field when there is nothing attached', () => {
    echoUserTurn({ tabId: 'tab-1', id: 'req-2', content: 'no images', studioAttachments: [] })

    expect(studioPayload()).not.toHaveProperty('attachments')
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

describe('echoUserTurn — payload fidelity', () => {
  it('forwards structured-answer provenance to the Studio mirror', () => {
    echoUserTurn({
      tabId: 'tab-1',
      id: 'req-questions',
      content: '**Question?**\n- Answer',
      injectionKind: 'structured_answer',
    })

    expect(studioPayload()).toMatchObject({ content: '**Question?**\n- Answer', injectionKind: 'structured_answer' })
  })

  it('uses the caller timestamp when supplied', () => {
    echoUserTurn({ tabId: 'tab-1', id: 'req-1', content: 'x', timestamp: 1234 })

    expect(studioEcho).toHaveBeenCalledWith('tab-1', expect.objectContaining({ timestamp: 1234 }))
  })
})
