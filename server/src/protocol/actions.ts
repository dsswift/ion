/**
 * actions — `studio_action` handling (manifest contract C3/C4, Phase 2
 * pseudocode `onAction`).
 *
 * The server IS the store owner (child 06 moved `useSessionStore` here in
 * full — there is no separate renderer process to forward to, unlike the
 * desktop's `main/ipc/studio.ts`, which relays `call-action` over IPC to
 * whichever window owns the store). A `studio_action` is therefore run
 * directly: validate the caller's scope, validate the argument shape against
 * the same `FORWARDED_ACTIONS` spec the desktop mirror uses
 * (`validForwardedAction`), then invoke `useSessionStore.getState()[action](...args)`
 * and reply with `ok/value/refusal/error`.
 */
import { FORWARDED_ACTIONS } from '@ion/shared/studio-wire/actions'
import { ACTIONS, scopeSatisfies } from '@ion/shared/studio-wire/action-scopes'
import { validForwardedAction } from '@ion/shared/studio-mirror-actions'
import type { Scope, StudioFrame } from '@ion/shared/studio-wire/types'
import { useSessionStore } from '../store/sessionStore'
import { AUTH_ACTIONS } from '../auth/actions'
import { TRANSFER_ACTIONS } from '../transfer/actions'
import { ENVIRONMENT_ACTIONS } from '../environment/actions'
import { FLEET_ACTIONS } from '../fleet/actions'
import { GIT_HOSTING_ACTIONS } from '../git/hosting/actions'
import { PROVIDER_ACTIONS } from './provider-actions'
import { SESSION_ACTIONS } from './session-actions'
import { MISC_ACTIONS } from './misc-actions'
import { AUTH_FLOW_ACTIONS } from './auth-flow-actions'
import { STUDIO_SETTINGS_ACTIONS } from './studio-settings-actions'
import { FILE_ACTIONS } from './file-actions'
import { GIT_ACTIONS } from './git-actions'
import { GIT_IDENTITY_ACTIONS } from './git-identity-actions'
import { SETTINGS_ACTIONS } from './settings-actions'
import { TERMINAL_ACTIONS } from './terminal-actions'
import { PORT_ACTIONS } from './port-actions'
import { log as _log, warn as _warn } from '../logger'
import type { Connection } from './connection'
import { connOwnsConversation, connOwnsTab } from './ownership'
import { setDriving } from './presence'
import { lockableActionGroup, computeSettingsHiddenGroups } from './settings-visibility'
import { developerSurfaceBlock } from '@ion/shared/developer-surfaces'
import { enterprisePolicyCache } from '../state'
import type { SessionActionSpec } from './session-actions'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('studio-actions', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('studio-actions', msg, fields)
}

export type StudioActionFrame = Extract<StudioFrame, { type: 'studio_action' }>

/**
 * Every `studio_action` name this server answers: the store actions a mirror
 * forwards, plus each namespaced map `handleAction` dispatches through below.
 * A name absent from here is answered `unknown_action`. The phone-command
 * parity test reads it to prove every command a client maps has a real target.
 */
export function registeredActionNames(): Set<string> {
  return new Set([
    ...Object.keys(FORWARDED_ACTIONS),
    ...[
      AUTH_ACTIONS, TERMINAL_ACTIONS, PORT_ACTIONS, GIT_IDENTITY_ACTIONS, SETTINGS_ACTIONS, GIT_ACTIONS, FILE_ACTIONS, PROVIDER_ACTIONS,
      STUDIO_SETTINGS_ACTIONS, AUTH_FLOW_ACTIONS, MISC_ACTIONS, SESSION_ACTIONS, TRANSFER_ACTIONS, ENVIRONMENT_ACTIONS, FLEET_ACTIONS, GIT_HOSTING_ACTIONS,
    ].flatMap((map) => Object.keys(map)),
  ])
}

/**
 * The scope `action` requires, and whether it refuses every caller but the
 * local desktop, from the same maps `handleAction` dispatches through (in its
 * order). Undefined for a name this server does not answer.
 */
