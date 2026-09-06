// Reference policy implementation for the engine's
// before_early_stop_decision hook, wired into the desktop's engine bridge
// so this product is a first-class consumer of the wire-protocol surface
// added by the engine in commit 70bb2e38.
//
// What this module does
// ─────────────────────
// When the engine emits an `engine_early_stop_decision_request` event
// (the wire-protocol promotion of the before_early_stop_decision hook),
// this module:
//
//   1. Reads the user's `enableEarlyStopContinuation` setting.
//   2. Builds a response object — Claude-Code-style "Stopped at X% of
//      token target (Y / Z). Keep working — do not summarize." when the
//      setting is on and the engine's tentative WouldContinue is true.
//   3. Sends the response via the engine bridge's
//      `sendEarlyStopDecisionResponse` method, which serializes to the
//      `early_stop_decision_response` client command.
//
// The engine waits at most 100ms for a response, so this handler must be
// synchronous — no async I/O. The settings read is intentionally a single
// file-system stat + JSON parse via the existing settings-store helpers.
//
// Why this lives in the desktop, not the engine
// ─────────────────────────────────────────────
// Per docs/architecture/adr/001-engine-vs-harness.md and the engine
// grounding doc (§2), the engine provides the *mechanism* (cumulative
// output-token tracking, the wire-protocol request/response surface) and
// the harness owns the *policy* (whether to nudge, what text to send).
// The desktop is the canonical socket-only harness for Ion, but it is not
// special — any harness engineer can implement equivalent policy by
// subscribing to engine_early_stop_decision_request on their own socket
// connection and replying with `early_stop_decision_response`. This
// module is a reference implementation, not a privileged path.
//
// No model gating
// ───────────────
// Earlier internal drafts of this work scoped the nudge to Anthropic
// models specifically (the failure mode is most visible there). We
// dropped the model allowlist because (a) once policy is in the
// harness, the engine has no provider opinion either way and (b) users
// can already disable globally through the setting if a provider where
// they don't want the nudge surfaces spuriously. Keeping the handler
// model-agnostic also lets harness engineers running providers we
// haven't heard of pick up the behavior without source changes.

import type { EngineEvent } from '../shared/types-engine'
import type { EngineBridge } from './engine-bridge'
import { readSettings } from './settings-store'
import { log as _log, debug as _debug } from './logger'

const TAG = 'EarlyStopPolicy'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function debug(msg: string, fields?: Record<string, unknown>): void { _debug(TAG, msg, fields) }

// Default Claude-Code-style continuation prompt. The {pct}, {output}, and
// {budget} placeholders are filled at decision time so the model sees its
// exact context.
const CC_STYLE_TEMPLATE =
  'Stopped at {pct}% of token target ({output} / {budget}). Keep working — do not summarize.'

// formatTokens renders an integer with thousand separators ("8,000").
// Inlined here rather than depending on Intl.NumberFormat so the function
// is deterministic for tests and adds no Node-version surface.
function formatTokens(n: number): string {
  if (n < 0 || !Number.isFinite(n)) return String(n)
  if (n < 1000) return String(n)
  const s = String(n)
  const out: string[] = []
  let rem = s.length % 3
  if (rem > 0) {
    out.push(s.slice(0, rem))
  }
  for (let i = rem; i < s.length; i += 3) {
    out.push(s.slice(i, i + 3))
  }
  return out.join(',')
}

// buildContinueMessage renders the default template against a specific
// decision payload. Exported for test coverage; the wiring path also
// uses it internally.
export function buildContinueMessage(
  pct: number,
  cumulativeOutput: number,
  budget: number,
): string {
  return CC_STYLE_TEMPLATE.replace('{pct}', String(pct))
    .replace('{output}', formatTokens(cumulativeOutput))
    .replace('{budget}', formatTokens(budget))
}

// EarlyStopRequestEvent narrows the EngineEvent union to the request
// variant. Exported so tests can construct one without re-asserting the
// type discriminator everywhere.
export type EarlyStopRequestEvent = Extract<
  EngineEvent,
  { type: 'engine_early_stop_decision_request' }
>

