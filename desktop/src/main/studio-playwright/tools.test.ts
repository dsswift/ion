import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * These tests exercise the tools through their public seam: a mocked
 * Playwright `Page` plus a mocked renderer command sender. That is deliberate.
 * The rules worth protecting here are behavioural — ownership resolution,
 * origin policy, serialization, path containment, output shape — and pinning
 * them at the seam keeps the tests meaningful when the internals move.
 */

const commandSender = vi.hoisted(() => vi.fn())
const page = vi.hoisted(() => {
  const locator = {
    count: vi.fn(async () => 1),
    first: vi.fn(),
    click: vi.fn(async () => undefined),
    dblclick: vi.fn(async () => undefined),
    hover: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    pressSequentially: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    check: vi.fn(async () => undefined),
    uncheck: vi.fn(async () => undefined),
    selectOption: vi.fn(async () => ['ok']),
    screenshot: vi.fn(async () => Buffer.from('element-png')),
    ariaSnapshot: vi.fn(async () => '- button "Save" [ref=e7]\n- link "Docs" [ref=e8]'),
    scrollIntoViewIfNeeded: vi.fn(async () => undefined),
    boundingBox: vi.fn(async () => ({ x: 4, y: 8, width: 100, height: 20 })),
    evaluate: vi.fn(async () => undefined),
    waitFor: vi.fn(async () => undefined),
    dragTo: vi.fn(async () => undefined),
  }
  locator.first.mockReturnValue(locator)
  return {
    locatorObject: locator,
    url: vi.fn(() => 'https://example.test/app'),
    title: vi.fn(async () => 'Example App'),
    locator: vi.fn(() => locator),
    goto: vi.fn(async () => null),
    reload: vi.fn(async () => null),
    goBack: vi.fn(async () => ({})),
    goForward: vi.fn(async () => null),
    screenshot: vi.fn(async () => Buffer.from('page-png')),
    keyboard: { press: vi.fn(async () => undefined) },
    mouse: { wheel: vi.fn(async () => undefined) },
    evaluate: vi.fn(async (): Promise<unknown> => ({ scrollX: 0, scrollY: 240, innerWidth: 390, innerHeight: 844 })),
    consoleMessages: vi.fn(async () => []),
    pageErrors: vi.fn(async () => []),
    waitForTimeout: vi.fn(async () => undefined),
    getByText: vi.fn(() => locator),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    isClosed: vi.fn(() => false),
    context: vi.fn(),
  }
})