export function registeredActionSpec(action: string): { requiredScope: Scope; localOnly: boolean } | undefined {
  const maps: ReadonlyArray<Record<string, { requiredScope: Scope; localOnly?: true }>> = [
    AUTH_ACTIONS, TERMINAL_ACTIONS, PORT_ACTIONS, GIT_IDENTITY_ACTIONS, SETTINGS_ACTIONS, GIT_ACTIONS, FILE_ACTIONS, PROVIDER_ACTIONS,
    STUDIO_SETTINGS_ACTIONS, AUTH_FLOW_ACTIONS, MISC_ACTIONS, SESSION_ACTIONS, TRANSFER_ACTIONS, ENVIRONMENT_ACTIONS, FLEET_ACTIONS, GIT_HOSTING_ACTIONS,
  ]
  for (const map of maps) {
    const spec = map[action]
    if (spec) return { requiredScope: spec.requiredScope, localOnly: spec.localOnly === true }
  }
  const forwarded = ACTIONS[action]
  return forwarded ? { requiredScope: forwarded.requiredScope, localOnly: false } : undefined
}

/**
 * True when `conn` may act on the tab `action` names, if any. `ACTIONS`
 * (`@ion/shared/studio-wire/actions`) already carries `tabIdAt` per action —
 * built from `FORWARDED_ACTIONS`, the SAME namespace every category branch
 * below (`TERMINAL_ACTIONS`, `GIT_ACTIONS`, `SESSION_ACTIONS`'s mirror-store
 * subset, the final fallback, ...) dispatches through, so this one check
 * covers every action that names a tab regardless of which branch ultimately
 * handles it. An action with no `tabIdAt` (auth, settings, provider, raw
 * git/file RPCs keyed by path) is unaffected — the check is a no-op.
 */
function actionOwnsTargetTab(conn: Connection, action: string, args: unknown[]): boolean {
  const tabIdAt = ACTIONS[action]?.argsSchema.tabIdAt
  if (tabIdAt === undefined) return true
  const tabId = args[tabIdAt]
  if (typeof tabId !== 'string') return true // malformed shape is refused downstream by validForwardedAction
  return connOwnsTab(conn, tabId)
}

/**
 * True when `conn` owns every tab/conversation `spec` names in `args` (A2b:
 * `session.*` actions key on a `tabId` or one-or-more conversation/session
 * ids, a different dimension than the mirror-store `tabIdAt` above, so
 * `SessionActionSpec` carries its own declarative extractors). No extractor
 * set on `spec` is a no-op, matching `actionOwnsTargetTab`'s convention.
 */
function sessionActionOwnsTargets(conn: Connection, spec: SessionActionSpec, args: unknown[]): boolean {
  const tabId = spec.tabIdAt?.(args)
  if (tabId !== undefined && !connOwnsTab(conn, tabId)) return false
  const conversationIds = spec.conversationIdsAt?.(args) ?? []
  return conversationIds.every((id) => connOwnsConversation(conn, id))
}

