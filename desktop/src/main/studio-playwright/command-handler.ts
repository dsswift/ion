/**
 * Answers the local Environment's `browser.tool` studio_commands.
 *
 * The Studio server advertises the browser tools and answers the engine's
 * tool gate; the Playwright bodies that drive an Electron `BrowserView` can
 * only run here. So the server sends each call as one reverse
 * `studio_command` named `browser.tool` (`server/src/studio-playwright/
 * tool-executor.ts`), routed to the connection advertising `browser` -- this
 * desktop's broker connection (`connections/client-capabilities.ts`). The
 * frame arrives through the broker like every other frame; this handler
 * answers it and the renderer, which also sees it, ignores the family.
 *
 * Only the LOCAL Environment's commands are answered: a browser tool acts on
 * a `BrowserView` owned by the local server's conversation, and a remote
 * Environment has no Playwright runtime on this machine to reach.
 */
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import type { BrowserToolContext, BrowserToolResult } from '@ion/server/studio-playwright/tool-contracts'
import { fail } from '@ion/server/studio-playwright/tool-contracts'
import { broker as liveBroker } from '../connections/broker-instance'
import { log as _log, warn as _warn } from '../logger'
import { studioBrowserToolBody } from './tools'

const TAG = 'studio-playwright'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export const BROWSER_TOOL_COMMAND = 'browser.tool'

interface BrokerLike {
  onFrame(cb: (environmentId: string, frame: StudioFrame) => void): () => void
  send(environmentId: string, frame: StudioFrame): void
}

/** The wire shape of a `browser.tool` command's `args`, re-validated here before a body runs. */
function parseArgs(raw: unknown): { name: string; input: Record<string, unknown>; ctx: BrowserToolContext } | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  if (typeof v.name !== 'string' || !v.name) return null
  const input = v.input && typeof v.input === 'object' && !Array.isArray(v.input) ? (v.input as Record<string, unknown>) : {}
  const ctx = v.ctx as Partial<BrowserToolContext> | undefined
  if (!ctx || typeof ctx.sessionKey !== 'string' || typeof ctx.cwd !== 'string') return null
  const origin = ctx.origin === 'extension' ? 'extension' : 'model'
  return { name: v.name, input, ctx: { sessionKey: ctx.sessionKey, cwd: ctx.cwd, origin } }
}

/** Subscribe to the broker. Returns the unsubscribe. `broker` is injectable for tests. */
export function installBrowserToolCommandHandler(broker: BrokerLike = liveBroker): () => void {
  const off = broker.onFrame((environmentId, frame) => {
    if (frame.type !== 'studio_command' || frame.command !== BROWSER_TOOL_COMMAND) return
    if (environmentId !== LOCAL_ENVIRONMENT_ID) {
      warn('browser tool command from a non-local environment refused', { environment_id: environmentId, id: frame.id })
      broker.send(environmentId, { type: 'studio_command_result', id: frame.id, ok: false, error: 'browser tools run only against the local Environment' })
      return
    }
    const reply = (result: BrowserToolResult): void => {
      broker.send(environmentId, { type: 'studio_command_result', id: frame.id, ok: true, value: result })
    }
    const parsed = parseArgs(frame.args)
    if (!parsed) {
      warn('browser tool command rejected as malformed', { id: frame.id })
      broker.send(environmentId, { type: 'studio_command_result', id: frame.id, ok: false, error: 'malformed browser.tool command' })
      return
    }
    const body = studioBrowserToolBody(parsed.name)
    if (!body) {
      warn('browser tool command names a tool this desktop has no body for', { id: frame.id, tool: parsed.name })
      reply(fail(`browser tool ${parsed.name} is not available in this desktop`))
      return
    }
    const started = Date.now()
    log('browser tool command received', { id: frame.id, tool: parsed.name, session_key: parsed.ctx.sessionKey, origin: parsed.ctx.origin })
    void body.execute(parsed.input, parsed.ctx)
      .then((result) => {
        reply(result)
        log('browser tool command answered', { id: frame.id, tool: parsed.name, is_error: result.isError, latency_ms: Date.now() - started })
      })
      .catch((err: unknown) => {
        // The server is waiting; a thrown body still owes a model-readable answer.
        warn('browser tool body threw', { id: frame.id, tool: parsed.name, error: String(err) })
        reply(fail(`browser tool ${parsed.name} failed: ${String(err)}`))
      })
  })
  log('browser tool command handler installed')
  return off
}
