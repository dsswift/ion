/**
 * `terminal.*` / `bash.*` `studio_action`s — the wire face of
 * `terminal/terminal-api.ts`.
 *
 * Only the command half is here. Terminal OUTPUT already reaches every
 * client: the manager broadcasts `TERMINAL_INCOMING` / `TERMINAL_EXIT` /
 * `TERMINAL_ACTIVITY`, all three are registered channels, and `events.ts`
 * resolves the owning tab from the terminal key so a client sees only its
 * own terminals.
 *
 * ── Scope ───────────────────────────────────────────────────────────────
 * Everything here takes `terminal:operate`, the scope that exists for
 * exactly this. Attaching is included rather than treated as a read: an
 * attach can RESPAWN a dead terminal (`restartIfNotRunning`), and its reply
 * carries the full scrollback, so it is not an observation.
 */
import type { Scope } from '@ion/shared/studio-wire/types'
import * as terminalApi from '../terminal/terminal-api'
import { warn as _warn } from '../logger'
import type { Connection } from './connection'

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('terminal-actions', msg, fields)
}

export type TerminalActionOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string } }

export interface TerminalActionSpec {
  requiredScope: Scope
  handler: (conn: Connection, args: unknown[]) => Promise<TerminalActionOutcome>
}

function wrap(name: string, run: (args: unknown[]) => unknown): TerminalActionSpec {
  return {
    requiredScope: 'terminal:operate',
    handler: async (conn, args) => {
      try {
        return { ok: true, value: (await run(args)) ?? null }
      } catch (err) {
        warn('terminal action threw', { connection_id: conn.id, action: name, error: String(err) })
        return { ok: false, error: { code: 'terminal_action_failed', message: String(err) } }
      }
    },
  }
}

export const TERMINAL_ACTIONS: Record<string, TerminalActionSpec> = {
  'terminal.create': wrap('terminal.create', (a) => terminalApi.terminalCreate(a[0])),
  'terminal.write': wrap('terminal.write', (a) => terminalApi.terminalWrite(a[0])),
  'terminal.resize': wrap('terminal.resize', (a) => terminalApi.terminalResize(a[0])),
  'terminal.destroy': wrap('terminal.destroy', (a) => terminalApi.terminalDestroy(a[0])),
  'terminal.attach': wrap('terminal.attach', (a) => terminalApi.terminalAttach(a[0])),
  'terminal.activeTabs': wrap('terminal.activeTabs', () => terminalApi.terminalActiveTabs()),
  'terminal.activitySnapshot': wrap('terminal.activitySnapshot', () => terminalApi.terminalActivitySnapshot()),
  'bash.execute': wrap('bash.execute', (a) => terminalApi.executeBash(a[0])),
  'bash.cancel': wrap('bash.cancel', (a) => terminalApi.cancelBash(a[0])),
}
