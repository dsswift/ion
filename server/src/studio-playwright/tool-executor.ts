/**
 * How the server runs a Studio browser tool it has advertised.
 *
 * The declarations are the server's (`tool-declarations.ts`); the bodies
 * drive a Playwright connection to an Electron `BrowserView` and live in the
 * desktop. So a browser tool call becomes one reverse `studio_command`,
 * `browser.tool`, carrying the tool name, the model's input and the
 * responder-supplied context, routed to the attached client that advertises
 * `browser` (`protocol/commands.ts`) and answered by the desktop's
 * `studio-playwright/command-handler.ts`.
 *
 * The executor is injected rather than imported, exactly like the graph and
 * browser command senders: `protocol/command-senders.ts` installs the wire-
 * backed one when the Studio listeners start, and tests install a fake. With
 * nothing installed, or no desktop attached, a call fails with the same
 * model-visible "Studio required" error the graph tools produce.
 */
import { STUDIO_BROWSER_TOOL_DECLARATIONS } from './tool-declarations'
import { fail, type BrowserToolContext, type BrowserToolResult, type StudioBrowserTool } from './tool-contracts'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'studio-playwright'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export const STUDIO_REQUIRED_ERROR =
  'The browser tools require the Ion Studio desktop. Open Ion Studio on the machine that runs this Environment and try again.'

/**
 * Bound on one tool call's round trip. Navigation waits up to 30 s in the
 * desktop body, so this sits above it and under the engine's client-tool
 * bound (`toolGateSessionConfig.clientToolTimeoutMs` is 30 s per session
 * default; a slow page answers with the body's own timeout error first).
 */
export const BROWSER_TOOL_COMMAND_TIMEOUT_MS = 45_000

export type BrowserToolExecutor = (name: string, input: Record<string, unknown>, ctx: BrowserToolContext) => Promise<BrowserToolResult>

let executor: BrowserToolExecutor | null = null

/** Install (or clear, with null) the live executor. */
export function setBrowserToolExecutor(next: BrowserToolExecutor | null): void {
  executor = next
}

export function browserToolExecutor(): BrowserToolExecutor | null {
  return executor
}

/** The wire shape of one `browser.tool` command's `args`. */
export interface BrowserToolCommandArgs {
  name: string
  input: Record<string, unknown>
  ctx: BrowserToolContext
}

/**
 * Every declared browser tool, executable through the installed executor.
 * Built once: the declaration list is static and the executor is read at
 * call time, so a desktop attaching later is picked up without rebuilding.
 */
export const STUDIO_BROWSER_TOOLS: StudioBrowserTool[] = STUDIO_BROWSER_TOOL_DECLARATIONS.map((decl) => ({
  ...decl,
  execute: async (input, ctx) => {
    const run = executor
    if (!run) {
      warn('browser tool called with no executor installed', { tool: decl.name, session_key: ctx.sessionKey })
      return fail(STUDIO_REQUIRED_ERROR)
    }
    const started = Date.now()
    try {
      const result = await run(decl.name, input, ctx)
      log('browser tool answered', { tool: decl.name, session_key: ctx.sessionKey, is_error: result.isError, latency_ms: Date.now() - started })
      return result
    } catch (err) {
      warn('browser tool failed', { tool: decl.name, session_key: ctx.sessionKey, error: String(err), latency_ms: Date.now() - started })
      return fail(STUDIO_REQUIRED_ERROR)
    }
  },
}))
