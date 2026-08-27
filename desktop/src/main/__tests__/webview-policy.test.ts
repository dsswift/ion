/**
 * webview-policy scheme allowlist + preview-partition unlock rules (D6).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const openExternal = vi.hoisted(() => vi.fn(async () => undefined))
const onBeforeRequest = vi.hoisted(() => vi.fn())
const fromPartition = vi.hoisted(() => vi.fn(() => ({ webRequest: { onBeforeRequest } })))
vi.mock('electron', () => ({
  app: {},
  shell: { openExternal },
  session: { fromPartition },
}))
vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
const requestStudioBrowserTab = vi.hoisted(() => vi.fn())
vi.mock('../studio-browser-tab-request', () => ({ requestStudioBrowserTab }))

import { _schemeAllowed, allowPreviewNetwork, _resetPreviewUnlocks, installGuestPolicy } from '../webview-policy'

beforeEach(() => {
  _resetPreviewUnlocks()
})

describe('webview scheme allowlist', () => {
  it('permits https, http, file, and about:blank', () => {
    expect(_schemeAllowed('https://example.org')).toBe(true)
    expect(_schemeAllowed('http://localhost:3000')).toBe(true)
    expect(_schemeAllowed('file:///repo/page.html')).toBe(true)
    expect(_schemeAllowed('about:blank')).toBe(true)
  })

  it('refuses everything else', () => {
    expect(_schemeAllowed('javascript:alert(1)')).toBe(false)
    expect(_schemeAllowed('data:text/html,<script>1</script>')).toBe(false)
    expect(_schemeAllowed('chrome://settings')).toBe(false)
    expect(_schemeAllowed('about:config')).toBe(false)
    expect(_schemeAllowed('ion://terminal')).toBe(false)
  })

  it('empty src attaches blank (navigation gates later)', () => {
    expect(_schemeAllowed('')).toBe(true)
  })
})

describe('preview partition unlock', () => {
  it('accepts only studio-preview partitions', () => {
    expect(allowPreviewNetwork('studio-preview-instance-1')).toBe(true)
    expect(allowPreviewNetwork('persist:studio-browser')).toBe(false)
    expect(allowPreviewNetwork('persist:studio-preview-abc')).toBe(false)
    expect(allowPreviewNetwork('')).toBe(false)
  })
})

describe('clicked links inside a browser guest', () => {
  /** Capture the window-open handler the policy installs on a guest. */
  function attachGuest(altHeld = false): (details: { url: string; disposition: string }) => { action: string } {
    let openHandler!: (details: { url: string; disposition: string }) => { action: string }
    type InputListener = (event: unknown, input: { type: string; modifiers: string[] }) => void
    // Explicitly widened: assigning only inside the `on` callback lets TS
    // narrow the declaration to `never` at the call site below.
    let inputListener: InputListener | null = null as InputListener | null
    const guest = {
      setWindowOpenHandler: (fn: typeof openHandler) => { openHandler = fn },
      on: (event: string, fn: (...args: never[]) => void) => {
        if (event === 'input-event') inputListener = fn as unknown as InputListener
      },
    }
    installGuestPolicy(guest as never, 'persist:studio-browser')
    // Replay the click that precedes the open request, which is the only place
    // Electron reports modifier keys.
    inputListener?.({}, { type: 'mouseUp', modifiers: altHeld ? ['alt', 'meta'] : ['meta'] })
    return openHandler
  }

  beforeEach(() => {
    requestStudioBrowserTab.mockClear()
    openExternal.mockClear()
  })

  it('reopens a cmd-clicked link as a surface browser tab', () => {
    const open = attachGuest()
    // Chromium reports a cmd-click as a new-tab disposition. The popup is
    // still denied — a surface browser tab is a single document — but the
    // operator's intent was "open this somewhere", so it is not dropped.
    for (const disposition of ['foreground-tab', 'background-tab']) {
      requestStudioBrowserTab.mockClear()
      expect(open({ url: 'https://example.test/docs', disposition }).action).toBe('deny')
      expect(requestStudioBrowserTab).toHaveBeenCalledWith('https://example.test/docs')
    }
  })

  it('still denies a scripted window.open outright', () => {
    const open = attachGuest()
    // A page opening its own popup is not an operator gesture.
    expect(open({ url: 'https://ads.test/popup', disposition: 'new-window' }).action).toBe('deny')
    expect(requestStudioBrowserTab).not.toHaveBeenCalled()
  })

  it('does not route a non-http scheme into a browser tab', () => {
    const open = attachGuest()
    expect(open({ url: 'file:///etc/passwd', disposition: 'foreground-tab' }).action).toBe('deny')
    expect(open({ url: 'mailto:dev@example.com', disposition: 'foreground-tab' }).action).toBe('deny')
    expect(requestStudioBrowserTab).not.toHaveBeenCalled()
  })

  it('sends the link to the OS browser when alt was held', () => {
    const open = attachGuest(true)
    expect(open({ url: 'https://example.test/docs', disposition: 'background-tab' }).action).toBe('deny')
    // Blink reports the SAME disposition for cmd-click and cmd-option-click,
    // so this only works because the modifier came from the input stream.
    expect(openExternal).toHaveBeenCalledWith('https://example.test/docs')
    expect(requestStudioBrowserTab).not.toHaveBeenCalled()
  })

  it('still opens a surface tab when alt was not held', () => {
    const open = attachGuest(false)
    expect(open({ url: 'https://example.test/docs', disposition: 'background-tab' }).action).toBe('deny')
    expect(requestStudioBrowserTab).toHaveBeenCalledWith('https://example.test/docs')
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('does not let one alt-click colour a later navigation', () => {
    const open = attachGuest(true)
    open({ url: 'https://example.test/one', disposition: 'background-tab' })
    // The page navigating again on its own must not inherit the escape.
    open({ url: 'https://example.test/two', disposition: 'background-tab' })
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(requestStudioBrowserTab).toHaveBeenCalledWith('https://example.test/two')
  })
})

describe('preview offline block installation', () => {
  /** A guest stub; only the policy hooks matter here. */
  function guest() {
    return { setWindowOpenHandler: vi.fn(), on: vi.fn() } as never
  }

  beforeEach(() => {
    fromPartition.mockClear()
    onBeforeRequest.mockClear()
  })

  it('installs the block for a preview partition', () => {
    // This moved off the did-attach-webview path when the browser body became
    // a WebContentsView. A preview tab renders local HTML and must be offline
    // by default, so the filter has to arrive through the new call path too.
    installGuestPolicy(guest(), 'studio-preview-abc')
    expect(fromPartition).toHaveBeenCalledWith('studio-preview-abc')
    expect(onBeforeRequest).toHaveBeenCalled()
  })

  it('does not touch a normal browse partition', () => {
    // Applying the offline filter to the shared session would break ordinary
    // browsing for every tab that uses it.
    installGuestPolicy(guest(), 'persist:studio-browser')
    expect(fromPartition).not.toHaveBeenCalled()
    expect(onBeforeRequest).not.toHaveBeenCalled()
  })

  it('does not touch a private browse partition', () => {
    installGuestPolicy(guest(), 'studio-isolated-xyz')
    expect(onBeforeRequest).not.toHaveBeenCalled()
  })
})
