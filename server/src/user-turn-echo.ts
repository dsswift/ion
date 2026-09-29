/**
 * User-turn echo funnel — the ONE place a user turn is published to the
 * Studio mirror when the mirror did not insert it itself.
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 *
 * A user turn is the one message class that does NOT ride engine events. The
 * engine never echoes user turns back (there is no `engine_user_turn`), so the
 * Studio mirror has to be told via `notifyStudioUserMessageEcho` (the owner
 * store's insert lives only in the owner store). A thin client needs no echo:
 * it receives the owner store's own rows on its transcript stream.
 *
 * Several call sites publish a turn this way. Each one used to re-decide, in
 * its own inline object literal, whether to echo, and nothing failed when one
 * of them forgot a rule the others applied.
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
 * owner store and the history mapper). A machine-authored turn reaches the
 * model and the persisted transcript and is published to no surface.
 *
 * ── For whoever adds the next hidden message class ──────────────────────────
 *
 * Do not add a suppression check to a call site. Classify the turn in the
 * engine (`engine/internal/types/injection_kind.go`) so `machineAuthored`
 * carries it, add the kind to the outbound set in
 * `shared/injection-policy.ts` if a CLIENT authors it, and this funnel
 * suppresses it on every surface at once.
 *
 * `desktop/src/main/__tests__/user-turn-echo-funnel.test.ts` fails the build if a new
 * direct echo appears outside this module.
 */
import { notifyStudioUserMessageEcho } from './engine/studio-window-manager'
import { suppressesInjection } from '@ion/shared/injection-policy'
import type { Attachment } from '@ion/shared/types'
import { log as _log } from './logger'

const TAG = 'user-turn-echo'

/** One user turn to publish to the Studio mirror. */
export interface UserTurnEcho {
  tabId: string
  /** Correlation id: the owner store's row id for this turn. */
  id: string
  /** The text as the operator's own surface shows it. */
  content: string
  timestamp?: number
  implementationPhase?: boolean
  /** The owner bubble's full attachments, so the mirror renders the same inline previews. */
  studioAttachments?: Attachment[]
  /**
   * How the turn was authored (engine InjectionKind wire value). A
   * machine-authored kind suppresses the echo, because the operator typed
   * nothing at all (an agent callback, a background task result). A Guided
   * Questions submission (`structured_answer`) is operator input and is
   * echoed like any other turn; the mirror renders it as an answer card.
   */
  injectionKind?: string
}

/**
 * Publish one user turn to the Studio mirror, unless it is machine-authored.
 *
 * Returns true when the turn was published, false when it was suppressed --
 * so a caller can log its own decision without re-deriving the rule.
 */
export function echoUserTurn(echo: UserTurnEcho): boolean {
  if (suppressesInjection({ injectionKind: echo.injectionKind })) {
    log('suppressed machine-authored user turn', {
      tab_id: echo.tabId,
      injection_kind: echo.injectionKind ?? '',
      content_len: echo.content.length,
    })
    return false
  }

  const timestamp = echo.timestamp ?? Date.now()
  notifyStudioUserMessageEcho(echo.tabId, {
    id: echo.id,
    content: echo.content,
    timestamp,
    ...(echo.implementationPhase ? { implementationPhase: true } : {}),
    ...(echo.studioAttachments && echo.studioAttachments.length > 0 ? { attachments: echo.studioAttachments } : {}),
    // The mirror builds its own Message from this payload, so the
    // classification has to ride along or the Studio presentation renders a
    // questions submission as an ordinary bubble while the Overlay frames it.
    ...(echo.injectionKind ? { injectionKind: echo.injectionKind } : {}),
  })

  log('published user turn', {
    tab_id: echo.tabId,
    id: echo.id,
    injection_kind: echo.injectionKind ?? '',
    content_len: echo.content.length,
  })
  return true
}

function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields)
}
