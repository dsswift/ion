// Tests for the desktop's reference policy implementation of the engine's
// before_early_stop_decision wire-protocol hook. The tests are split into
// two layers:
//
//   1. Pure `decideEarlyStopResponse` — the decision function with no I/O.
//      Exercises the resolution table across setting on/off, wouldContinue
//      true/false, and a representative model id from each major provider
//      to confirm the handler is model-agnostic.
//
//   2. The full `wireEarlyStopPolicy` integration with the session-plane
//      emitter and a fake bridge — confirms the handler responds via the
//      bridge with the response decideEarlyStopResponse computed, that the
//      setting is read on every event (so a toggle takes effect on the
//      next decision), and that detaching the handler stops responses.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

// Mock Electron's `app` and `safeStorage` before the import chain reaches
// settings-store → utils/secretStore (which imports from 'electron' at
// module-load). CI runs `npm ci --ignore-scripts`, so Electron's binary
// download postinstall is skipped — without this stub, the real
// node_modules/electron/index.js throws "Electron failed to install
// correctly" the moment the module graph is loaded and the test suite
// fails before any test body runs. Same idiom as secret-store.test.ts and
// ipc-session-prompt.test.ts.
vi.mock('electron', () => ({
  app: { get isPackaged() { return false } },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}))

import {
  decideEarlyStopResponse,
  buildContinueMessage,
  wireEarlyStopPolicy,
  type EarlyStopRequestEvent,
} from '../early-stop-policy'
import * as settingsStore from '../settings-store'

// Build a representative request event with sensible defaults; tests
// override only the fields relevant to the case they exercise.
function makeRequestEvent(
  overrides: Partial<EarlyStopRequestEvent> = {},
): EarlyStopRequestEvent {
  return {
    type: 'engine_early_stop_decision_request',
    earlyStopRequestId: 'req-test-1',
    earlyStopRunId: 'run-test-1',
    earlyStopModel: 'claude-sonnet-4-5',
    earlyStopTurnNumber: 1,
    earlyStopStopReason: 'end_turn',
    earlyStopCumulativeOutput: 4000,
    earlyStopBudget: 8000,
    earlyStopThresholdPct: 90,
    earlyStopContinuationCount: 0,
    earlyStopMaxContinuations: 3,
    earlyStopLastContinuationDelta: 0,
    earlyStopWouldContinue: true,
    earlyStopEligible: true,
    earlyStopIsSubagent: false,
    ...overrides,
  }
}

describe('decideEarlyStopResponse', () => {
  it('returns forceContinue=false when setting is disabled', () => {
    const event = makeRequestEvent({ earlyStopWouldContinue: true })
    const response = decideEarlyStopResponse(event, false)
    expect(response.forceContinue).toBe(false)
    expect(response.continueMessage).toBeUndefined()
  })

  it('opts in when the setting is on but the engine default is off', () => {
    const event = makeRequestEvent({ earlyStopWouldContinue: false })
    const response = decideEarlyStopResponse(event, true)
    expect(response.forceContinue).toBe(true)
    expect(response.continueMessage).toContain('Keep working')
    expect(response.overrideBudget).toBeUndefined()
    expect(response.overrideThresholdPct).toBeUndefined()
  })

  it('does not override an exhausted continuation cap', () => {
    const event = makeRequestEvent({
      earlyStopWouldContinue: false,
      earlyStopEligible: false,
      earlyStopContinuationCount: 3,
      earlyStopMaxContinuations: 3,
    })
    const response = decideEarlyStopResponse(event, true)
    expect(response).toEqual({})
  })

  it('does not override a response at the token threshold', () => {
    const event = makeRequestEvent({
      earlyStopWouldContinue: false,
      earlyStopEligible: false,
      earlyStopCumulativeOutput: 7200,
      earlyStopBudget: 8000,
      earlyStopThresholdPct: 90,
    })
    const response = decideEarlyStopResponse(event, true)
    expect(response).toEqual({})
  })

  it('supplies a CC-style continueMessage when setting is on and wouldContinue is true', () => {
    const event = makeRequestEvent({
      earlyStopCumulativeOutput: 4000,
      earlyStopBudget: 8000,
      earlyStopWouldContinue: true,
    })
    const response = decideEarlyStopResponse(event, true)
    expect(response.continueMessage).toBeDefined()
    expect(response.continueMessage).toContain('50%')
    expect(response.continueMessage).toContain('4,000')
    expect(response.continueMessage).toContain('8,000')
    expect(response.continueMessage).toContain('Keep working')
    // The desktop does NOT force-continue; it supplies the message and
    // defers the verdict to the engine's own merge logic.
    expect(response.forceContinue).toBeUndefined()
  })

  it('handles budget=0 gracefully (pct floored to 0, no division-by-zero)', () => {
    const event = makeRequestEvent({
      earlyStopCumulativeOutput: 4000,
      earlyStopBudget: 0,
      earlyStopWouldContinue: true,
    })
    const response = decideEarlyStopResponse(event, true)
    expect(response.continueMessage).toBeDefined()
    expect(response.continueMessage).toContain('0%')
    expect(response.continueMessage).toContain('4,000')
  })

  // Model-agnostic confirmation. The handler must produce a continueMessage
  // for the affirmative path regardless of provider so harness engineers
  // running non-Anthropic models pick up the behavior without source
  // changes. If a future tester wants to scope the nudge to one provider,
  // they do it in their fork — the reference shouldn't.
  it.each([
    ['anthropic', 'claude-sonnet-4-5'],
    ['openai', 'gpt-4o'],
    ['google', 'gemini-2.0-flash'],
    ['deepseek', 'deepseek-r1'],
    ['unknown', 'some-future-model-id'],
  ])('is model-agnostic: %s (%s) gets the same affirmative response', (_provider, model) => {
    const event = makeRequestEvent({ earlyStopModel: model, earlyStopWouldContinue: true })
    const response = decideEarlyStopResponse(event, true)
    expect(response.continueMessage).toBeDefined()
    expect(response.continueMessage).toContain('Keep working')
  })
})

