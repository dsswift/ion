/**
 * studio-browser-menu — the right-click menu inside a browser guest.
 *
 * A native `Menu.popup()` rather than a DOM menu, and not for style: the guest
 * is a `WebContentsView` composited above the Studio document, so a DOM menu
 * would render behind the page it is about. A native menu is an OS window and
 * paints above everything, which also means it needs none of the popover-rect
 * coordination DOM popovers do.
 *
 * `browserMenuTemplate` is pure so the item set for each context (a link, an
 * image, an editable field, plain page) is pinned by test. The installer maps
 * item ids to actions on the guest.
 */
import { clipboard, Menu, shell, type ContextMenuParams, type WebContents } from 'electron'
import { log as _log, warn as _warn } from './logger'
import { requestStudioBrowserTab } from './studio-browser-tab-request'
import { getStudioBrowserWindow } from './studio-browser-window-resolver'

const TAG = 'studio-browser-menu'

export type BrowserMenuItemId =
  | 'back' | 'forward' | 'reload'
  | 'open-link-new-tab' | 'open-link-external' | 'copy-link'
  | 'copy-image' | 'copy-image-address'
  | 'cut' | 'copy' | 'paste' | 'select-all'

export type BrowserMenuItem =
  | { type: 'separator' }
  | { id: BrowserMenuItemId; label: string; enabled: boolean }

/** The subset of `ContextMenuParams` the template reads. */
export type BrowserMenuParams = Pick<ContextMenuParams, 'linkURL' | 'srcURL' | 'mediaType' | 'isEditable' | 'selectionText' | 'editFlags'>

function isHttpUrl(raw: string): boolean {
  try {
    const protocol = new URL(raw).protocol
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

export function browserMenuTemplate(params: BrowserMenuParams, history: { canGoBack: boolean; canGoForward: boolean }): BrowserMenuItem[] {
  const items: BrowserMenuItem[] = []
  const link = params.linkURL && isHttpUrl(params.linkURL)
  const image = params.mediaType === 'image' && !!params.srcURL
  const hasSelection = params.selectionText.trim().length > 0

  if (link) {
    items.push(
      { id: 'open-link-new-tab', label: 'Open Link in New Tab', enabled: true },
      { id: 'open-link-external', label: 'Open Link in Default Browser', enabled: true },
      { id: 'copy-link', label: 'Copy Link', enabled: true },
      { type: 'separator' },
    )
  }
  if (image) {
    items.push(
      { id: 'copy-image', label: 'Copy Image', enabled: true },
      { id: 'copy-image-address', label: 'Copy Image Address', enabled: true },
      { type: 'separator' },
    )
  }
  if (params.isEditable) {
    items.push(
      { id: 'cut', label: 'Cut', enabled: params.editFlags.canCut },
      { id: 'copy', label: 'Copy', enabled: params.editFlags.canCopy },
      { id: 'paste', label: 'Paste', enabled: params.editFlags.canPaste },
      { id: 'select-all', label: 'Select All', enabled: params.editFlags.canSelectAll },
      { type: 'separator' },
    )
  } else if (hasSelection) {
    items.push({ id: 'copy', label: 'Copy', enabled: params.editFlags.canCopy }, { type: 'separator' })
  }
  items.push(
    { id: 'back', label: 'Back', enabled: history.canGoBack },
    { id: 'forward', label: 'Forward', enabled: history.canGoForward },
    { id: 'reload', label: 'Reload', enabled: true },
  )
  return items
}

function run(id: BrowserMenuItemId, guest: WebContents, params: ContextMenuParams, context: { conversationId: string; instanceId: string }): void {
  _log(TAG, 'browser context menu item chosen', { conversation_id: context.conversationId, instance_id: context.instanceId, item: id })
  switch (id) {
    case 'back': if (guest.navigationHistory.canGoBack()) guest.navigationHistory.goBack(); return
    case 'forward': if (guest.navigationHistory.canGoForward()) guest.navigationHistory.goForward(); return
    case 'reload': guest.reload(); return
    case 'open-link-new-tab': requestStudioBrowserTab(params.linkURL); return
    case 'open-link-external':
      void shell.openExternal(params.linkURL).catch((err: unknown) => {
        _warn(TAG, 'default browser open failed', { conversation_id: context.conversationId, error: String(err) })
      })
      return
    case 'copy-link': clipboard.writeText(params.linkURL); return
    case 'copy-image': guest.copyImageAt(params.x, params.y); return
    case 'copy-image-address': clipboard.writeText(params.srcURL); return
    case 'cut': guest.cut(); return
    case 'copy': guest.copy(); return
    case 'paste': guest.paste(); return
    case 'select-all': guest.selectAll(); return
  }
}

/** Wire the `context-menu` event on one guest. */
export function installBrowserContextMenu(guest: WebContents, context: { conversationId: string; instanceId: string }): void {
  guest.on('context-menu', (_event, params) => {
    const window = getStudioBrowserWindow()
    if (!window || window.isDestroyed()) return
    const template = browserMenuTemplate(params, {
      canGoBack: guest.navigationHistory.canGoBack(),
      canGoForward: guest.navigationHistory.canGoForward(),
    })
    const menu = Menu.buildFromTemplate(template.map((item) =>
      'type' in item
        ? { type: 'separator' as const }
        : { label: item.label, enabled: item.enabled, click: () => run(item.id, guest, params, context) },
    ))
    menu.popup({ window })
  })
}
