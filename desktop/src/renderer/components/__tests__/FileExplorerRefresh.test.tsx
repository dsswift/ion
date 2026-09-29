// @vitest-environment jsdom
/**
 * The Explorer re-reads a folder when that folder changes, and at no other
 * time.
 *
 * It used to re-read every open folder every five seconds. On Windows each
 * read cost a PowerShell start on the server, so an open Explorer froze the
 * application on that beat. Pinned here: no timer reads anything, a change
 * re-reads only the folders it names that are shown, and a change that
 * arrives while the window is hidden waits until it is visible.
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
import { emitOnChannel, installFakeWire } from '../../host/__tests__/fake-wire'
import { _watcherCount } from '../../hooks/useFileTreeWatch'
import { ignoredPathMatcher, sameListing } from '../file-explorer-listing'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ROOT = '/proj/main'
const entry = (dir: string, name: string, isDirectory: boolean) => ({ name, path: `${dir}/${name}`, isDirectory, size: 1, modifiedMs: 1, isHidden: false })

let listings: Record<string, ReturnType<typeof entry>[]>
let fsReadDir: ReturnType<typeof vi.fn>
let gitIgnoredFiles: ReturnType<typeof vi.fn>
let fsWatchTree: ReturnType<typeof vi.fn>
let fsUnwatchTree: ReturnType<typeof vi.fn>

const readDirs = (): string[] => fsReadDir.mock.calls.map((c: unknown[]) => (c[0] as { directory: string }).directory)

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

afterEach(() => { vi.useRealTimers() })

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

const change = (directories: string[], extra: Partial<{ overflow: boolean; ignoreRulesChanged: boolean }> = {}) =>
  ({ root: ROOT, directories, overflow: false, ignoreRulesChanged: false, ...extra })

describe('FileExplorer refresh', () => {
  it('reads what is shown once, then reads nothing on a timer', async () => {
    const { unmount } = await render()
    expect(readDirs().sort()).toEqual([ROOT, `${ROOT}/src`])
    expect(gitIgnoredFiles).toHaveBeenCalledTimes(1)

    vi.useFakeTimers()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    vi.useRealTimers()
    expect(fsReadDir).toHaveBeenCalledTimes(2)
    expect(gitIgnoredFiles).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('watches the root while shown and stops when unmounted', async () => {
    const { unmount } = await render()
    expect(fsWatchTree).toHaveBeenCalledWith({ root: ROOT })
    unmount()
    await settle()
    expect(fsUnwatchTree).toHaveBeenCalledWith({ root: ROOT })
    expect(_watcherCount(ROOT)).toBe(0)
  })

  it('holds one watch for two Explorers on the same root, until the last one closes', async () => {
    const { unmount } = await render(2)
    expect(fsWatchTree).toHaveBeenCalledTimes(1)
    expect(_watcherCount(ROOT)).toBe(2)
    unmount()
    await settle()
    expect(fsUnwatchTree).toHaveBeenCalledTimes(1)
  })

  it('re-reads only the changed folders that are shown', async () => {
    const { container, unmount } = await render()
    fsReadDir.mockClear()
    gitIgnoredFiles.mockClear()

    listings[`${ROOT}/src`] = [entry(`${ROOT}/src`, 'index.ts', false), entry(`${ROOT}/src`, 'added.ts', false)]
    // `docs` is not expanded and `node_modules/x` is not shown at all.
    await act(async () => { emitOnChannel('ion:fs-tree-changed', change(['src', 'docs', 'node_modules/x'])) })
    await settle()

    expect(readDirs()).toEqual([`${ROOT}/src`])
    expect(container.textContent).toContain('added.ts')
    // An entry appeared, so which entries are ignored is asked again.
    expect(gitIgnoredFiles).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('does not ask git again when a changed folder lists the same entries', async () => {
    const { unmount } = await render()
    fsReadDir.mockClear()
    gitIgnoredFiles.mockClear()
    await act(async () => { emitOnChannel('ion:fs-tree-changed', change(['src'])) })
    await settle()
    expect(readDirs()).toEqual([`${ROOT}/src`])
    expect(gitIgnoredFiles).not.toHaveBeenCalled()
    unmount()
  })

  it('reads nothing for a change that touches nothing shown', async () => {
    const { unmount } = await render()
    fsReadDir.mockClear()
    gitIgnoredFiles.mockClear()
    await act(async () => { emitOnChannel('ion:fs-tree-changed', change(['node_modules/a', 'dist/assets'])) })
    await act(async () => { emitOnChannel('ion:fs-tree-changed', { ...change(['']), root: '/another/root' }) })
    await settle()
    expect(fsReadDir).not.toHaveBeenCalled()
    expect(gitIgnoredFiles).not.toHaveBeenCalled()
    unmount()
  })

  it('re-reads everything shown on overflow, and the ignored paths when the rules change', async () => {
    const { unmount } = await render()
    fsReadDir.mockClear()
    gitIgnoredFiles.mockClear()
    await act(async () => { emitOnChannel('ion:fs-tree-changed', change([], { overflow: true })) })
    await settle()
    expect(readDirs().sort()).toEqual([ROOT, `${ROOT}/src`])
    expect(gitIgnoredFiles).toHaveBeenCalledTimes(1)

    fsReadDir.mockClear()
    gitIgnoredFiles.mockClear()
    await act(async () => { emitOnChannel('ion:fs-tree-changed', change(['node_modules'], { ignoreRulesChanged: true })) })
    await settle()
    expect(fsReadDir).not.toHaveBeenCalled()
    expect(gitIgnoredFiles).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('holds a change that arrives while the window is hidden until it is visible', async () => {
    const { unmount } = await render()
    fsReadDir.mockClear()
    setVisibility('hidden')
    await act(async () => { emitOnChannel('ion:fs-tree-changed', change(['src'])) })
    await settle()
    expect(fsReadDir).not.toHaveBeenCalled()

    await act(async () => { setVisibility('visible') })
    await settle()
    expect(readDirs().sort()).toEqual([ROOT, `${ROOT}/src`])
    unmount()
  })

  it('reads and watches nothing for a collapsed root', async () => {
    useSessionStore.setState({ fileExplorerRootCollapsed: new Set([ROOT]) })
    const { unmount } = await render()
    expect(fsReadDir).not.toHaveBeenCalled()
    expect(fsWatchTree).not.toHaveBeenCalled()
    unmount()
  })

  it('reads a folder once when it is expanded, and nothing else', async () => {
    const { unmount } = await render()
    fsReadDir.mockClear()
    gitIgnoredFiles.mockClear()
    await act(async () => { useSessionStore.getState().setFileExplorerExpanded(ROOT, `${ROOT}/docs`, true) })
    await settle()
    expect(readDirs()).toEqual([`${ROOT}/docs`])
    unmount()
  })
})

describe('sameListing', () => {
  it('ignores size and modified time, which no row renders', () => {
    const before = [entry(ROOT, 'a.ts', false)]
    expect(sameListing(before, [{ ...before[0], size: 99, modifiedMs: 99 }])).toBe(true)
  })

  it('sees an added, removed, renamed, or re-flagged entry', () => {
    const before = [entry(ROOT, 'a.ts', false), entry(ROOT, 'b.ts', false)]
    expect(sameListing(before, [before[0]])).toBe(false)
    expect(sameListing(before, [...before, entry(ROOT, 'c.ts', false)])).toBe(false)
    expect(sameListing(before, [before[0], entry(ROOT, 'renamed.ts', false)])).toBe(false)
    expect(sameListing(before, [before[0], { ...before[1], isHidden: true }])).toBe(false)
    expect(sameListing(undefined, [])).toBe(false)
  })
})

describe('ignoredPathMatcher', () => {
  it('matches an ignored directory, everything under it, and no same-prefix sibling', () => {
    const isIgnored = ignoredPathMatcher(['/repo/node_modules/', '/repo/.env'])
    expect(isIgnored('/repo/node_modules')).toBe(true)
    expect(isIgnored('/repo/node_modules/pkg/index.js')).toBe(true)
    expect(isIgnored('/repo/.env')).toBe(true)
    expect(isIgnored('/repo/node_modules_backup')).toBe(false)
    expect(isIgnored('/repo/src')).toBe(false)
  })

  it('matches across the two separators a Windows path arrives in', () => {
    const isIgnored = ignoredPathMatcher(['C:\\repo\\node_modules/'])
    expect(isIgnored('C:\\repo\\node_modules')).toBe(true)
    expect(isIgnored('C:\\repo\\node_modules\\pkg')).toBe(true)
    expect(isIgnored('C:\\repo\\src')).toBe(false)
  })
})
