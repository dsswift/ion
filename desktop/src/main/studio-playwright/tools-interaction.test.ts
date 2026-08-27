import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Dialog handling is armed in advance, never reached for afterwards.
 *
 * A JavaScript dialog blocks the page until it is answered, and Playwright
 * auto-dismisses any dialog that has no handler attached. So a tool that tries
 * to find an already-open dialog can never work: by the time it runs, the click
 * that opened the dialog has returned and the dialog is gone.
 *
 * Verified against the running app before this was changed — the listener
 * captured a `confirm`, the page had already recorded `false`, and
 * `dialog.accept()` failed with "No dialog is showing". Then verified the
 * replacement the same way: arming `accept` produced `true`, arming `dismiss`
 * produced `false`.
 */
vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
// The module registers tools, which reaches Electron through the runtime and
// the view manager. Neither is exercised here: the unit under test is the
// dialog listener.
vi.mock('electron', () => ({ app: {}, shell: {}, session: { fromPartition: vi.fn() } }))
vi.mock('./runtime', () => ({ resolveBrowser: vi.fn(), runExclusive: vi.fn(), closeLinkedBrowser: vi.fn(), noteEmulationApplied: vi.fn(), pushEmulationToRenderer: vi.fn() }))
vi.mock('../studio-browser-views', () => ({ ensureBrowserView: vi.fn(), isBrowserViewVisible: vi.fn(() => false) }))

import { armDialog, watchPageDialogs } from './tools-interaction'

interface FakeDialog {
  type: () => string
  message: () => string
  accept: ReturnType<typeof vi.fn>
  dismiss: ReturnType<typeof vi.fn>
}

/** A page whose `dialog` listener can be fired on demand. */
function fakePage() {
  const handlers = new Map<string, (arg: unknown) => void>()
  const page = {
    on: (event: string, fn: (arg: unknown) => void) => { handlers.set(event, fn) },
  } as never
  const openDialog = (type = 'confirm'): FakeDialog => {
    const dialog: FakeDialog = {
      type: () => type,
      message: () => 'Proceed?',
      accept: vi.fn(async () => undefined),
      dismiss: vi.fn(async () => undefined),
    }
    handlers.get('dialog')?.(dialog)
    return dialog
  }
  return { page, openDialog }
}

beforeEach(() => vi.clearAllMocks())

describe('armed dialogs', () => {
  it('accepts the next dialog when accept is armed', () => {
    const { page, openDialog } = fakePage()
    armDialog(page, { accept: true })
    const dialog = openDialog()
    // Answered inside the event, the only moment the dialog is answerable.
    expect(dialog.accept).toHaveBeenCalled()
    expect(dialog.dismiss).not.toHaveBeenCalled()
  })

  it('dismisses the next dialog when dismiss is armed', () => {
    const { page, openDialog } = fakePage()
    armDialog(page, { accept: false })
    const dialog = openDialog()
    expect(dialog.dismiss).toHaveBeenCalled()
    expect(dialog.accept).not.toHaveBeenCalled()
  })

  it('passes prompt text through on accept', () => {
    const { page, openDialog } = fakePage()
    armDialog(page, { accept: true, promptText: 'typed answer' })
    expect(openDialog('prompt').accept).toHaveBeenCalledWith('typed answer')
  })

  it('answers exactly one dialog per arming', () => {
    const { page, openDialog } = fakePage()
    armDialog(page, { accept: true })
    expect(openDialog().accept).toHaveBeenCalled()
    // A second dialog the page raises on its own must not inherit the
    // decision, or one armed accept would silently approve everything after.
    const second = openDialog()
    expect(second.accept).not.toHaveBeenCalled()
    expect(second.dismiss).not.toHaveBeenCalled()
  })

  it('leaves an unarmed dialog to Playwright rather than blocking the page', () => {
    const { page, openDialog } = fakePage()
    watchPageDialogs(page)
    const dialog = openDialog()
    // Not answered here on purpose: Playwright's own dismissal is what keeps
    // an unexpected dialog from wedging the page forever.
    expect(dialog.accept).not.toHaveBeenCalled()
    expect(dialog.dismiss).not.toHaveBeenCalled()
  })
})