/** Reply to a `studio_action` on `conn` and run it, if scope, ownership, and shape all check out. */
export async function handleAction(conn: Connection, frame: StudioActionFrame): Promise<void> {
  if (!actionOwnsTargetTab(conn, frame.action, frame.args)) {
    warn('action refused: tab not owned by connection', { connection_id: conn.id, action: frame.action, subject: conn.principal?.subject })
    conn.send({
      type: 'studio_action_result',
      id: frame.id,
      ok: false,
      refusal: { code: 'ownership', message: `${frame.action} targets a tab this connection does not own` },
    })
    return
  }
  const blockedSurfaces = developerSurfaceBlock(frame.action, conn.developerSurfaces)
  if (blockedSurfaces) {
    warn('action refused: developer surface disabled', { connection_id: conn.id, action: frame.action, surfaces: blockedSurfaces, transport: conn.transport })
    conn.send({
      type: 'studio_action_result',
      id: frame.id,
      ok: false,
      refusal: { code: 'surface_disabled', message: `${frame.action} is not available on this server` },
    })
    return
  }
  const lockedGroup = lockableActionGroup(frame.action)
  if (lockedGroup) {
    const hiddenGroups = computeSettingsHiddenGroups(conn, enterprisePolicyCache.policy)
    if (hiddenGroups.includes(lockedGroup)) {
      warn('action refused: settings group locked for this connection', { connection_id: conn.id, action: frame.action, group: lockedGroup })
      conn.send({
        type: 'studio_action_result',
        id: frame.id,
        ok: false,
        refusal: { code: 'settings_locked', message: `${frame.action} is in the "${lockedGroup}" settings group, which is hidden for this connection` },
      })
      return
    }
  }

  const authSpec = AUTH_ACTIONS[frame.action]
  if (authSpec) {
    if (!scopeSatisfies(conn.scopes, authSpec.requiredScope)) {
      log('auth action refused: insufficient scope', { connection_id: conn.id, action: frame.action, required_scope: authSpec.requiredScope, granted_scopes: conn.scopes })
      conn.send({ type: 'studio_action_result', id: frame.id, ok: false, refusal: { code: 'scope', message: `${frame.action} requires scope ${authSpec.requiredScope}` } })
      return
    }
    try {
      // AUTH_ACTIONS handlers may be sync (credential/pairing bookkeeping) or
      // async (oidc.token forwards to the engine's oidc_token command) --
      // `await` on a non-Promise value is a no-op, so this covers both.
      const outcome = await authSpec.handler(conn, frame.args)
      if (!outcome.ok) {
        conn.send({ type: 'studio_action_result', id: frame.id, ok: false, refusal: 'refusal' in outcome ? outcome.refusal : undefined, error: 'error' in outcome ? outcome.error : undefined })
        return
      }
      log('auth action ran', { connection_id: conn.id, action: frame.action, subject: conn.principal?.subject })
      conn.send({ type: 'studio_action_result', id: frame.id, ok: true, value: outcome.value === undefined ? null : outcome.value })
    } catch (err) {
      warn('auth action threw', { connection_id: conn.id, action: frame.action, error: String(err) })
      conn.send({ type: 'studio_action_result', id: frame.id, ok: false, error: { code: 'action_failed', message: String(err) } })
    }
    return
  }

  const terminalSpec = TERMINAL_ACTIONS[frame.action] ?? PORT_ACTIONS[frame.action]
  if (terminalSpec) {
    if (!scopeSatisfies(conn.scopes, terminalSpec.requiredScope)) {
      log('terminal action refused: insufficient scope', { connection_id: conn.id, action: frame.action, required_scope: terminalSpec.requiredScope, granted_scopes: conn.scopes })
      conn.send({ type: 'studio_action_result', id: frame.id, ok: false, refusal: { code: 'scope', message: `${frame.action} requires scope ${terminalSpec.requiredScope}` } })
      return
    }
    const outcome = await terminalSpec.handler(conn, frame.args)
    if (!outcome.ok) {
      conn.send({ type: 'studio_action_result', id: frame.id, ok: false, error: outcome.error })
      return
    }
    conn.send({ type: 'studio_action_result', id: frame.id, ok: true, value: outcome.value })
    return
  }

  const gitIdentitySpec = GIT_IDENTITY_ACTIONS[frame.action]
  if (gitIdentitySpec) {
    if (!scopeSatisfies(conn.scopes, gitIdentitySpec.requiredScope)) {
      log('git identity action refused: insufficient scope', { connection_id: conn.id, action: frame.action, required_scope: gitIdentitySpec.requiredScope, granted_scopes: conn.scopes })
      conn.send({ type: 'studio_action_result', id: frame.id, ok: false, refusal: { code: 'scope', message: `${frame.action} requires scope ${gitIdentitySpec.requiredScope}` } })
      return
    }
    const outcome = await gitIdentitySpec.handler(conn, frame.args)
    if (!outcome.ok) {
      conn.send({ type: 'studio_action_result', id: frame.id, ok: false, error: outcome.error })
      return
    }
    conn.send({ type: 'studio_action_result', id: frame.id, ok: true, value: outcome.value })
    return
  }

  const settingsSpec = SETTINGS_ACTIONS[frame.action]
  if (settingsSpec) {
    if (!scopeSatisfies(conn.scopes, settingsSpec.requiredScope)) {
      log('settings action refused: insufficient scope', { connection_id: conn.id, action: frame.action, required_scope: settingsSpec.requiredScope, granted_scopes: conn.scopes })
      conn.send({ type: 'studio_action_result', id: frame.id, ok: false, refusal: { code: 'scope', message: `${frame.action} requires scope ${settingsSpec.requiredScope}` } })
      return
    }
    const outcome = await settingsSpec.handler(conn, frame.args)
    if (!outcome.ok) {
      conn.send({ type: 'studio_action_result', id: frame.id, ok: false, error: outcome.error })
      return
    }
    conn.send({ type: 'studio_action_result', id: frame.id, ok: true, value: outcome.value })
    return
  }

  const gitSpec = GIT_ACTIONS[frame.action]
  if (gitSpec) {
    if (!scopeSatisfies(conn.scopes, gitSpec.requiredScope)) {
      log('git action refused: insufficient scope', { connection_id: conn.id, action: frame.action, required_scope: gitSpec.requiredScope, granted_scopes: conn.scopes })
      conn.send({ type: 'studio_action_result', id: frame.id, ok: false, refusal: { code: 'scope', message: `${frame.action} requires scope ${gitSpec.requiredScope}` } })
      return
    }
    const outcome = await gitSpec.handler(conn, frame.args)
    if (!outcome.ok) {
      conn.send({ type: 'studio_action_result', id: frame.id, ok: false, error: outcome.error })
      return
    }
    conn.send({ type: 'studio_action_result', id: frame.id, ok: true, value: outcome.value })
    return
  }

  const fileSpec = FILE_ACTIONS[frame.action]
  if (fileSpec) {
    if (!scopeSatisfies(conn.scopes, fileSpec.requiredScope)) {
      log('file action refused: insufficient scope', { connection_id: conn.id, action: frame.action, required_scope: fileSpec.requiredScope, granted_scopes: conn.scopes })
      conn.send({ type: 'studio_action_result', id: frame.id, ok: false, refusal: { code: 'scope', message: `${frame.action} requires scope ${fileSpec.requiredScope}` } })
      return
    }
    const outcome = await fileSpec.handler(conn, frame.args)
    if (!outcome.ok) {
      conn.send({ type: 'studio_action_result', id: frame.id, ok: false, error: outcome.error })
      return
    }
    conn.send({ type: 'studio_action_result', id: frame.id, ok: true, value: outcome.value })
    return
  }

  const providerSpec = PROVIDER_ACTIONS[frame.action]
  if (providerSpec) {
    if (!scopeSatisfies(conn.scopes, providerSpec.requiredScope)) {
      log('provider action refused: insufficient scope', { connection_id: conn.id, action: frame.action, required_scope: providerSpec.requiredScope, granted_scopes: conn.scopes })
      conn.send({ type: 'studio_action_result', id: frame.id, ok: false, refusal: { code: 'scope', message: `${frame.action} requires scope ${providerSpec.requiredScope}` } })
      return
    }
    const outcome = await providerSpec.handler(conn, frame.args)
    if (!outcome.ok) {
      conn.send({ type: 'studio_action_result', id: frame.id, ok: false, error: outcome.error })
      return
    }
    log('provider action ran', { connection_id: conn.id, action: frame.action, subject: conn.principal?.subject })
    conn.send({ type: 'studio_action_result', id: frame.id, ok: true, value: outcome.value })
    return
  }

  const studioSettingsSpec = STUDIO_SETTINGS_ACTIONS[frame.action]
  if (studioSettingsSpec) {
    if (!scopeSatisfies(conn.scopes, studioSettingsSpec.requiredScope)) {
      log('studio settings action refused: insufficient scope', { connection_id: conn.id, action: frame.action, required_scope: studioSettingsSpec.requiredScope, granted_scopes: conn.scopes })
      conn.send({ type: 'studio_action_result', id: frame.id, ok: false, refusal: { code: 'scope', message: `${frame.action} requires scope ${studioSettingsSpec.requiredScope}` } })
      return
    }
    const outcome = await studioSettingsSpec.handler(conn, frame.args)
    if (!outcome.ok) {
      conn.send({ type: 'studio_action_result', id: frame.id, ok: false, error: outcome.error })
      return
    }
    conn.send({ type: 'studio_action_result', id: frame.id, ok: true, value: outcome.value })
    return
  }

  const authFlowSpec = AUTH_FLOW_ACTIONS[frame.action]
  if (authFlowSpec) {
    if (!scopeSatisfies(conn.scopes, authFlowSpec.requiredScope)) {
      log('auth flow action refused: insufficient scope', { connection_id: conn.id, action: frame.action, required_scope: authFlowSpec.requiredScope, granted_scopes: conn.scopes })
      conn.send({ type: 'studio_action_result', id: frame.id, ok: false, refusal: { code: 'scope', message: `${frame.action} requires scope ${authFlowSpec.requiredScope}` } })
      return
    }
    const outcome = await authFlowSpec.handler(conn, frame.args)
    if (!outcome.ok) {
      conn.send({ type: 'studio_action_result', id: frame.id, ok: false, error: outcome.error })
      return
    }
    conn.send({ type: 'studio_action_result', id: frame.id, ok: true, value: outcome.value })
    return
  }

  const miscSpec = MISC_ACTIONS[frame.action]
  if (miscSpec) {
    if (!scopeSatisfies(conn.scopes, miscSpec.requiredScope)) {
      log('action refused: insufficient scope', { connection_id: conn.id, action: frame.action, required_scope: miscSpec.requiredScope, granted_scopes: conn.scopes })
      conn.send({ type: 'studio_action_result', id: frame.id, ok: false, refusal: { code: 'scope', message: `${frame.action} requires scope ${miscSpec.requiredScope}` } })
      return
    }
    const outcome = await miscSpec.handler(conn, frame.args)
    if (!outcome.ok) {
      conn.send({ type: 'studio_action_result', id: frame.id, ok: false, error: outcome.error })
      return
    }
    conn.send({ type: 'studio_action_result', id: frame.id, ok: true, value: outcome.value })
    return
  }

  const sessionSpec = SESSION_ACTIONS[frame.action]
  if (sessionSpec) {
    if (!scopeSatisfies(conn.scopes, sessionSpec.requiredScope)) {
      log('session action refused: insufficient scope', { connection_id: conn.id, action: frame.action, required_scope: sessionSpec.requiredScope, granted_scopes: conn.scopes })
      conn.send({ type: 'studio_action_result', id: frame.id, ok: false, refusal: { code: 'scope', message: `${frame.action} requires scope ${sessionSpec.requiredScope}` } })
      return
    }
    if (!sessionActionOwnsTargets(conn, sessionSpec, frame.args)) {
      warn('session action refused: target not owned by connection', { connection_id: conn.id, action: frame.action, subject: conn.principal?.subject })
      conn.send({ type: 'studio_action_result', id: frame.id, ok: false, refusal: { code: 'ownership', message: `${frame.action} targets a conversation this connection does not own` } })
      return
    }
    const outcome = await sessionSpec.handler(conn, frame.args)
    if (!outcome.ok) {
      conn.send({ type: 'studio_action_result', id: frame.id, ok: false, error: outcome.error })
      return
    }
    conn.send({ type: 'studio_action_result', id: frame.id, ok: true, value: outcome.value })
    return
  }

  const transferSpec = TRANSFER_ACTIONS[frame.action]
  if (transferSpec) {
    if (!scopeSatisfies(conn.scopes, transferSpec.requiredScope)) {
      log('transfer action refused: insufficient scope', { connection_id: conn.id, action: frame.action, required_scope: transferSpec.requiredScope, granted_scopes: conn.scopes })
      conn.send({ type: 'studio_action_result', id: frame.id, ok: false, refusal: { code: 'scope', message: `${frame.action} requires scope ${transferSpec.requiredScope}` } })
      return
    }
    try {
      // Unlike AUTH_ACTIONS's synchronous handlers, transfer handlers are
      // genuinely async (archive I/O, git plumbing) — awaited here.
      const outcome = await transferSpec.handler(conn, frame.args)
      if (!outcome.ok) {
        conn.send({ type: 'studio_action_result', id: frame.id, ok: false, refusal: 'refusal' in outcome ? outcome.refusal : undefined, error: 'error' in outcome ? outcome.error : undefined })
        return
      }
      log('transfer action ran', { connection_id: conn.id, action: frame.action, subject: conn.principal?.subject })
      conn.send({ type: 'studio_action_result', id: frame.id, ok: true, value: outcome.value === undefined ? null : outcome.value })
    } catch (err) {
      warn('transfer action threw', { connection_id: conn.id, action: frame.action, error: String(err) })
      conn.send({ type: 'studio_action_result', id: frame.id, ok: false, error: { code: 'action_failed', message: String(err) } })
    }
    return
  }

  const environmentSpec = ENVIRONMENT_ACTIONS[frame.action] ?? FLEET_ACTIONS[frame.action] ?? GIT_HOSTING_ACTIONS[frame.action]
  if (environmentSpec) {
    if (!scopeSatisfies(conn.scopes, environmentSpec.requiredScope)) {
      log('environment action refused: insufficient scope', { connection_id: conn.id, action: frame.action, required_scope: environmentSpec.requiredScope, granted_scopes: conn.scopes })
      conn.send({ type: 'studio_action_result', id: frame.id, ok: false, refusal: { code: 'scope', message: `${frame.action} requires scope ${environmentSpec.requiredScope}` } })
      return
    }
    try {
      const outcome = await environmentSpec.handler(conn, frame.args)
      if (!outcome.ok) {
        conn.send({ type: 'studio_action_result', id: frame.id, ok: false, refusal: 'refusal' in outcome ? outcome.refusal : undefined, error: 'error' in outcome ? outcome.error : undefined })
        return
      }
      log('environment action ran', { connection_id: conn.id, action: frame.action, subject: conn.principal?.subject })
      conn.send({ type: 'studio_action_result', id: frame.id, ok: true, value: outcome.value === undefined ? null : outcome.value })
    } catch (err) {
      warn('environment action threw', { connection_id: conn.id, action: frame.action, error: String(err) })
      conn.send({ type: 'studio_action_result', id: frame.id, ok: false, error: { code: 'action_failed', message: String(err) } })
    }
    return
  }

  const spec = ACTIONS[frame.action]
  if (!spec) {
    warn('action refused: not a registered studio_action', { connection_id: conn.id, action: frame.action })
    conn.send({
      type: 'studio_action_result',
      id: frame.id,
      ok: false,
      error: { code: 'unknown_action', message: `${frame.action} is not a registered studio_action` },
    })
    return
  }

  if (!scopeSatisfies(conn.scopes, spec.requiredScope)) {
    log('action refused: insufficient scope', {
      connection_id: conn.id,
      action: frame.action,
      required_scope: spec.requiredScope,
      granted_scopes: conn.scopes,
    })
    conn.send({
      type: 'studio_action_result',
      id: frame.id,
      ok: false,
      refusal: { code: 'scope', message: `${frame.action} requires scope ${spec.requiredScope}` },
    })
    return
  }

  if (!validForwardedAction(frame.action, frame.args)) {
    warn('action refused: argument shape rejected', { connection_id: conn.id, action: frame.action, arg_count: frame.args.length })
    conn.send({
      type: 'studio_action_result',
      id: frame.id,
      ok: false,
      error: { code: 'invalid_args', message: `${frame.action} received arguments that do not match its wire shape` },
    })
    return
  }

  const store = useSessionStore.getState() as unknown as Record<string, (...args: unknown[]) => unknown>
  const fn = store[frame.action]
  if (typeof fn !== 'function') {
    warn('action refused: no matching store action', { connection_id: conn.id, action: frame.action })
    conn.send({
      type: 'studio_action_result',
      id: frame.id,
      ok: false,
      error: { code: 'not_implemented', message: `the store has no action named ${frame.action}` },
    })
    return
  }

  // FR-02 presence: submitRemotePrompt (tabIdAt: 0) is the one mirror-store
  // action that starts a run, so it is the one place "who is driving this
  // tab" can be observed without threading presence through the whole
  // prompt pipeline. Cleared by wirePresenceDrivingTracking() once the
  // engine reports the tab has left 'running'.
  if (frame.action === 'submitRemotePrompt' && conn.principal && typeof frame.args[0] === 'string') {
    setDriving(frame.args[0], conn.principal.subject)
  }

  // An action that acts on the active tab carries the sending window's
  // active tab. Make it this server's active tab first, so the action lands
  // on the conversation the person is looking at. A tab this server does
  // not have (or the caller may not act on) is refused rather than letting
  // the action fall on some other conversation.
  if (FORWARDED_ACTIONS[frame.action]?.activeTab && typeof frame.activeTabId === 'string') {
    const wanted = frame.activeTabId
    const state = useSessionStore.getState()
    if (!state.tabs.some((t) => t.id === wanted) || !connOwnsTab(conn, wanted)) {
      warn('action refused: its active tab is not on this server', { connection_id: conn.id, action: frame.action, active_tab_id: wanted })
      conn.send({ type: 'studio_action_result', id: frame.id, ok: false, error: { code: 'unknown_tab', message: `this environment has no tab ${wanted} for ${frame.action} to act on` } })
      return
    }
    if (state.activeTabId !== wanted) {
      log('active tab set from the action frame', { connection_id: conn.id, action: frame.action, from: state.activeTabId ?? '', to: wanted })
      useSessionStore.setState({ activeTabId: wanted })
    } else {
      log('action frame names the tab already active here', { connection_id: conn.id, action: frame.action, active_tab_id: wanted })
    }
  }

  try {
    const value = await fn(...frame.args)
    log('action ran', { connection_id: conn.id, action: frame.action, subject: conn.principal?.subject })
    conn.send({ type: 'studio_action_result', id: frame.id, ok: true, value: value === undefined ? null : value })
  } catch (err) {
    warn('action threw', { connection_id: conn.id, action: frame.action, error: String(err) })
    conn.send({
      type: 'studio_action_result',
      id: frame.id,
      ok: false,
      error: { code: 'action_failed', message: String(err) },
    })
  }
}
