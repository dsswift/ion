/**
 * Diagnostics and tab-status tools.
 *
 * `browser_network_request` inspects a RECORDED request. The previous
 * implementation issued a fresh `fetch()` for the URL, which was not
 * inspection at all: it produced a different request, with different headers
 * and timing, and could re-trigger a side effect the page had already caused.
 * Reading the ledger is the only honest answer to "what did that request do".
 */
import type { BrowserToolContext, BrowserToolResult, StudioBrowserTool } from './tool-contracts'
import { BOOL, ENUM, INT, STRING, fail, filenameArg, intArg, ok, schema } from './tool-contracts'
import { fileLink, formatResponse } from './responses'
import { resolveBrowser, runExclusive } from './runtime'
import { emulationSession } from './emulation'
import {
  collectConsole,
  compileFilter,
  filterNetwork,
  formatConsole,
  formatNetworkDetail,
  formatNetworkList,
  type ConsoleLevel,
  type NetworkPart,
} from './diagnostics'
import { collectNetwork } from './diagnostics'
import { writeFile } from 'node:fs/promises'
import { isArtifactError, resolveArtifactPath } from './artifacts'

const LEVELS: ConsoleLevel[] = ['error', 'warning', 'info', 'debug']
const PARTS: NetworkPart[] = ['request-headers', 'request-body', 'response-headers', 'response-body']

export const diagnosticTools: StudioBrowserTool[] = [
  {
    name: 'browser_console_messages',
    description: 'Return console messages and uncaught page errors from the conversation browser tab.',
    inputSchema: schema({
      level: ENUM('Minimum severity to return. Each level includes the more severe ones.', LEVELS),
      all: BOOL('Return the whole session history instead of only the current navigation'),
      filename: STRING('Write the output to this conversation-relative file', 1024),
    }),
    planModeSafe: true,
    execute: async (input, ctx) => {
      const level: ConsoleLevel = LEVELS.includes(input.level as ConsoleLevel) ? (input.level as ConsoleLevel) : 'info'
      const all = input.all === true
      const resolved = await resolveBrowser(ctx.sessionKey, { create: false })
      if ('error' in resolved) return fail(resolved.error)
      return runExclusive(resolved.instanceId, 'console_messages', async () => {
        const collected = await collectConsole(resolved.page, level, all)
        const body = formatConsole(collected, level)
        return deliver(ctx, input, body, { kind: 'console', extension: 'txt' }, (text) => ({ console: text }))
      })
    },
  },
  {
    name: 'browser_network_requests',
    description: 'List network requests recorded for the conversation browser tab.',
    inputSchema: schema({
      static: BOOL('Include successful static resources such as images, fonts, and scripts. Defaults to false.'),
      filter: STRING('Only include requests whose URL matches this regular expression', 512),
      all: BOOL('Return the whole session history instead of only the current navigation'),
      filename: STRING('Write the output to this conversation-relative file', 1024),
    }),
    planModeSafe: true,
    execute: async (input, ctx) => {
      const compiled = compileFilter(input.filter)
      if (compiled.error) return fail(compiled.error)
      const resolved = await resolveBrowser(ctx.sessionKey, { create: false })
      if ('error' in resolved) return fail(resolved.error)
      return runExclusive(resolved.instanceId, 'network_requests', async () => {
        const view = collectNetwork(resolved.page, input.all === true)
        const includeStatic = input.static === true
        const shown = filterNetwork(view.entries, includeStatic, compiled.pattern)
        const lines: string[] = []
        if (view.partial) {
          // Saying the recorder started late is important: an empty list would
          // otherwise read as "the page made no requests".
          lines.push('Recording started after this page was already open, so earlier requests are not listed.')
        }
        if (view.dropped > 0) lines.push(`${view.dropped} older request(s) were dropped by the retention cap.`)
        lines.push(formatNetworkList(shown, view.entries.length, includeStatic))
        return deliver(ctx, input, lines.join('\n'), { kind: 'network', extension: 'txt' }, (text) => ({ network: text }))
      })
    },
  },
  {
    name: 'browser_network_request',
    description: 'Show one recorded network request in full, or just one part of it. Never issues a new request.',
    inputSchema: schema({
      index: INT('1-based index from browser_network_requests', 1),
      part: ENUM('Return only this part', PARTS),
      filename: STRING('Write the output to this conversation-relative file', 1024),
    }, ['index']),
    planModeSafe: true,
    execute: async (input, ctx) => {
      const index = intArg(input, 'index')
      if (index === null || index < 1) return fail('index is required and must be a 1-based integer from browser_network_requests')
      const part = PARTS.includes(input.part as NetworkPart) ? (input.part as NetworkPart) : null
      const resolved = await resolveBrowser(ctx.sessionKey, { create: false })
      if ('error' in resolved) return fail(resolved.error)
      return runExclusive(resolved.instanceId, 'network_request', async () => {
        // Lifetime history is searched so an index stays valid after a
        // navigation; the list default is narrower, but the detail view should
        // not fail for an entry the agent legitimately read a moment ago.
        const view = collectNetwork(resolved.page, true)
        const entry = view.entries.find((candidate) => candidate.index === index)
        if (!entry) {
          const available = view.entries.length > 0
            ? `Recorded indices run from ${view.entries[0]!.index} to ${view.entries[view.entries.length - 1]!.index}.`
            : 'No requests are recorded for this page yet.'
          return fail(`no recorded request with index ${index}. ${available}`)
        }
        const body = await formatNetworkDetail(entry, part)
        return deliver(ctx, input, body, { kind: 'network-request', extension: 'txt' }, (text) => ({ result: text }))
      })
    },
  },
  {
    name: 'browser_network_state_set',
    description: 'Take the conversation browser tab offline or back online.',
    inputSchema: schema({ state: ENUM('Network state', ['online', 'offline']) }, ['state']),
    execute: async (input, ctx) => {
      const state = input.state === 'offline' ? 'offline' : input.state === 'online' ? 'online' : null
      if (!state) return fail('state must be "online" or "offline"')
      const resolved = await resolveBrowser(ctx.sessionKey, { create: false })
      if ('error' in resolved) return fail(resolved.error)
      return runExclusive(resolved.instanceId, 'network_state', async () => {
        // The SHARED session, not a fresh one: a CDP network override is owned
        // by the session that set it, so detaching would put the tab straight
        // back online. Same reason emulation holds its session.
        const session = await emulationSession(resolved.page)
        try {
          await session.send('Network.emulateNetworkConditions', {
            offline: state === 'offline',
            latency: 0,
            downloadThroughput: -1,
            uploadThroughput: -1,
          })
          return ok(formatResponse({ code: `// network ${state}`, result: `The browser tab is now ${state}.` }))
        } catch (err) {
          return fail(`could not change the network state: ${String(err)}`)
        }
      })
    },
  },
  {
    name: 'browser_tabs',
    description: 'Inspect or act on the one browser tab linked to this conversation.',
    inputSchema: schema({
      action: ENUM('Operation to perform', ['list', 'new', 'select', 'close', 'set_session_mode']),
      url: STRING('URL to open when action is new', 8192),
      sessionMode: ENUM('Browser session for set_session_mode', ['shared', 'isolated']),
    }, ['action']),
    execute: async (input, ctx) => tabsAction(input, ctx),
  },
]

