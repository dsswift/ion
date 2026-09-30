import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ clipboard: {}, Menu: {}, shell: {} }))
vi.mock('./logger', () => ({ log: vi.fn(), warn: vi.fn() }))
vi.mock('./studio-browser-tab-request', () => ({ requestStudioBrowserTab: vi.fn() }))
vi.mock('./studio-browser-window-resolver', () => ({ getStudioBrowserWindow: () => null }))

import { browserMenuTemplate, type BrowserMenuParams } from './studio-browser-menu'

const editFlags = { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canDelete: false, canSelectAll: false, canEditRichly: false }
function params(over: Partial<BrowserMenuParams> = {}): BrowserMenuParams {
  return { linkURL: '', srcURL: '', mediaType: 'none', isEditable: false, selectionText: '', editFlags, ...over }
}
const history = { canGoBack: true, canGoForward: false }
function ids(items: ReturnType<typeof browserMenuTemplate>): string[] {
  return items.map((item) => ('type' in item ? '-' : item.id))
}

describe('browserMenuTemplate', () => {
  it('offers only navigation on plain page', () => {
    const items = browserMenuTemplate(params(), history)
    expect(ids(items)).toEqual(['back', 'forward', 'reload'])
    expect(items.find((item) => 'id' in item && item.id === 'forward')).toMatchObject({ enabled: false })
  })

  it('adds link verbs for an http link and not for other schemes', () => {
    expect(ids(browserMenuTemplate(params({ linkURL: 'https://example.org/a' }), history)))
      .toEqual(['open-link-new-tab', 'open-link-external', 'copy-link', '-', 'back', 'forward', 'reload'])
    expect(ids(browserMenuTemplate(params({ linkURL: 'mailto:someone@example.org' }), history)))
      .toEqual(['back', 'forward', 'reload'])
  })

  it('adds image verbs for an image', () => {
    expect(ids(browserMenuTemplate(params({ mediaType: 'image', srcURL: 'https://example.org/a.png' }), history)))
      .toEqual(['copy-image', 'copy-image-address', '-', 'back', 'forward', 'reload'])
  })

  it('adds edit verbs gated on the edit flags in an editable field', () => {
    const items = browserMenuTemplate(params({ isEditable: true, editFlags: { ...editFlags, canPaste: true, canSelectAll: true } }), history)
    expect(ids(items)).toEqual(['cut', 'copy', 'paste', 'select-all', '-', 'back', 'forward', 'reload'])
    expect(items.filter((item) => 'id' in item && item.enabled).map((item) => ('id' in item ? item.id : '')))
      .toEqual(['paste', 'select-all', 'back', 'reload'])
  })

  it('offers copy for a selection on a non-editable page', () => {
    expect(ids(browserMenuTemplate(params({ selectionText: 'hello', editFlags: { ...editFlags, canCopy: true } }), history)))
      .toEqual(['copy', '-', 'back', 'forward', 'reload'])
  })
})