vi.mock('playwright-core', () => ({
  devices: {
    'iPhone 15': {
      userAgent: 'Mozilla/5.0 (iPhone)',
      viewport: { width: 393, height: 852 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      defaultBrowserType: 'webkit',
    },
    'Pixel 7': {
      userAgent: 'Mozilla/5.0 (Android)',
      viewport: { width: 412, height: 915 },
      deviceScaleFactor: 2.625,
      isMobile: true,
      hasTouch: true,
      defaultBrowserType: 'chromium',
    },
  },
  chromium: { connectOverCDP: vi.fn() },
}))
vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('./connection', () => ({ pageForTarget: vi.fn(async () => page), sharedBrowser: vi.fn() }))
vi.mock('./host', () => ({
  readDevToolsEndpoint: vi.fn(async () => 'http://127.0.0.1:9222'),
  studioPlaywrightHost: { resolve: vi.fn(() => ({ conversationId: 'tab-1', instanceId: 'browser-1', cdpTargetId: 'target-1', webContents: {} })) },
}))
vi.mock('../studio-browser-views', () => ({
  ensureBrowserView: vi.fn(() => ({ id: 1 })),
  isBrowserViewVisible: vi.fn(() => false),
}))
vi.mock('./renderer-bridge', () => ({ browserCommandSender: () => commandSender, setBrowserCommandSender: vi.fn() }))

import { STUDIO_PLAYWRIGHT_TOOLS, studioBrowserTool } from './tools'
import { resetRuntimeForTests } from './runtime'
import type { BrowserToolContext } from './tool-contracts'

const MODEL: BrowserToolContext = { sessionKey: 'tab-1', cwd: '/tmp', origin: 'model' }

function tool(name: string) {
  const found = studioBrowserTool(name)
  if (!found) throw new Error(`missing tool ${name}`)
  return found
}

function linkedTab(overrides: Record<string, unknown> = {}) {
  return {
    instanceId: 'browser-1',
    url: 'https://example.test/app',
    title: 'Example App',
    mode: 'browse',
    sessionMode: 'shared',
    agentLinked: true,
    emulation: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // The runtime caches the emulation it last applied per instance, so without
  // this a later test's emulate call is deduped away and silently asserts
  // nothing.
  resetRuntimeForTests()
  page.locator.mockReturnValue(page.locatorObject)
  page.locatorObject.count.mockResolvedValue(1)
  page.locatorObject.first.mockReturnValue(page.locatorObject)
  page.url.mockReturnValue('https://example.test/app')
  page.title.mockResolvedValue('Example App')
  page.context.mockReturnValue({
    newCDPSession: vi.fn(async () => ({ send: vi.fn(async () => ({})), detach: vi.fn(async () => undefined) })),
  })
  commandSender.mockResolvedValue({ callId: 'c1', ok: true, tab: linkedTab() })
})

describe('tool surface', () => {
  it('advertises no ownership arguments on any tool', () => {
    // Ownership is injected by the responder. A schema that accepted a
    // conversation or tab id would let a model address another conversation's
    // browser, which is the whole thing the single-link rule prevents.
    for (const candidate of STUDIO_PLAYWRIGHT_TOOLS) {
      const props = Object.keys(((candidate.inputSchema as { properties?: object }).properties ?? {}))
      expect(props).not.toContain('conversationId')
      expect(props).not.toContain('instanceId')
      expect(props).not.toContain('webviewId')
    }
  })

  it('does not expose a main-process code execution tool', () => {
    // Upstream browser_run_code_unsafe evaluates JavaScript in the Playwright
    // server process, which here is the desktop main process.
    expect(studioBrowserTool('browser_run_code_unsafe')).toBeUndefined()
  })

  it('marks read-only diagnostics plan-mode safe', () => {
    expect(tool('browser_snapshot').planModeSafe).toBe(true)
    expect(tool('browser_console_messages').planModeSafe).toBe(true)
    expect(tool('browser_click').planModeSafe).not.toBe(true)
  })
})

describe('ownership', () => {
  it('refuses every call when Studio is not available', async () => {
    commandSender.mockResolvedValue({ callId: 'c1', ok: false, error: 'no studio window' })
    const result = await tool('browser_navigate').execute({ url: 'https://example.test' }, MODEL)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('no studio window')
  })

  it('asks the renderer for the linked tab of the calling conversation', async () => {
    await tool('browser_navigate').execute({ url: 'https://example.test/next' }, { ...MODEL, sessionKey: 'tab-9' })
    expect(commandSender).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'ensure', conversationId: 'tab-9' }),
      expect.any(Number),
    )
  })

  it('reports no browser rather than creating one for a status read', async () => {
    commandSender.mockResolvedValue({ callId: 'c1', ok: false, error: 'This conversation has no browser tab yet.' })
    const result = await tool('browser_console_messages').execute({}, MODEL)
    expect(commandSender).toHaveBeenCalledWith(expect.objectContaining({ kind: 'status' }), expect.any(Number))
    expect(result.isError).toBe(true)
  })
})

