/**
 * Run an approved (or trusted) deep-link action. The local dispatcher and the
 * remote `deeplink.open` flow both end here, so an action behaves the same
 * whichever client approved it.
 */
import { runTerminalAction, type ActionOutcome } from './action-terminal'
import { runPromptAction } from './action-prompt'
import { runExtAction, type ResolvedExt } from './action-ext'
import type { DeepLinkActionPayload } from './parse'

export function executeDeepLinkAction(payload: DeepLinkActionPayload, ext: ResolvedExt | null): Promise<ActionOutcome> {
  if (payload.action === 'terminal') return runTerminalAction(payload)
  if (payload.action === 'prompt') return runPromptAction(payload)
  if (!ext) return Promise.resolve({ ok: false, error: 'The extension route was not resolved.' })
  return runExtAction(payload, ext)
}
