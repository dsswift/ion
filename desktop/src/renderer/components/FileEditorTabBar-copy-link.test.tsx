// @vitest-environment jsdom
/**
 * FileEditorTabBar — Copy Link. The tab menu copies the file's `ion://file`
 * link from the shared builder, with the editor's dir and the file's path.
 * A scratch tab has no path, so the entry is disabled.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fileLink } from '@ion/shared/deeplink-url'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const copyDeepLink = vi.hoisted(() => vi.fn(async (_url: string) => undefined))
vi.mock('../deeplink-client', () => ({ copyDeepLink }))
vi.mock('../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rDebug: vi.fn() }))
vi.mock('../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000000' }) }))
vi.mock('../preferences', () => ({
  usePreferencesStore: (selector: (s: { editorWordWrap: boolean; setEditorWordWrap: () => void }) => unknown) =>
    selector({ editorWordWrap: false, setEditorWordWrap: () => {} }),
}))
vi.mock('../host/host-instance', () => ({ host: { capabilities: () => [], shell: {}, openExternal: vi.fn() } }))
vi.mock('@ion/server/store/sessionStore', () => {
  const state = {
    setActiveEditorFile: vi.fn(), closeFileEditorTab: vi.fn(), createScratchFile: vi.fn(),
    reorderEditorFiles: vi.fn(), toggleEditorPreview: vi.fn(), toggleEditorReadOnly: vi.fn(),
  }
  return { useSessionStore: (selector: (s: typeof state) => unknown) => selector(state) }
})

const { FileEditorTabBar } = await import('./FileEditorTabBar')
type Tab = Parameters<typeof FileEditorTabBar>[0]['files'][number]

function file(over: Partial<Tab>): Tab {
  return { id: 'f1', filePath: '/repo/src/a.ts', fileName: 'a.ts', content: '', savedContent: '', isDirty: false, isReadOnly: false, isPreview: false, ...over } as Tab
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  copyDeepLink.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function openMenu(f: Tab): HTMLButtonElement | undefined {
  act(() => root.render(<FileEditorTabBar dir="/repo" files={[f]} activeFile={f} activeFileId={f.id} />))
  const tab = Array.from(host.querySelectorAll('span')).find((s) => s.textContent === f.fileName)!.parentElement!
  act(() => { tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 })) })
  return Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Copy Link')
}

describe('FileEditorTabBar — Copy Link', () => {
  it('copies the file link from the shared builder', () => {
    const button = openMenu(file({}))
    expect(button).toBeDefined()
    act(() => { button!.click() })
    expect(copyDeepLink).toHaveBeenCalledWith(fileLink('/repo', '/repo/src/a.ts'))
  })

  it('is disabled for a scratch tab with no path', () => {
    const button = openMenu(file({ filePath: null, fileName: 'Untitled' }))
    expect(button?.disabled).toBe(true)
  })
})
