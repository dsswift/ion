/**
 * `session.*` / `engine.*` / `policy.*` `studio_action`s — the wire face of
 * the session and conversation reads plus the two engine passthroughs.
 *
 * Every entry maps to a function in `store/session-reads.ts`, the engine
 * bridge, or `engine/engine-bridge-fs.ts` — the same implementations the
 * Electron preload bridge reaches through `main/ipc/sessions-list.ts` and
 * `main/ipc/engine.ts`. Neither transport owns the behavior.
 *
 * ── Scope ───────────────────────────────────────────────────────────────
 * Reads are `conversations:read`: a client that may see conversations may
 * read their pages, transcripts, plans, inline images, and the local session
 * archive. The two mutations are `conversations:operate`, matching every
 * other action that changes what an engine session is doing.
 */
import type { Scope } from '@ion/shared/studio-wire/types'
import * as reads from '../store/session-reads'
import { getActiveInstanceMessages } from '../store/session-store-facade'
import { getEnterprisePolicy, getEnterprisePolicyNewConversationDefaults, resolveNewConversationDefaults } from '../engine/engine-bridge-fs'
import { engineBridge, sessionPlane } from '../state'
import { log as _log, warn as _warn } from '../logger'
import type { Connection } from './connection'
import { readPlanWindow, utf8Window } from '../plan-content-window'
import { ENGINE_ACTIONS } from './engine-actions'
import { PARITY_ACTIONS } from './parity-actions'

/** The largest transcript window served in one reply. A relay caps a message; this stays well inside it. */
const TRANSCRIPT_WINDOW_MAX_BYTES = 1024 * 1024

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('session-actions', msg, fields)
}

export interface SessionActionSpec {
  requiredScope: Scope
  handler: (conn: Connection, args: unknown[]) => Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }>
  /** Extracts the tabId this action names, if any. Ownership-checked in `actions.ts` against `principalSubjectForTab`, same mechanism `FORWARDED_ACTIONS.tabIdAt` uses for mirror-store actions. */
  tabIdAt?: (args: unknown[]) => string | undefined
  /** Extracts the conversation/session ids this action names, if any. Every id must resolve to the caller's own principal (`principalSubjectForConversation`) or the action is refused. */
  conversationIdsAt?: (args: unknown[]) => string[]
}

