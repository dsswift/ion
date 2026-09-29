/**
 * Browser tool contracts.
 *
 * Two rules shape every schema here.
 *
 * First, ownership is NOT model input. There is no `conversationId`, no
 * `instanceId`, and no tab selector in any schema: the tool-gate responder
 * supplies the authoritative session key, and the runtime resolves that
 * conversation's one Agent-linked tab. A model cannot reach the operator's
 * other browser tabs, and a call cannot be retargeted by the operator
 * switching conversations while it runs.
 *
 * Second, argument names match the published Playwright MCP surface. Agents
 * already generate `{element, target, doubleClick}` and `{level, all}`; keeping
 * those names means existing skill and prompt knowledge keeps working. Ion-only
 * additions (`browser_emulate`, `browser_scroll`, screenshot `clip`) are
 * additive, and the compatibility fixture in `testdata/` pins the overlap.
 */
import type { ClientToolDef } from '@ion/shared/types-tool-gate'

/** Execution context injected by the responder, never by the model. */
export interface BrowserToolContext {
  /** Engine session key — the authoritative conversation identity. */
  sessionKey: string
  /** Conversation working directory; the root every artifact path resolves in. */
  cwd: string
  /**
   * Who asked. Session-mode policy differs: a model may increase isolation but
   * never remove it, while trusted extension code may do both.
   */
  origin: 'model' | 'extension'
}

export interface BrowserToolResult {
  content: string
  isError: boolean
  images?: { media_type: string; data: string }[]
}

export interface StudioBrowserTool extends ClientToolDef {
  execute(input: Record<string, unknown>, ctx: BrowserToolContext): Promise<BrowserToolResult>
}

/**
 * The execution half of one browser tool, keyed by the declared name.
 *
 * Declarations (`tool-declarations.ts`, re-exported below) are what the server
 * advertises to the engine; bodies are what the desktop runs against its
 * Playwright-driven `BrowserView`. The server never sees a body: it sends a
 * `browser.tool` studio_command to the attached desktop and the desktop's
 * body answers it (`desktop/src/main/studio-playwright/command-handler.ts`).
 */
export interface StudioBrowserToolBody {
  name: string
  execute(input: Record<string, unknown>, ctx: BrowserToolContext): Promise<BrowserToolResult>
}

export { STUDIO_BROWSER_TOOL_DECLARATIONS, studioBrowserToolDeclaration } from './tool-declarations'

export function ok(content: string, images?: { media_type: string; data: string }[]): BrowserToolResult {
  return { content, isError: false, ...(images && images.length > 0 ? { images } : {}) }
}

export function fail(content: string): BrowserToolResult {
  return { content, isError: true }
}

export { schema, STRING, BOOL, INT, NUM, ENUM, TARGET_PROPS } from './tool-schema'

/** `selector` is accepted as an alias because Ion shipped it first. */
export function targetOf(input: Record<string, unknown>): string | null {
  const raw = input.target ?? input.selector ?? input.ref
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 && trimmed.length <= 1024 ? trimmed : null
}

export function stringArg(input: Record<string, unknown>, name: string, maxLength = 4096): string | null {
  const raw = input[name]
  if (typeof raw !== 'string') return null
  return raw.length > 0 && raw.length <= maxLength ? raw : null
}

export function boolArg(input: Record<string, unknown>, name: string): boolean | undefined {
  const raw = input[name]
  return typeof raw === 'boolean' ? raw : undefined
}

export function intArg(input: Record<string, unknown>, name: string): number | null {
  const raw = input[name]
  return typeof raw === 'number' && Number.isInteger(raw) ? raw : null
}

export function numArg(input: Record<string, unknown>, name: string): number | null {
  const raw = input[name]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

/**
 * Normalize an optional filename.
 *
 * Empty string is treated as absent because real agents send `filename: ""`
 * to mean "inline please" — rejecting it would fail a call that is trying to
 * do the ordinary thing.
 */
export function filenameArg(input: Record<string, unknown>): string | undefined {
  const raw = input.filename
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
