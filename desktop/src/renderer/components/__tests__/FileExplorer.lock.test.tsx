// @vitest-environment jsdom
/**
 * The Explorer's Add Folder to Workspace button opens a folder chooser, so a
 * new-conversation lock that names a directory takes it away. Reading the
 * locked folder stays: the tree is the person's own work.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { makeLocalTab } from '@ion/server/store/session-store-helpers'
import { usePreferencesStore } from '../../preferences'
import { FileExplorer } from '../FileExplorer'
import { PopoverLayerProvider } from '../PopoverLayer'
import { installFakeWire } from '../../host/__tests__/fake-wire'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ROOT = '/proj/main'
const entry = (dir: string, name: string, isDirectory: boolean) => ({ name, path: `${dir}/${name}`, isDirectory, size: 1, modifiedMs: 1, isHidden: false })

let listings: Record<string, ReturnType<typeof entry>[]>
let fsReadDir: ReturnType<typeof vi.fn>
let gitIgnoredFiles: ReturnType<typeof vi.fn>
let fsWatchTree: ReturnType<typeof vi.fn>
let fsUnwatchTree: ReturnType<typeof vi.fn>

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  listings = {
    [ROOT]: [entry(ROOT, 'src', true), entry(ROOT, 'docs', true), entry(ROOT, 'readme.md', false)],
    [`${ROOT}/src`]: [entry(`${ROOT}/src`, 'index.ts', false)],
    [`${ROOT}/docs`]: [entry(`${ROOT}/docs`, 'guide.md', false)],
  }
  fsReadDir = vi.fn(async ({ directory }: { directory: string }) => ({ entries: listings[directory] ?? [] }))
  gitIgnoredFiles = vi.fn().mockResolvedValue({ paths: [] })
  fsWatchTree = vi.fn().mockResolvedValue({ ok: true })
  fsUnwatchTree = vi.fn().mockResolvedValue({ ok: true })
  ;(window as unknown as { ion: unknown }).ion = installFakeWire({ fsReadDir, gitIgnoredFiles, fsWatchTree, fsUnwatchTree })
  useSessionStore.setState({
    activeTabId: 'tab-1',
    tabs: [{ ...makeLocalTab(), id: 'tab-1', workingDirectory: ROOT }] as never,
    fileExplorerRootCollapsed: new Set<string>(),
    fileExplorerStates: new Map([[ROOT, { expandedPaths: new Set([`${ROOT}/src`]), selectedPath: null }]]),
  })
  usePreferencesStore.setState({ workspaceFolders: {} })
  setVisibility('visible')
})

afterEach(() => { vi.useRealTimers(); usePreferencesStore.setState({ enterpriseNewConversationDefaults: null }) })

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

async function render(explorers = 1): Promise<{ container: HTMLElement; unmount: () => void }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <PopoverLayerProvider>
        {Array.from({ length: explorers }, (_, i) => <FileExplorer key={i} docked />)}
      </PopoverLayerProvider>,
    )
  })
  await settle()
  return { container, unmount: () => { act(() => root.unmount()); container.remove() } }
}

const headerTitles = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('button')].map((b) => b.getAttribute('title') ?? b.getAttribute('aria-label') ?? '').filter(Boolean)

describe('FileExplorer header under the new-conversation lock', () => {
  it('offers Add Folder to Workspace when nothing locks the folder', async () => {
    const { container, unmount } = await render()
    expect(headerTitles(container)).toContain('Add Folder to Workspace')
    unmount()
  })

  it('offers no Add Folder to Workspace under a directory lock, and keeps the read-only controls', async () => {
    usePreferencesStore.setState({ enterpriseNewConversationDefaults: { locked: true, baseDirectory: ROOT, engineProfileId: 'orion' } })
    const { container, unmount } = await render()
    expect(headerTitles(container)).not.toContain('Add Folder to Workspace')
    expect(headerTitles(container)).toEqual(expect.arrayContaining(['Refresh', 'Collapse All']))
    unmount()
  })
})