describe('navigation', () => {
  it('navigates and reports the resulting page', async () => {
    const result = await tool('browser_navigate').execute({ url: 'https://example.test/next' }, MODEL)
    expect(page.goto).toHaveBeenCalledWith('https://example.test/next', expect.objectContaining({ waitUntil: 'domcontentloaded' }))
    expect(result.isError).toBe(false)
    expect(result.content).toContain('### Ran Playwright code')
    expect(result.content).toContain('### Page')
    expect(result.content).toContain('https://example.test/app')
  })

  it('refuses a non-http scheme', async () => {
    const result = await tool('browser_navigate').execute({ url: 'file:///etc/passwd' }, MODEL)
    expect(result.isError).toBe(true)
    expect(page.goto).not.toHaveBeenCalled()
  })

  it('says so when there is no history entry to return to', async () => {
    page.goForward.mockResolvedValue(null)
    const result = await tool('browser_navigate_forward').execute({}, MODEL)
    expect(result.content).toContain('No forward history entry')
  })
})

describe('viewport and emulation', () => {
  it('resizes the real guest and tells the renderer to match', async () => {
    const result = await tool('browser_resize').execute({ width: 390, height: 844 }, MODEL)
    expect(result.isError).toBe(false)
    expect(result.content).toContain('390x844')
    // Both halves matter: CDP moves the page, the renderer moves the frame.
    expect(commandSender).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'emulate', emulation: expect.objectContaining({ width: 390, height: 844 }) }),
      expect.any(Number),
    )
  })

  it('applies a device preset with its viewport, touch, and scale factor', async () => {
    const result = await tool('browser_emulate').execute({ device: 'Pixel 7' }, MODEL)
    expect(result.isError).toBe(false)
    expect(commandSender).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'emulate',
        emulation: expect.objectContaining({ device: 'Pixel 7', width: 412, height: 915, deviceScaleFactor: 2.625, hasTouch: true }),
      }),
      expect.any(Number),
    )
  })

  it('says a non-Chromium preset is device emulation, not engine parity', async () => {
    const result = await tool('browser_emulate').execute({ device: 'iPhone 15' }, MODEL)
    expect(result.content).toContain('emulated on Chromium')
    expect(result.content).toContain('not webkit')
  })

  it('rejects an unknown device and names real ones', async () => {
    const result = await tool('browser_emulate').execute({ device: 'iPhone 99 Ultra' }, MODEL)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('unknown device')
    expect(result.content).toContain('iPhone 15')
  })

  it('preserves other emulation fields when only resizing', async () => {
    commandSender.mockResolvedValue({
      callId: 'c1',
      ok: true,
      tab: linkedTab({ emulation: { device: 'Pixel 7', width: 412, height: 915, hasTouch: true, isMobile: true } }),
    })
    await tool('browser_resize').execute({ width: 500, height: 900 }, MODEL)
    const emulation = commandSender.mock.calls.map((call) => call[0]).find((cmd) => cmd.kind === 'emulate')?.emulation
    // Touch survives a resize; the device LABEL does not, because a 500px
    // viewport is no longer that phone and saying otherwise would misreport
    // what was tested.
    expect(emulation).toMatchObject({ width: 500, height: 900, hasTouch: true, isMobile: true })
    expect(emulation).not.toHaveProperty('device')
  })

  it('clears every override on reset', async () => {
    const result = await tool('browser_emulate').execute({ reset: true }, MODEL)
    expect(result.content).toContain('responsive again')
    expect(commandSender).toHaveBeenCalledWith(expect.objectContaining({ kind: 'emulate', emulation: null }), expect.any(Number))
  })
})