// decideEarlyStopResponse is the pure decision function: given the
// engine's request payload and the current setting value, return the
// response object that should be sent on the wire. Pure so tests can
// exercise the matrix (setting on/off, would-continue true/false,
// various model ids) without spinning up the bridge.
//
// Resolution table:
//   setting off                                → { forceContinue: false }
//   setting on, eligible=false                 → {} (mechanical stop)
//   setting on, enabled-gate off, eligible=true → { forceContinue: true, message }
//   setting on, wouldContinue=true             → { continueMessage: <CC-style text> }
//
// ForceContinue is needed when the engine's generic default is disabled. The
// request still fires so this consumer can opt in without changing that default.
export function decideEarlyStopResponse(
  event: EarlyStopRequestEvent,
  enableEarlyStopContinuation: boolean,
): {
  forceContinue?: boolean
  overrideBudget?: number
  overrideThresholdPct?: number
  continueMessage?: string
} {
  if (!enableEarlyStopContinuation) {
    debug(
      `decision: setting=off → forceContinue=false (run=${event.earlyStopRunId} turn=${event.earlyStopTurnNumber})`,
    )
    return { forceContinue: false }
  }
  const shouldContinue = event.earlyStopWouldContinue || event.earlyStopEligible
  if (!shouldContinue) {
    debug(
      `decision: setting=on but limits reached → no opinion (run=${event.earlyStopRunId} turn=${event.earlyStopTurnNumber})`,
    )
    return {}
  }
  const forceContinue = event.earlyStopWouldContinue ? undefined : true
  const pct = event.earlyStopBudget > 0
    ? Math.floor((event.earlyStopCumulativeOutput * 100) / event.earlyStopBudget)
    : 0
  const message = buildContinueMessage(
    pct,
    event.earlyStopCumulativeOutput,
    event.earlyStopBudget,
  )
  debug(
    `decision: setting=on → continue (run=${event.earlyStopRunId} turn=${event.earlyStopTurnNumber} engine_would_continue=${event.earlyStopWouldContinue} pct=${pct} budget=${event.earlyStopBudget} model=${event.earlyStopModel})`,
  )
  return { forceContinue, continueMessage: message }
}

// sendEarlyStopDecisionResponse forwards a wire-protocol response to the
// engine. Lives as a free function in this module (rather than as a method
// on EngineBridge) so the bridge file stays under its size cap; the bridge
// exposes a generic `sendRaw` escape hatch used here. All response fields
// are optional; an empty `response` object expresses "no opinion" and the
// engine falls through to its existing merge logic. The engine waits ~100ms
// for this response, so callers must resolve synchronously off the
// corresponding event — no async I/O. Matches the protocol payload defined
// in engine/internal/protocol.
export function sendEarlyStopDecisionResponse(
  bridge: EngineBridge,
  key: string,
  requestId: string,
  response: {
    forceContinue?: boolean
    overrideBudget?: number
    overrideThresholdPct?: number
    continueMessage?: string
  },
): void {
  log(
    `sendEarlyStopDecisionResponse: key=${key} requestId=${requestId} ` +
      `forceContinue=${response.forceContinue ?? 'nil'} ` +
      `overrideBudget=${response.overrideBudget ?? 0} ` +
      `overrideThresholdPct=${response.overrideThresholdPct ?? 0} ` +
      `msg_len=${(response.continueMessage ?? '').length}`,
  )
  bridge.sendRaw({
    cmd: 'early_stop_decision_response',
    key,
    earlyStopRequestId: requestId,
    earlyStopForceContinue: response.forceContinue,
    earlyStopOverrideBudget: response.overrideBudget,
    earlyStopOverrideThresholdPct: response.overrideThresholdPct,
    earlyStopContinueMessage: response.continueMessage,
  })
}

// wireEarlyStopPolicy attaches the policy handler to the session-plane
// event stream. Call once at engine-control-plane construction; the
// returned function detaches the handler (useful for tests and HMR).
//
// The handler reads the setting on every event so a flip via the
// settings UI takes effect on the very next decision without requiring
// any cache invalidation. Reads are cheap (~200µs file stat + JSON
// parse) and the engine's 100ms timeout has ample headroom.
export function wireEarlyStopPolicy(
  sessionPlane: {
    on(event: 'engine_early_stop_decision_request', handler: (tabId: string, event: EarlyStopRequestEvent) => void): void
    off(event: 'engine_early_stop_decision_request', handler: (tabId: string, event: EarlyStopRequestEvent) => void): void
  },
  bridge: EngineBridge,
): () => void {
  const handler = (tabId: string, event: EarlyStopRequestEvent): void => {
    const settings = readSettings()
    // SETTINGS_DEFAULTS is false; only an explicit user opt-in enables policy.
    const enabled = settings.enableEarlyStopContinuation === true

    const response = decideEarlyStopResponse(event, enabled)
    log(
      `tabId=${tabId} requestId=${event.earlyStopRequestId} ` +
        `enabled=${enabled} wouldContinue=${event.earlyStopWouldContinue} eligible=${event.earlyStopEligible} ` +
        `replying: forceContinue=${response.forceContinue ?? 'nil'} ` +
        `msg_len=${(response.continueMessage ?? '').length}`,
    )
    sendEarlyStopDecisionResponse(bridge, tabId, event.earlyStopRequestId, response)
  }
  sessionPlane.on('engine_early_stop_decision_request', handler)
  return () => sessionPlane.off('engine_early_stop_decision_request', handler)
}
