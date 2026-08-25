/**
 * User-turn echo funnel — the ONE place a user turn is published to a surface
 * that did not insert it itself.
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 *
 * A user turn is the one message class that does NOT ride engine events. The
 * engine never echoes user turns back (there is no `engine_user_turn`), so
 * every surface that did not perform the optimistic insert has to be told
 * separately:
 *
 *   - the Studio mirror, via `notifyStudioUserMessageEcho` (the owner store's
 *     insert lives only in the owner renderer);
 *   - iOS, via `desktop_message_added` on the desktop↔iOS wire.
 *
 * That left two independent, hand-written paths to the transcript per call
 * site, and six call sites across main. Each one re-decided, in its own
 * inline object literal, whether to echo. Nothing failed when one of them
 * forgot a rule the others applied.
 *
 * That is exactly how the guided-questions defect survived a fix: the
 * suppression was implemented in the owner store and in the engine's
 * persisted row, both correct — but the Studio mirror echo is a SEPARATE
 * source for the same turn, so the Overlay hid the message while the Studio
 * presentation still showed it. A per-site patch would have fixed that one
 * site and left the next author to rediscover the rule.
 *
 * So the rule lives here instead: `echoUserTurn` consults
 * `suppressesInjection` (the ONE shared classification, also read by the
 * owner store, the history mapper, and iOS) and fans out to both surfaces.
 * A machine-authored turn reaches the model and the persisted transcript and
 * is published to NO surface.
 *
 * ── For whoever adds the next hidden message class ──────────────────────────
 *
 * Do not add a suppression check to a call site. Classify the turn in the
 * engine (`engine/internal/types/injection_kind.go`) so `machineAuthored`
 * carries it, add the kind to the outbound set in
 * `shared/injection-policy.ts` if a CLIENT authors it, and this funnel
 * suppresses it on every surface at once.
 *
 * `main/__tests__/user-turn-echo-funnel.test.ts` fails the build if a new
 * direct echo appears outside this module.
 */
import { state } from './state'
import { notifyStudioUserMessageEcho } from './studio-window-manager'
import { suppressesInjection } from '../shared/injection-policy'
import type { RemoteAttachment } from './remote/protocol'
import { log as _log } from './logger'

const TAG = 'user-turn-echo'

/** One user turn to publish to the surfaces that did not insert it. */
export interface UserTurnEcho {
  tabId: string
  /** Correlation id. iOS replaces its optimistic bubble by this id. */
  id: string
  /** The text as the operator's own surface shows it. */
  content: string
  timestamp?: number
  /**
   * Provenance stamped on the echo so a receiving client can tell where the
   * turn came from. This is a LABEL, not a routing instruction: the canonical
   * iOS echo for an iOS-originated prompt is itself stamped 'remote' (it
   * carries the server-assigned id and timestamp the phone reconciles
   * against). Use the `ios` target to skip a send.
   */
  source?: 'desktop' | 'remote'
  implementationPhase?: boolean
  /** Attachment metadata forwarded so inline previews render on iOS. */
  attachments?: RemoteAttachment[]
  /** Slash display fields, when the turn is a slash invocation. */
  slashCommand?: string
  slashArgs?: string
  /**
   * How the turn was authored (engine InjectionKind wire value). A
   * machine-authored kind suppresses EVERY echo — the operator either typed
   * nothing at all (an agent callback) or answered in a dedicated surface
   * that already displays their answers (a Guided Questions submission).
   */
  injectionKind?: string
}

/** Which surfaces to publish to. Both default to on. */
export interface EchoTargets {
  /** The Studio mirror window. Off when the caller already pushed it. */
  studio?: boolean
  /** iOS over the desktop↔iOS wire. */
  ios?: boolean
}

/**
 * Publish one user turn to the Studio mirror and iOS, unless it is
 * machine-authored.
 *
 * Returns true when the turn was published, false when it was suppressed —
 * so a caller can log its own decision without re-deriving the rule.
 */
export function echoUserTurn(echo: UserTurnEcho, targets: EchoTargets = {}): boolean {
  const { studio = true, ios = true } = targets

  if (suppressesInjection({ injectionKind: echo.injectionKind })) {
    log('suppressed machine-authored user turn on every surface', {
      tab_id: echo.tabId,
      injection_kind: echo.injectionKind ?? '',
      content_len: echo.content.length,
    })
    return false
  }

  const timestamp = echo.timestamp ?? Date.now()

  if (studio) {
    notifyStudioUserMessageEcho(echo.tabId, {
      id: echo.id,
      content: echo.content,
      timestamp,
      ...(echo.implementationPhase ? { implementationPhase: true } : {}),
      // The mirror builds its own Message from this payload, so the
      // classification has to ride along or the Studio presentation renders a
      // questions submission as an ordinary bubble while the Overlay frames it.
      ...(echo.injectionKind ? { injectionKind: echo.injectionKind } : {}),
    })
  }

  // A caller that must NOT re-echo to iOS (because the phone already holds
  // the canonical row, or another path owns that send) passes ios:false.
  // Deliberately not inferred from `source`: an iOS-originated prompt's
  // canonical echo is stamped source:'remote' and MUST still be sent, since
  // that frame is what the phone reconciles its optimistic bubble against.
  if (ios && state.remoteTransport) {
    state.remoteTransport.send({
      type: 'desktop_message_added',
      tabId: echo.tabId,
      message: {
        id: echo.id,
        role: 'user',
        content: echo.content,
        timestamp,
        source: echo.source ?? 'desktop',
        ...(echo.implementationPhase ? { implementationPhase: true } : {}),
        ...(echo.attachments && echo.attachments.length > 0 ? { attachments: echo.attachments } : {}),
        ...(echo.slashCommand ? { slashCommand: echo.slashCommand, slashArgs: echo.slashArgs ?? '' } : {}),
      },
    })
  }

  return true
}

function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields)
}