describe('buildContinueMessage', () => {
  it('formats single-digit percent and small budget', () => {
    expect(buildContinueMessage(5, 50, 1000)).toBe(
      'Stopped at 5% of token target (50 / 1,000). Keep working — do not summarize.',
    )
  })

  it('formats large budget with thousand separators', () => {
    expect(buildContinueMessage(75, 6000, 8000)).toBe(
      'Stopped at 75% of token target (6,000 / 8,000). Keep working — do not summarize.',
    )
  })

  it('formats million-scale tokens', () => {
    expect(buildContinueMessage(50, 500000, 1000000)).toBe(
      'Stopped at 50% of token target (500,000 / 1,000,000). Keep working — do not summarize.',
    )
  })
})

describe('wireEarlyStopPolicy', () => {
  let readSettingsSpy: ReturnType<typeof vi.spyOn>
  let bridge: { sendRaw: ReturnType<typeof vi.fn> }
  let sessionPlane: EventEmitter

  beforeEach(() => {
    readSettingsSpy = vi.spyOn(settingsStore, 'readSettings')
    bridge = { sendRaw: vi.fn() }
    sessionPlane = new EventEmitter()
  })

  afterEach(() => {
    readSettingsSpy.mockRestore()
  })

  it('responds with the message when setting is on', () => {
    readSettingsSpy.mockReturnValue({ enableEarlyStopContinuation: true })
    wireEarlyStopPolicy(sessionPlane as any, bridge as any)

    sessionPlane.emit('engine_early_stop_decision_request', 'tab-1', makeRequestEvent())

    expect(bridge.sendRaw).toHaveBeenCalledTimes(1)
    const payload = bridge.sendRaw.mock.calls[0][0]
    expect(payload.cmd).toBe('early_stop_decision_response')
    expect(payload.key).toBe('tab-1')
    expect(payload.earlyStopRequestId).toBe('req-test-1')
    expect(payload.earlyStopContinueMessage).toContain('Keep working')
  })

  it('responds with forceContinue=false when setting is explicitly off', () => {
    readSettingsSpy.mockReturnValue({ enableEarlyStopContinuation: false })
    wireEarlyStopPolicy(sessionPlane as any, bridge as any)

    sessionPlane.emit('engine_early_stop_decision_request', 'tab-2', makeRequestEvent())

    expect(bridge.sendRaw).toHaveBeenCalledTimes(1)
    const payload = bridge.sendRaw.mock.calls[0][0]
    expect(payload.earlyStopForceContinue).toBe(false)
    expect(payload.earlyStopContinueMessage).toBeUndefined()
  })

  it('reads the setting on every event so flips take effect immediately', () => {
    // First event with setting on
    readSettingsSpy.mockReturnValueOnce({ enableEarlyStopContinuation: true })
    wireEarlyStopPolicy(sessionPlane as any, bridge as any)
    sessionPlane.emit('engine_early_stop_decision_request', 'tab-3', makeRequestEvent())

    // Then setting flipped off mid-session
    readSettingsSpy.mockReturnValueOnce({ enableEarlyStopContinuation: false })
    sessionPlane.emit('engine_early_stop_decision_request', 'tab-3', makeRequestEvent({ earlyStopRequestId: 'req-test-2' }))

    expect(bridge.sendRaw).toHaveBeenCalledTimes(2)
    const firstPayload = bridge.sendRaw.mock.calls[0][0]
    const secondPayload = bridge.sendRaw.mock.calls[1][0]
    expect(firstPayload.earlyStopContinueMessage).toBeDefined()
    expect(secondPayload.earlyStopForceContinue).toBe(false)
  })

  it('detach function stops further responses', () => {
    readSettingsSpy.mockReturnValue({ enableEarlyStopContinuation: true })
    const detach = wireEarlyStopPolicy(sessionPlane as any, bridge as any)

    sessionPlane.emit('engine_early_stop_decision_request', 'tab-4', makeRequestEvent())
    expect(bridge.sendRaw).toHaveBeenCalledTimes(1)

    detach()
    sessionPlane.emit('engine_early_stop_decision_request', 'tab-4', makeRequestEvent())
    expect(bridge.sendRaw).toHaveBeenCalledTimes(1)
  })
})
