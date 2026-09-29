/**
 * parity-client-actions -- the rest of what a client could do on the
 * `desktop_*` wire and not on the Studio wire: write this server's own
 * settings, hand over its diagnostic log, read a whole terminal pane, and
 * remove its own pairing.
 *
 * Same rule as `parity-actions.ts`: each is one `studio_action` over the
 * function the `desktop_*` handler calls, and none is specific to a phone.
 *
 * ── Why the settings writes are not `settings.save` ──────────────────────
 * `settings.save` stores a personal key in the CALLER's overlay, which is
 * right for a person's own Studio preferences. The settings here are the
 * server's: what it projects to every client. A write to them goes to the
 * server's settings
 * document through the one persist-and-broadcast funnel, so every client sees
 * it, whichever client made it.
 */
import { applyProjectableSetting } from '../remote/handlers/desktop-settings'
import { diagnosticLogCursor, handleDiagnosticLogsResponse } from '../remote/handlers/diagnostics'
import { readTerminalPaneSnapshot } from '../remote/handlers/terminal'
import { credentialsStore } from '../auth/credentials-store'
import { revokeClient } from '../auth/pairing-links'
import { log as _log } from '../logger'
import { connectionRegistry } from './connection'
import type { SessionActionSpec } from './session-actions'
import { Declined, clientKey, requireTab, str, tabAt, wrap } from './parity-wrap'

const count = (v: unknown): number | undefined => (typeof v === 'number' && v >= 0 ? v : undefined)

export const PARITY_CLIENT_ACTIONS: Record<string, SessionActionSpec> = {
  // [{ key, value }] -> { ok: true } | { ok: false, code, message }
  // `code` is `unknown_key`, `invalid_value`, `settings_locked` (the
  // enterprise theme lock), or `write_failed`. A refusal is a value, not an
  // error: the client keeps showing what it had and can say why.
  'settings.setProjectable': wrap('settings.setProjectable', 'conversations:operate', (a, conn) => {
    const key = str(a.key)
    if (!key) throw new Declined('key is required')
    if (!('value' in a)) throw new Declined('value is required')
    // The caller comes from the CONNECTION, never the payload: a client can
    // only write its own overlay, and only its granted scopes count.
    return applyProjectableSetting(key, a.value, { subject: conn.principal?.subject ?? '', scopes: conn.scopes, label: `client=${clientKey(conn).slice(0, 8)}`, transport: conn.transport })
  }),

  // [{ lines, nextSeq, pairingId, withheldUnstamped?, withheldOtherPairing? }] -> { nextSeq }
  // A client hands over the diagnostic log lines it has written since the
  // cursor it was last given. `lines` is newline-separated JSONL; each line is
  // stamped with who sent it and appended to `ios-diagnostic-logs.jsonl`, and
  // one at or below the persisted cursor is dropped, so a resend is harmless.
  // The answer is the cursor now persisted: where the next batch starts. An
  // empty `lines` asks for the cursor without sending anything.
  'clientLog.append': wrap('clientLog.append', 'conversations:operate', (a, conn) => {
    if (typeof a.lines !== 'string') throw new Declined('lines must be a string of newline-separated JSONL')
    if (typeof a.nextSeq !== 'number' || a.nextSeq < 0) throw new Declined('nextSeq must be a non-negative number')
    const client = clientKey(conn)
    handleDiagnosticLogsResponse({
      type: 'desktop_diagnostic_logs_response',
      logs: a.lines,
      pairingId: str(a.pairingId),
      nextSeq: a.nextSeq,
      withheldUnstamped: count(a.withheldUnstamped),
      withheldOtherPairing: count(a.withheldOtherPairing),
    }, client)
    return { nextSeq: diagnosticLogCursor(client) }
  }),

  // [{ tabId }] -> { tabId, instances, activeInstanceId, buffers? } | null
  // The whole pane: every instance and the scrollback held for each, where
  // `terminal.attach` reads one instance. A conversation whose terminal has
  // never been opened gets its default shell, which is why this takes the
  // scope that running a terminal takes. `null` when the tab does not exist.
  'terminal.paneSnapshot': wrap('terminal.paneSnapshot', 'terminal:operate', (a) => readTerminalPaneSnapshot(requireTab(a)), tabAt),

  // [] -> { revoked, closed }
  // Remove the pairing THIS connection rides: what a device does when its
  // owner chooses "forget this server". `auth.revokeClient` is the admin verb
  // for removing someone else's device and refuses the caller's own; this one
  // can name no pairing but the caller's own, which is why any paired client
  // may call it. Every live session on the pairing is closed `revoked` one
  // tick later, so this action's own result leaves first.
  'auth.forgetSelf': wrap('auth.forgetSelf', 'conversations:read', (_a, conn) => {
    const clientId = conn.pairedClientId
    if (!clientId) throw new Declined('this connection is not a paired client, so there is no pairing to forget')
    const revoked = revokeClient(credentialsStore(), clientId)
    const doomed = connectionRegistry.all().filter((live) => live.pairedClientId === clientId && !live.isClosed)
    setImmediate(() => { for (const live of doomed) if (!live.isClosed) live.close('revoked') })
    _log('parity-actions', 'client forgot its own pairing', { connection_id: conn.id, client_id: clientId, revoked, live_sessions_closed: doomed.length })
    return { revoked, closed: doomed.length }
  }),
}
