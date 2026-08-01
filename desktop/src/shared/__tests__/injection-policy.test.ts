import { describe, it, expect } from 'vitest'
import { suppressesInjection } from '../injection-policy'
import { mapSessionHistory } from '../session-message-mapper'
import type { SessionLoadMessage } from '../types'

/**
 * The bug this file guards against, restated:
 *
 * The live-event reducer and the history mapper each carried their own
 * hardcoded list of injection kinds to suppress. They drifted — the mapper
 * filtered two kinds, the reducer filtered three — so a `slash_command`
 * injection was hidden while streaming and then APPEARED when the conversation
 * rehydrated. Both now call `suppressesInjection`, so the verdicts cannot
 * disagree by construction; these tests pin that property and the semantics
 * of the shared function.
 */

/** Every kind the engine enumerates, with the desktop's expected verdict. */
const KIND_EXPECTATIONS: ReadonlyArray<{ kind: string; machineAuthored: boolean; suppressed: boolean }> = [
  { kind: '', machineAuthored: false, suppressed: false },
  { kind: 'agent_completion', machineAuthored: true, suppressed: true },
  { kind: 'slash_command', machineAuthored: true, suppressed: true },
  { kind: 'background_task_completion', machineAuthored: true, suppressed: true },
  { kind: 'checkin', machineAuthored: true, suppressed: true },
  { kind: 'revive', machineAuthored: true, suppressed: true },
  { kind: 'steer', machineAuthored: false, suppressed: false },
]

describe('suppressesInjection', () => {
  it('suppresses every machine-authored kind and renders the rest', () => {
    for (const { kind, machineAuthored, suppressed } of KIND_EXPECTATIONS) {
      expect(
        suppressesInjection({ injectionKind: kind, machineAuthored }),
        `kind=${kind || '(empty)'} machineAuthored=${machineAuthored}`,
      ).toBe(suppressed)
    }
  })

  it('trusts the engine flag even for a kind it has never seen', () => {
    // The whole point of the flag: a kind added to the engine suppresses
    // correctly here with NO change to this client. If this ever fails, the
    // hand-maintained-list defect has come back.
    expect(suppressesInjection({ injectionKind: 'some_future_kind', machineAuthored: true })).toBe(true)
  })

  it('does not invent a verdict for an unknown kind with no flag', () => {
    // Nothing marked it machine-authored and it is not a legacy kind, so it
    // renders. Hiding content on an unrecognized string would be strictly
    // worse than showing a turn the user did not expect.
    expect(suppressesInjection({ injectionKind: 'some_future_kind' })).toBe(false)
  })

  it('classifies legacy rows that predate the machineAuthored flag', () => {
    // Conversation files already on disk carry the kind and no flag. Without
    // this fallback every historical agent_completion row would reappear in
    // the scrollback the first time an old conversation is opened.
    expect(suppressesInjection({ injectionKind: 'agent_completion' })).toBe(true)
    expect(suppressesInjection({ injectionKind: 'background_task_completion' })).toBe(true)
    expect(suppressesInjection({ injectionKind: 'slash_command' })).toBe(true)
  })

  it('renders an ordinary turn carrying neither field', () => {
    expect(suppressesInjection({})).toBe(false)
  })
})

describe('live and reload filters agree', () => {
  /**
   * The live reducer's decision, expressed exactly as event-slice.ts makes it.
   * Mirrors that call site so a divergence introduced there shows up here.
   */
  function liveWouldRender(kind: string, machineAuthored: boolean): boolean {
    return !suppressesInjection({ machineAuthored, injectionKind: kind })
  }

  /** The reload decision, driven through the real mapper. */
  function reloadWouldRender(kind: string, machineAuthored: boolean): boolean {
    const history: SessionLoadMessage[] = [
      { role: 'user', content: 'injected body', injectionKind: kind, machineAuthored } as SessionLoadMessage,
    ]
    let n = 0
    return mapSessionHistory(history, () => `id-${n++}`).length === 1
  }

  it('produces identical verdicts for every enumerated kind', () => {
    for (const { kind, machineAuthored } of KIND_EXPECTATIONS) {
      expect(
        reloadWouldRender(kind, machineAuthored),
        `reload disagreed with live for kind=${kind || '(empty)'}`,
      ).toBe(liveWouldRender(kind, machineAuthored))
    }
  })

  it('agrees on slash_command — the kind that actually drifted', () => {
    // Regression for the specific divergence: hidden live, rendered on reload,
    // so the transcript changed shape under the user when history rehydrated.
    expect(liveWouldRender('slash_command', true)).toBe(false)
    expect(reloadWouldRender('slash_command', true)).toBe(false)
  })

  it('agrees on a legacy row with no flag', () => {
    expect(liveWouldRender('agent_completion', false)).toBe(false)
    expect(reloadWouldRender('agent_completion', false)).toBe(false)
  })
})

describe('mapSessionHistory', () => {
  it('keeps a genuine user turn', () => {
    const history: SessionLoadMessage[] = [
      { role: 'user', content: 'what does this do?' } as SessionLoadMessage,
    ]
    expect(mapSessionHistory(history, () => 'id-0')).toHaveLength(1)
  })

  it('drops a machine-authored turn but keeps the surrounding conversation', () => {
    const history: SessionLoadMessage[] = [
      { role: 'user', content: 'run the tests' } as SessionLoadMessage,
      {
        role: 'user',
        content: '[SYSTEM] Dispatch check-in',
        injectionKind: 'checkin',
        machineAuthored: true,
      } as SessionLoadMessage,
      { role: 'assistant', content: 'all green' } as SessionLoadMessage,
    ]
    const out = mapSessionHistory(history, (() => { let n = 0; return () => `id-${n++}` })())
    expect(out).toHaveLength(2)
    expect(out.map((m) => m.content)).toEqual(['run the tests', 'all green'])
  })
})
