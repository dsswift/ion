/**
 * Navigation, viewport, and tab-lifecycle tools.
 *
 * `browser_resize` is the interesting one. The MCP server implements it as
 * `page.setViewportSize()`, which on a CDP-attached page moves Playwright's
 * view without moving the Electron `<webview>` the operator sees. Here it is a
 * device-metrics override plus a renderer frame resize, so the page's media
 * queries, the agent's screenshots, and the visible tab all agree on one
 * viewport. Anything less would let an agent report a passing mobile layout
 * while the operator watches a desktop one.
 *
 * Bodies only: each entry is `{ name, execute }`. The matching declarations
 * (description, input schema) live in the server package at
 * `server/src/studio-playwright/tool-declarations.ts` and are joined by name in
 * `./tools.ts`.
 */
import { log as _log } from '../logger'
import type { BrowserToolContext, BrowserToolResult, StudioBrowserToolBody } from '@ion/server/studio-playwright/tool-contracts'
import { fail, intArg, ok, stringArg } from '@ion/server/studio-playwright/tool-contracts'
import { formatError, formatResponse } from './responses'
import { applyEmulation, knownDevices, resolveEmulation } from './emulation'
import { closeLinkedBrowser, noteEmulationApplied, pushEmulationToRenderer, resolveBrowser, runExclusive } from './runtime'
import { isBrowserViewVisible } from '../studio-browser-views'
import { attachNetworkRecorder } from './network-recorder'
import { pageSummary } from './tools-shared'

const TAG = 'studio-playwright'
const NAV_TIMEOUT_MS = 30_000

/** Only http(s) and about:blank. Other schemes are refused, as in the webview policy. */
function safeUrl(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString()
    if (raw === 'about:blank') return raw
    return null
  } catch {
    return null
  }
}