function wrap(name: string, requiredScope: Scope, run: (args: unknown[]) => unknown | Promise<unknown>): SessionActionSpec {
  return {
    requiredScope,
    handler: async (conn, args) => {
      try {
        return { ok: true, value: (await run(args)) ?? null }
      } catch (err) {
        warn('session action threw', { connection_id: conn.id, action: name, error: String(err) })
        return { ok: false, error: { code: 'session_action_failed', message: String(err) } }
      }
    },
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

export const SESSION_ACTIONS: Record<string, SessionActionSpec> = {
  'session.discoverCommands': wrap('session.discoverCommands', 'conversations:read', (a) => reads.discoverCommands(str(a[0]))),
  'session.load': wrap('session.load', 'conversations:read', (a) => reads.loadSession(a[0] as never)),
  'session.exists': wrap('session.exists', 'conversations:read', (a) => reads.conversationExistsRead(str(a[0]))),
  // A path reads the whole plan, as it always has. An object asks for one
  // bounded window (`{planFilePath, questionId?, offset?, length?}`), which
  // is what a client on a constrained route pages through.
  'session.readPlan': wrap('session.readPlan', 'conversations:read', (a) => {
    if (typeof a[0] === 'string' || a[0] == null) return reads.readPlan(str(a[0]))
    const p = a[0] as { planFilePath?: unknown; questionId?: unknown; offset?: unknown; length?: unknown }
    return readPlanWindow({
      planFilePath: str(p.planFilePath),
      questionId: typeof p.questionId === 'string' ? p.questionId : undefined,
      offset: typeof p.offset === 'number' ? p.offset : undefined,
      length: typeof p.length === 'number' ? p.length : undefined,
    })
  }),
  // `[filePath, { maxBytes? }]` -> `{ dataUrl, error? }`. `maxBytes` lowers the size limit for a constrained route.
  'session.readImageDataUrl': wrap('session.readImageDataUrl', 'conversations:read', (a) => {
    const maxBytes = (a[1] as { maxBytes?: unknown } | undefined)?.maxBytes
    return reads.readImageDataUrl(str(a[0]), typeof maxBytes === 'number' ? { maxBytes } : {})
  }),
  // `{conversationId, offset?, limit?}` is one raw engine page: fifty rows
  // when `limit` is absent, every row when it is `0`. Naming
  // `conversationIds` instead asks for a sub-agent's whole transcript across
  // its dispatches: every row, tool results capped, the agent named. Both
  // forms are ownership-checked on every id they name.
  'session.getConversation': {
    ...wrap('session.getConversation', 'conversations:read', (a) => {
      const p = (a[0] ?? {}) as { conversationId?: string; offset?: number; limit?: number }
      return reads.getConversationPage({ conversationId: str(p.conversationId), offset: Number(p.offset) || 0, limit: p.limit === 0 ? 0 : Number(p.limit) || 50 })
    }),
    conversationIdsAt: (a) => [str(((a[0] ?? {}) as { conversationId?: string }).conversationId)],
  },
  // A tab id reads the whole transcript, as it always has. An object asks for
  // one window of it (`{tabId, offset?, length?}`, byte offsets, never ending
  // inside a character).
  'session.loadTranscript': {
    ...wrap('session.loadTranscript', 'conversations:read', async (a) => {
      if (typeof a[0] === 'string' || a[0] == null) return reads.loadConversationTranscriptForTab(str(a[0]))
      const p = a[0] as { tabId?: unknown; offset?: unknown; length?: unknown }
      const buf = Buffer.from(await reads.loadConversationTranscriptForTab(str(p.tabId)), 'utf-8')
      const offset = typeof p.offset === 'number' && p.offset > 0 ? Math.floor(p.offset) : 0
      const length = typeof p.length === 'number' && p.length > 0 ? Math.min(Math.floor(p.length), TRANSCRIPT_WINDOW_MAX_BYTES) : TRANSCRIPT_WINDOW_MAX_BYTES
      const { text, end } = utf8Window(buf, offset, length)
      return { content: text, offset, totalBytes: buf.length, hasMore: end < buf.length }
    }),
    tabIdAt: (a) => (typeof a[0] === 'string' ? a[0] : str((a[0] as { tabId?: unknown } | undefined)?.tabId)),
  },
  'session.loadChainHistory': {
    ...wrap('session.loadChainHistory', 'conversations:read', (a) => reads.loadChainHistory(strs(a[0]))),
    conversationIdsAt: (a) => strs(a[0]),
  },
  'session.health': wrap('session.health', 'conversations:read', () => sessionPlane.getHealth()),

  // Enterprise policy and the new-conversation defaults resolver. Both are
  // reads over the ENVIRONMENT's own engine config, which is exactly what a
  // remote client needs before it can offer a directory picker.
  'policy.getFull': wrap('policy.getFull', 'conversations:read', () => getEnterprisePolicy()),
  // The NewConversationDefaults section alone, which the preferences store
  // loads at boot; `policy.getFull` carries it too, but the renderer applies
  // the two on different schedules (see preferences-bootstrap.ts).
  'policy.getNewConversationDefaults': wrap('policy.getNewConversationDefaults', 'conversations:read', () => getEnterprisePolicyNewConversationDefaults()),
  'session.resolveNewConversationDefaults': wrap('session.resolveNewConversationDefaults', 'conversations:read', (a) =>
    resolveNewConversationDefaults(str(a[0])),
  ),

  // The active instance's messages for one tab, as the Remote category's
  // diagnostics view reads them. Tab-owned like every other conversation read.
  'remote.getMessages': {
    ...wrap('remote.getMessages', 'conversations:read', (a) => getActiveInstanceMessages(str(a[0]))),
    tabIdAt: (a) => str(a[0]) || undefined,
  },

  'session.deleteStored': {
    ...wrap('session.deleteStored', 'conversations:operate', (a) => reads.deleteStoredConversations(strs(a[0]))),
    conversationIdsAt: (a) => strs(a[0]),
  },

  // Two engine passthroughs that have no store action. `engine.command` runs
  // a slash command in a live session; `engine.contextBreakdown` asks the
  // engine to emit one -- the reply is empty by design, the caller observes
  // the result on the event stream.
  'engine.command': wrap('engine.command', 'conversations:operate', (a) => {
    const p = (a[0] ?? {}) as { key?: string; command?: string; args?: string }
    const key = str(p.key)
    const command = str(p.command)
    const cmdArgs = str(p.args)
    _log('session-actions', 'engine_command', { key, command })
    void engineBridge
      .sendCommand({ key, text: `/${command}${cmdArgs ? ` ${cmdArgs}` : ''}` }, command, cmdArgs)
      .catch((err) => warn('engine_command: send failed', { key, command, error: String(err) }))
    return null
  }),
  'engine.contextBreakdown': wrap('engine.contextBreakdown', 'conversations:operate', (a) => {
    const p = (a[0] ?? {}) as { key?: string }
    engineBridge._send({ cmd: 'get_context_breakdown', key: str(p.key) })
    return null
  }),

  // The engine remainder and plugin management (`engine-actions.ts`).
  ...ENGINE_ACTIONS,
  // What the desktop_* wire could do and the Studio wire could not (`parity-actions.ts`).
  ...PARITY_ACTIONS,
}

export function isSessionAction(name: string): boolean {
  return name in SESSION_ACTIONS
}