/** Shared inline-or-file delivery for diagnostic output. */
async function deliver(
  ctx: BrowserToolContext,
  input: Record<string, unknown>,
  body: string,
  fallback: { kind: string; extension: string },
  section: (text: string) => Parameters<typeof formatResponse>[0],
): Promise<BrowserToolResult> {
  const filename = filenameArg(input)
  if (!filename) return ok(formatResponse(section(body)))
  const path = await resolveArtifactPath(ctx.cwd, filename, fallback)
  if (isArtifactError(path)) return fail(path.error)
  await writeFile(path.absolute, body, 'utf8')
  return ok(formatResponse({ result: fileLink(path.relative) }))
}

async function tabsAction(input: Record<string, unknown>, ctx: BrowserToolContext): Promise<BrowserToolResult> {
  const action = input.action
  if (action === 'select') {
    // The link is the operator's to move. A model that could reassign it could
    // walk onto any page the operator had prepared for themselves, which is
    // exactly what the single-link rule exists to prevent.
    if (ctx.origin === 'model') {
      return fail('browser_tabs select is not available: this conversation has one agent-linked browser tab, and only the operator can move that link in the Studio tab strip.')
    }
    return fail('browser_tabs select is not supported; the linked tab is already the active target.')
  }

  if (action === 'list') {
    const resolved = await resolveBrowser(ctx.sessionKey, { create: false })
    if ('error' in resolved) return ok(formatResponse({ result: resolved.error }))
    const tab = resolved.tab
    const emulation = tab.emulation
      ? `${emulationLabel(tab)} viewport ${tab.emulation.width}x${tab.emulation.height}`
      : 'responsive viewport'
    return ok(formatResponse({
      result: [
        '1. (agent-linked, selected)',
        `   URL: ${tab.url}`,
        `   Title: ${tab.title}`,
        `   Session: ${tab.sessionMode}`,
        `   Viewport: ${emulation}`,
      ].join('\n'),
    }))
  }

  if (action === 'new') {
    const url = typeof input.url === 'string' && input.url.trim() ? input.url.trim() : undefined
    const resolved = await resolveBrowser(ctx.sessionKey, { create: true, ...(url ? { url } : {}) })
    if ('error' in resolved) return fail(resolved.error)
    return ok(formatResponse({
      result: `This conversation has one agent-linked browser tab; it is now focused${url ? ` on ${url}` : ''}. Open more tabs from the Studio tab strip if you need side-by-side pages.`,
      page: { url: resolved.tab.url, title: resolved.tab.title },
    }))
  }

  if (action === 'close') {
    const resolved = await resolveBrowser(ctx.sessionKey, { create: false })
    if ('error' in resolved) return fail(resolved.error)
    const { closeLinkedBrowser } = await import('./runtime')
    const closed = await closeLinkedBrowser(resolved.conversationId)
    return closed
      ? ok(formatResponse({ result: 'Closed the agent-linked browser tab.' }))
      : fail('Studio did not confirm the browser tab closed.')
  }

  if (action === 'set_session_mode') {
    const mode = input.sessionMode === 'isolated' ? 'isolated' : input.sessionMode === 'shared' ? 'shared' : null
    if (!mode) return fail('sessionMode must be "shared" or "isolated"')
    const resolved = await resolveBrowser(ctx.sessionKey, { create: false })
    if ('error' in resolved) return fail(resolved.error)
    if (mode === 'shared' && resolved.tab.sessionMode === 'isolated' && ctx.origin === 'model') {
      // Escalating isolation is safe; removing it is not. An isolated tab was
      // isolated for a reason the model does not necessarily know.
      return fail('cannot move an isolated browser tab back to the shared session: an agent may increase isolation but never reduce it. Ask the operator to change it in Studio.')
    }
    return fail(`session mode changes are applied from the Studio browser chrome. The tab is currently ${resolved.tab.sessionMode}.`)
  }

  return fail('action must be one of list, new, select, close, or set_session_mode')
}

function emulationLabel(tab: { emulation: { device?: string } | null }): string {
  return tab.emulation?.device ? `${tab.emulation.device},` : 'emulated'
}