describe('interaction', () => {
  it('clicks a snapshot ref through the aria-ref engine', async () => {
    const result = await tool('browser_click').execute({ element: 'Save button', target: 'e7' }, MODEL)
    expect(page.locator).toHaveBeenCalledWith('aria-ref=e7')
    expect(page.locatorObject.click).toHaveBeenCalled()
    expect(result.content).toContain('### Snapshot')
  })

  it('refuses an ambiguous target instead of clicking the first match', async () => {
    page.locatorObject.count.mockResolvedValue(4)
    const result = await tool('browser_click').execute({ target: '.row button' }, MODEL)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('4 elements matched')
    expect(page.locatorObject.click).not.toHaveBeenCalled()
  })

  it('types slowly only when asked', async () => {
    await tool('browser_type').execute({ target: '#q', text: 'ion' }, MODEL)
    expect(page.locatorObject.fill).toHaveBeenCalledWith('ion', expect.anything())

    await tool('browser_type').execute({ target: '#q', text: 'ion', slowly: true }, MODEL)
    expect(page.locatorObject.pressSequentially).toHaveBeenCalledWith('ion', expect.anything())
  })

  it('submits after typing when requested', async () => {
    await tool('browser_type').execute({ target: '#q', text: 'ion', submit: true }, MODEL)
    expect(page.locatorObject.press).toHaveBeenCalledWith('Enter', expect.anything())
  })

  it('accepts the legacy selector alias', async () => {
    await tool('browser_click').execute({ selector: '#go' }, MODEL)
    expect(page.locator).toHaveBeenCalledWith('#go')
  })

  it('reports which form fields were applied before a failure', async () => {
    page.locatorObject.fill.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('detached'))
    const result = await tool('browser_fill_form').execute({
      fields: [
        { name: 'Email', type: 'textbox', target: '#email', value: 'dev@example.com' },
        { name: 'Name', type: 'textbox', target: '#name', value: 'Ion' },
      ],
    }, MODEL)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Fields applied before the failure')
    expect(result.content).toContain('Email')
  })
})

describe('scrolling', () => {
  it('scrolls by a wheel delta and reports the new position', async () => {
    const result = await tool('browser_scroll').execute({ deltaY: 400 }, MODEL)
    expect(page.mouse.wheel).toHaveBeenCalledWith(0, 400)
    expect(result.content).toContain('Scroll position: 0, 240')
    expect(result.content).toContain('Viewport: 390x844')
  })

  it('scrolls an element into view and reports its box', async () => {
    const result = await tool('browser_scroll').execute({ target: 'e8', block: 'center' }, MODEL)
    expect(page.locatorObject.scrollIntoViewIfNeeded).toHaveBeenCalled()
    expect(result.content).toContain('Target box')
  })

  it('refuses more than one scroll mode in a call', async () => {
    const result = await tool('browser_scroll').execute({ deltaY: 100, y: 500 }, MODEL)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('exactly one scroll mode')
  })

  it('routes the compatibility wheel tool to relative scrolling', async () => {
    await tool('browser_mouse_wheel').execute({ deltaX: 0, deltaY: 120 }, MODEL)
    expect(page.mouse.wheel).toHaveBeenCalledWith(0, 120)
  })
})

describe('screenshots', () => {
  it('returns an inline image with page metadata', async () => {
    const result = await tool('browser_take_screenshot').execute({}, MODEL)
    expect(result.isError).toBe(false)
    expect(result.images).toEqual([{ media_type: 'image/png', data: Buffer.from('page-png').toString('base64') }])
  })

  it('captures one element when given a target', async () => {
    const result = await tool('browser_take_screenshot').execute({ target: 'e7' }, MODEL)
    expect(page.locatorObject.screenshot).toHaveBeenCalled()
    expect(result.images?.[0]?.data).toBe(Buffer.from('element-png').toString('base64'))
  })

  it('passes a clip region through', async () => {
    await tool('browser_take_screenshot').execute({ clip: { x: 0, y: 0, width: 100, height: 50 } }, MODEL)
    expect(page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ clip: { x: 0, y: 0, width: 100, height: 50 } }))
  })

  it('refuses combinations Chromium cannot satisfy', async () => {
    const withElement = await tool('browser_take_screenshot').execute({ fullPage: true, target: 'e7' }, MODEL)
    expect(withElement.isError).toBe(true)
    const withClip = await tool('browser_take_screenshot').execute({ fullPage: true, clip: { x: 0, y: 0, width: 1, height: 1 } }, MODEL)
    expect(withClip.isError).toBe(true)
  })

  it('infers jpeg from the filename and writes inside the conversation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ion-browser-'))
    const result = await tool('browser_take_screenshot').execute({ filename: 'shots/home.jpeg' }, { ...MODEL, cwd })
    expect(page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ type: 'jpeg' }))
    expect(result.content).toContain('shots/home.jpeg')
    expect(result.images).toBeUndefined()
    await expect(readFile(join(cwd, 'shots/home.jpeg'))).resolves.toBeInstanceOf(Buffer)
  })

  it('refuses a filename that escapes the conversation directory', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ion-browser-'))
    const result = await tool('browser_take_screenshot').execute({ filename: '../escape.png' }, { ...MODEL, cwd })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('traverse outside')
  })
})

