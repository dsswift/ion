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
 */
import { log as _log } from '../logger'
import type { BrowserToolContext, BrowserToolResult, StudioBrowserTool } from './tool-contracts'
import { BOOL, ENUM, INT, STRING, fail, intArg, ok, schema, stringArg } from './tool-contracts'
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

export const navigationTools: StudioBrowserTool[] = [
  {
    name: 'browser_navigate',
    description: 'Navigate the conversation browser tab to a URL. Opens the tab when none exists yet.',
    inputSchema: schema({ url: STRING('Absolute http(s) URL to open', 8192) }, ['url']),
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
          _log(TAG, 'browser navigated', { conversation_id: resolved.conversationId, instance_id: resolved.instanceId, host: hostOf(safe) })
          return ok(formatResponse({ code: `await page.goto(${JSON.stringify(safe)});`, page: await pageSummary(resolved.page) }))
        } catch (err) {
          return fail(formatError('browser_navigate', err))
        }
      })
    },
  },
  {
    name: 'browser_navigate_back',
    description: 'Go back one entry in the conversation browser history.',
    inputSchema: schema({}),
    execute: (input, ctx) => historyStep(ctx, 'back'),
  },
  {
    name: 'browser_navigate_forward',
    description: 'Go forward one entry in the conversation browser history.',
    inputSchema: schema({}),
    execute: (input, ctx) => historyStep(ctx, 'forward'),
  },
  {
    name: 'browser_reload',
    description: 'Reload the current page in the conversation browser tab.',
    inputSchema: schema({}),
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
    description: 'Close the conversation browser tab. A later browser call opens a fresh one.',
    inputSchema: schema({}),
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
    description: 'Resize the conversation browser viewport to an exact CSS pixel size.',
    inputSchema: schema({
      width: INT('Viewport width in CSS pixels', 1, 8192),
      height: INT('Viewport height in CSS pixels', 1, 8192),
    }, ['width', 'height']),
    execute: async (input, ctx) => {
      const width = intArg(input, 'width')
      const height = intArg(input, 'height')
      if (width === null || height === null) return fail('width and height are required integers in CSS pixels')
      return applyEmulationRequest(ctx, { width, height }, `await page.setViewportSize({ width: ${width}, height: ${height} });`)
    },
  },
  {
    name: 'browser_emulate',
    description: 'Emulate a device or specific viewport, scale factor, touch, user agent, locale, timezone, media preferences, geolocation, or offline state. Pass reset to restore the responsive view.',
    inputSchema: schema({
      device: STRING('Playwright device name, for example "iPhone 15" or "Pixel 7"', 128),
      width: INT('Viewport width in CSS pixels', 1, 8192),
      height: INT('Viewport height in CSS pixels', 1, 8192),
      screenWidth: INT('Screen width in CSS pixels', 1, 8192),
      screenHeight: INT('Screen height in CSS pixels', 1, 8192),
      deviceScaleFactor: { type: 'number', description: 'Device pixel ratio', minimum: 0.1, maximum: 5 },
      isMobile: BOOL('Enable mobile mode, which applies the meta viewport'),
      hasTouch: BOOL('Enable touch events'),
      userAgent: STRING('User agent override', 512),
      locale: STRING('Locale such as en-GB', 35),
      timezoneId: STRING('IANA timezone such as Europe/London', 64),
      orientation: ENUM('Screen orientation', ['portrait', 'landscape']),
      colorScheme: ENUM('prefers-color-scheme', ['light', 'dark', 'no-preference']),
      reducedMotion: ENUM('prefers-reduced-motion', ['reduce', 'no-preference']),
      forcedColors: ENUM('forced-colors', ['active', 'none']),
      geolocation: schema({
        latitude: { type: 'number', minimum: -90, maximum: 90 },
        longitude: { type: 'number', minimum: -180, maximum: 180 },
        accuracy: { type: 'number', minimum: 0 },
      }, ['latitude', 'longitude']),
      offline: BOOL('Emulate an offline network'),
      javaScriptEnabled: BOOL('Set false to disable page JavaScript'),
      reset: BOOL('Clear every override and restore the responsive view'),
    }),
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
