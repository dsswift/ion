/**
 * conversation-preferences — the Personal preferences a conversation runs
 * under, and how they get there.
 *
 * A Personal preference (`@ion/shared/settings-registry`, scope `personal`)
 * lives on a client. The client declares the ones the server consumes once
 * per connection (`preferences.declare`), and they ride every action it runs
 * as the ambient request preferences. The server stamps them onto a
 * conversation when a client creates it and again whenever a client sends it
 * a prompt, and from then on reads the STAMP.
 *
 * The stamp is what makes the no-request reads correct. An AI title fires
 * from an engine event. An early-stop decision is asked for mid-run. A
 * session is restarted after an engine crash with nobody connected. None of
 * those has a request to read from, and the server keeps no settings copy of
 * a Personal preference, so without the stamp each would fall back to a
 * default the person never chose.
 */
import {
  PERSONAL_PREFERENCE_DEFAULTS,
  TRAVELLING_PREFERENCE_KEYS,
  sanitizePersonalPreferences,
  type PersonalPreferences,
} from '@ion/shared/settings-registry'
import { currentPreferences } from './identity/request-principal'
import { readEffectiveSettings } from './persistence/effective-settings'
import { isThinkingEffort } from '@ion/shared/thinking-options'
import type { ThinkingConfig } from '@ion/shared/types-engine'
import type { ThinkingEffort } from '@ion/shared/types-session'
import { log as _log } from './logger'

function log(msg: string, fields?: Record<string, unknown>): void { _log('conversation-preferences', msg, fields) }

/** What the calling client declared, or nothing outside a request. */
export function requestPreferences(): PersonalPreferences {
  return currentPreferences() ?? {}
}

/** The stamp for a conversation being created now: the creating client's preferences. Always an object, so a created tab is never mistaken for a pre-upgrade one. */
export function stampForNewConversation(): PersonalPreferences {
  return { ...requestPreferences() }
}

/** The stamp after a client sent a prompt: that client's preferences over what the conversation already ran under. Identity-preserving when nothing changed. */
export function restamp(existing: PersonalPreferences | undefined): PersonalPreferences | undefined {
  const incoming = requestPreferences()
  const changed = (Object.keys(incoming) as Array<keyof PersonalPreferences>).some((key) => existing?.[key] !== incoming[key])
  return changed ? { ...existing, ...incoming } : existing
}

/** Every travelling preference resolved for a conversation: its stamp, then the registry default. */
export function effectiveConversationPreferences(tab: { conversationPreferences?: PersonalPreferences } | null | undefined): Required<PersonalPreferences> {
  return { ...PERSONAL_PREFERENCE_DEFAULTS, ...(tab?.conversationPreferences ?? {}) }
}

/** The preferences a conversation created right now starts under: the creating client's, then the registry default. */
export function effectiveRequestPreferences(): Required<PersonalPreferences> {
  return { ...PERSONAL_PREFERENCE_DEFAULTS, ...requestPreferences() }
}

/**
 * Restore-only. A persisted tab with no stamp predates the stamp, when these
 * preferences were read from the owner's settings on this server. Give it the
 * owner's values from that time, once, so an existing conversation behaves
 * after the upgrade exactly as it did before. The stamp is persisted with
 * the tab, so this runs at most once per conversation.
 */
export function restoredConversationPreferences(st: { id?: string; principalSubject?: string; conversationPreferences?: PersonalPreferences }): PersonalPreferences {
  if (st.conversationPreferences) return st.conversationPreferences
  const legacy = readEffectiveSettings(st.principalSubject)
  const picked: Record<string, unknown> = {}
  for (const key of TRAVELLING_PREFERENCE_KEYS) {
    if (key in legacy) picked[key] = legacy[key]
  }
  const stamp = sanitizePersonalPreferences(picked)
  log('stamped a pre-upgrade conversation from its owner\'s earlier settings', { tab_id: st.id ?? '', keys: Object.keys(stamp) })
  return stamp
}

/**
 * The level a new conversation's thinking control starts at, from a resolved
 * preference set. 'adaptive' is deliberately NOT accepted: this preference
 * seeds effort-based models, and adaptive models derive their own default
 * from capability metadata (`defaultEffortForMode`). A hand-edited 'adaptive'
 * would otherwise be sent to a model that cannot use it.
 */
export function defaultThinkingEffortOf(prefs: Pick<Required<PersonalPreferences>, 'defaultThinkingEffort'>): ThinkingEffort {
  const v = prefs.defaultThinkingEffort
  if (isThinkingEffort(v) && v !== 'adaptive') return v
  return 'medium'
}

/**
 * The per-session thinking config the server hands the engine on
 * `start_session` (`EngineConfig.thinking`), from the conversation's stamp.
 *
 * Returns `undefined` when the level is 'off', which is deliberate rather
 * than a `{enabled:false}` block: an omitted field leaves the engine's own
 * `engine.json` default in play, whereas the per-prompt `thinkingEffort` a
 * client sends on every submit is what actually decides each run. The session
 * default exists so a run dispatched WITHOUT a per-prompt effort — an
 * extension's `ctx.sendPrompt`, a scheduled job, a resumed session's first
 * engine-side turn — still reflects what the person chose.
 *
 * `streamDeltas` is deliberately left UNSET so the engine's default-ON
 * emission stands. It is tempting to wire it to `streamThinkingToRemote`, but
 * the two gate different hops: `streamDeltas` suppresses the engine's
 * per-token emission on the engine socket itself, which is the feed a
 * client's OWN thinking display renders from, whereas `streamThinkingToRemote`
 * drops the delta only on the forward path to a thin client. Wiring them
 * together would mean a person trimming phone bandwidth silently loses live
 * thinking in Studio.
 */
export function sessionThinkingConfigOf(prefs: Pick<Required<PersonalPreferences>, 'defaultThinkingEffort'>): ThinkingConfig | undefined {
  const effort = defaultThinkingEffortOf(prefs)
  if (effort === 'off') {
    log('thinking config: default level off, omitting session default')
    return undefined
  }
  log('thinking config: resolved session default', { reason: effort })
  return { enabled: true, effort }
}