describe('snapshot and find', () => {
  it('requests an AI snapshot with refs', async () => {
    const result = await tool('browser_snapshot').execute({ depth: 4, boxes: true }, MODEL)
    expect(page.locatorObject.ariaSnapshot).toHaveBeenCalledWith(expect.objectContaining({ mode: 'ai', depth: 4, boxes: true }))
    expect(result.content).toContain('[ref=e7]')
  })

  it('finds nodes by regular expression with flags', async () => {
    const result = await tool('browser_find').execute({ regex: '/docs/i' }, MODEL)
    expect(result.isError).toBe(false)
    expect(result.content).toContain('Docs')
  })

  it('requires exactly one of text or regex', async () => {
    expect((await tool('browser_find').execute({}, MODEL)).isError).toBe(true)
    expect((await tool('browser_find').execute({ text: 'a', regex: 'b' }, MODEL)).isError).toBe(true)
  })

  it('wraps a function without referencing `arguments`', async () => {
    // Playwright evaluates the wrapper inside an arrow function, where
    // `arguments` is not defined. The original wrapper used it, so EVERY
    // browser_evaluate call that passed a function threw
    // "arguments is not defined" against the real app while passing here.
    let wrapper: unknown
    page.evaluate.mockImplementationOnce((async (fn: unknown) => { wrapper = fn; return 42 }) as never)
    const result = await tool('browser_evaluate').execute({ function: '() => 42' }, MODEL)
    expect(result.isError).toBe(false)
    expect(String(wrapper)).not.toContain('arguments')
  })

  it('evaluates a measurement expression in the page', async () => {
    page.evaluate.mockResolvedValueOnce({ scrollWidth: 1200, innerWidth: 390 })
    const result = await tool('browser_evaluate').execute({ function: '() => ({ scrollWidth: document.body.scrollWidth })' }, MODEL)
    expect(result.isError).toBe(false)
    expect(result.content).toContain('scrollWidth')
  })
})

describe('session mode policy', () => {
  it('refuses de-isolation for a model caller and names the rule', async () => {
    commandSender.mockResolvedValue({ callId: 'c1', ok: true, tab: linkedTab({ sessionMode: 'isolated' }) })
    const result = await tool('browser_tabs').execute({ action: 'set_session_mode', sessionMode: 'shared' }, MODEL)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('never reduce it')
  })

  it('refuses a model attempt to move the agent link', async () => {
    const result = await tool('browser_tabs').execute({ action: 'select' }, MODEL)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('only the operator can move that link')
  })

  it('reports the one linked tab for list', async () => {
    const result = await tool('browser_tabs').execute({ action: 'list' }, MODEL)
    expect(result.content).toContain('agent-linked')
    expect(result.content).toContain('https://example.test/app')
  })

  it('reuses the linked tab for new instead of opening another', async () => {
    const result = await tool('browser_tabs').execute({ action: 'new', url: 'https://example.test/other' }, MODEL)
    expect(result.content).toContain('one agent-linked browser tab')
    expect(commandSender).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'ensure', url: 'https://example.test/other' }),
      expect.any(Number),
    )
  })
})