export const navigationBodies: StudioBrowserToolBody[] = [
  {
    name: 'browser_navigate',
    execute: async (input, ctx) => {
      const url = stringArg(input, 'url', 8192)
      if (!url) return fail('url is required and must be an absolute http(s) URL')
      const safe = safeUrl(url)
      if (!safe) return fail(`refused to navigate to ${url}: only http, https, and about:blank are allowed`)
      const resolved = await resolveBrowser(ctx.sessionKey, { create: true, url: safe })
      if ('error' in resolved) return fail(resolved.error)
      return runExclusive(resolved.instanceId, 'navigate', async () => {
        try {
          attachNetworkRecorder(resolved.page)
          await resolved.page.goto(safe, { timeout: NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' })
          _log(TAG, 'browser navigated', { conversation_id: resolved.conversationId, instance_id: resolved.instanceId, url_host: hostOf(safe) })
          return ok(formatResponse({ code: `await page.goto(${JSON.stringify(safe)});`, page: await pageSummary(resolved.page) }))
        } catch (err) {
          return fail(formatError('browser_navigate', err))
        }
      })
    },
  },
  {
    name: 'browser_navigate_back',
    execute: (input, ctx) => historyStep(ctx, 'back'),
  },
  {
    name: 'browser_navigate_forward',
    execute: (input, ctx) => historyStep(ctx, 'forward'),
  },
  {
    name: 'browser_reload',
    execute: async (_input, ctx) => {
      const resolved = await resolveBrowser(ctx.sessionKey, { create: false })
      if ('error' in resolved) return fail(resolved.error)
      return runExclusive(resolved.instanceId, 'reload', async () => {
        try {
          await resolved.page.reload({ timeout: NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' })
          return ok(formatResponse({ code: 'await page.reload();', page: await pageSummary(resolved.page) }))
        } catch (err) {
          return fail(formatError('browser_reload', err))
        }
      })
    },
  },
  {
    name: 'browser_close',
    execute: async (_input, ctx) => {
      const resolved = await resolveBrowser(ctx.sessionKey, { create: false })
      if ('error' in resolved) return fail(resolved.error)
      // Closed through the renderer, not page.close(): the descriptor, tab
      // chrome, and persisted state are the renderer's, and closing the page
      // behind its back would leave a tab pill for a dead guest.
      const closed = await closeLinkedBrowser(resolved.conversationId)
      return closed
        ? ok(formatResponse({ code: 'await page.close();', result: 'Browser tab closed.' }))
        : fail('Studio did not confirm the browser tab closed.')
    },
  },
  {
    name: 'browser_resize',
    execute: async (input, ctx) => {
      const width = intArg(input, 'width')
      const height = intArg(input, 'height')
      if (width === null || height === null) return fail('width and height are required integers in CSS pixels')
      return applyEmulationRequest(ctx, { width, height }, `await page.setViewportSize({ width: ${width}, height: ${height} });`)
    },
  },
  {
    name: 'browser_emulate',
    execute: async (input, ctx) => {
      const code = input.reset === true
        ? '// cleared all emulation overrides'
        : `// applied emulation ${JSON.stringify(input)}`
      return applyEmulationRequest(ctx, input, code)
    },
  },
]

async function historyStep(ctx: BrowserToolContext, direction: 'back' | 'forward'): Promise<BrowserToolResult> {
  const resolved = await resolveBrowser(ctx.sessionKey, { create: false })
  if ('error' in resolved) return fail(resolved.error)
  return runExclusive(resolved.instanceId, `navigate_${direction}`, async () => {
    try {
      const response = direction === 'back'
        ? await resolved.page.goBack({ timeout: NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' })
        : await resolved.page.goForward({ timeout: NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' })
      return ok(formatResponse({
        code: `await page.go${direction === 'back' ? 'Back' : 'Forward'}();`,
        result: response ? `Moved ${direction} in history.` : `No ${direction} history entry; the page did not change.`,
        page: await pageSummary(resolved.page),
      }))
    } catch (err) {
      return fail(formatError(`browser_navigate_${direction}`, err))
    }
  })
}

/** Shared path for resize and emulate: resolve, apply to the guest, tell the renderer. */
async function applyEmulationRequest(
  ctx: BrowserToolContext,
  request: Record<string, unknown>,
  code: string,
): Promise<BrowserToolResult> {
  const resolved = await resolveBrowser(ctx.sessionKey, { create: true })
  if ('error' in resolved) return fail(resolved.error)
  return runExclusive(resolved.instanceId, 'emulate', async () => {
    const outcome = resolveEmulation(resolved.tab.emulation, request)
    if (outcome.error) {
      const hint = request.device !== undefined ? `\n\nAvailable devices include: ${knownDevices().slice(0, 12).join(', ')}.` : ''
      return fail(`${outcome.error}${hint}`)
    }
    try {
      // Hidden guests take mobile:false so the requested viewport is exact;
      // see applyEmulation's `displayed` parameter.
      await applyEmulation(resolved.page, outcome.state, isBrowserViewVisible(resolved.conversationId, resolved.instanceId))
      noteEmulationApplied(resolved.instanceId, outcome.state)
      // The renderer owns the descriptor and the visible frame, so it is told
      // separately; without this the page would be a phone inside a
      // desktop-width frame.
      await pushEmulationToRenderer(resolved.conversationId, resolved.instanceId, outcome.state)
      const summary = outcome.state
        ? `Viewport is now ${outcome.state.width}x${outcome.state.height}${outcome.state.device ? ` (${outcome.state.device})` : ''}.`
        : 'Emulation cleared; the tab is responsive again.'
      return ok(formatResponse({
        code,
        result: summary,
        ...(outcome.engineNotice ? { notice: outcome.engineNotice } : {}),
        page: await pageSummary(resolved.page),
      }))
    } catch (err) {
      return fail(formatError('browser_emulate', err))
    }
  })
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).host
  } catch {
    return ''
  }
}
