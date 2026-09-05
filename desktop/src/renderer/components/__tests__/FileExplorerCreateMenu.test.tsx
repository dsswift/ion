// @vitest-environment jsdom
/**
 * Creating a file or folder is a folder-scoped action, so it lives on the
 * right-click menus where the target is explicit — not on a header button
 * whose target was whichever root happened to hold the selection.
 *
 * Pinned here: the header no longer offers creation; the entry menu creates in
 * the right-clicked directory and in a right-clicked file's parent; the source
 * repository root header menu creates at the root; and a collapsed directory is
 * expanded first, without which the inline input would be set but never
 * rendered.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useSessionStore } from '../../stores/sessionStore'
import { usePreferencesStore } from '../../preferences'
import { FileExplorer } from '../FileExplorer'
import { PopoverLayerProvider } from '../PopoverLayer'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ROOT = '/proj/main'
const ENTRIES = [
  { name: 'src', path: `${ROOT}/src`, isDirectory: true },
  { name: 'readme.md', path: `${ROOT}/readme.md`, isDirectory: false },
]

beforeEach(() => {
  ;(window as unknown as { ion: unknown }).ion = {
    fsReadDir: vi.fn().mockResolvedValue({ entries: ENTRIES }),
    gitIgnoredFiles: vi.fn().mockResolvedValue({ paths: [] }),
    selectDirectory: vi.fn().mockResolvedValue(null),
    fsRevealInFinder: vi.fn().mockResolvedValue(undefined),
    fsCreateFile: vi.fn().mockResolvedValue({ ok: true }),
    fsCreateDir: vi.fn().mockResolvedValue({ ok: true }),
  }
  useSessionStore.setState({
    activeTabId: 'tab-1',
    tabs: [{ id: 'tab-1', workingDirectory: ROOT }] as never,
    fileExplorerRootCollapsed: new Set<string>(),
    fileExplorerStates: new Map(),
  })
  usePreferencesStore.setState({ workspaceFolders: {} })
})

async function render(): Promise<{ container: HTMLElement; unmount: () => void }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <PopoverLayerProvider>
        <FileExplorer />
      </PopoverLayerProvider>,
    )
  })
  return {
    container,
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

/** A menu row (entry menu div, root-header menu button) by its exact label. */
function byText(label: string): HTMLElement | null {
  const all = [...document.querySelectorAll('div, button')] as HTMLElement[]
  return all.find((el) => el.textContent?.trim() === label && el.children.length <= 1) ?? null
}

/** A tree row, addressed by the span carrying its name (events bubble). */
function treeRow(name: string): HTMLElement | null {
  const all = [...document.querySelectorAll('span')] as HTMLElement[]
  return all.find((el) => el.textContent === name) ?? null
}

/**
 * Type into the controlled inline input. Assigning `.value` alone never
 * reaches React's onChange, so the name would submit empty.
 */
function typeName(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

function rightClick(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }))
  })
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 }))
  })
}

/** The inline create input, identified by the placeholder each type sets. */
function inlineInput(): HTMLInputElement | null {
  return document.querySelector('input[placeholder="filename"], input[placeholder="folder name"]')
}

describe('file and folder creation', () => {
  it('the explorer header no longer offers New File or New Folder', async () => {
    const { container, unmount } = await render()
    expect(container.querySelector('[aria-label="New File"]')).toBeNull()
    expect(container.querySelector('[aria-label="New Folder"]')).toBeNull()
    expect(container.querySelector('[aria-label="Add Folder to Workspace"]')).not.toBeNull()
    unmount()
  })

  it('the entry menu creates inside a right-clicked directory', async () => {
    const { unmount } = await render()
    const row = treeRow('src')
    expect(row).not.toBeNull()
    rightClick(row!)
    const newFile = byText('New File')
    expect(newFile).not.toBeNull()
    click(newFile!)

    // The input renders as a child of the expanded directory, which the click
    // had to expand first: `src` was collapsed.
    expect(useSessionStore.getState().fileExplorerStates.get(ROOT)?.expandedPaths.has(`${ROOT}/src`)).toBe(true)
    const input = inlineInput()
    expect(input).not.toBeNull()

    typeName(input!, 'new.ts')
    const ion = (window as unknown as { ion: { fsCreateFile: ReturnType<typeof vi.fn> } }).ion
    expect(ion.fsCreateFile).toHaveBeenCalledWith(`${ROOT}/src/new.ts`)
    unmount()
  })

  it("a right-clicked file creates in that file's parent folder", async () => {
    const { unmount } = await render()
    rightClick(treeRow('readme.md')!)
    click(byText('New Folder')!)

    const input = inlineInput()
    expect(input).not.toBeNull()
    typeName(input!, 'docs')
    const ion = (window as unknown as { ion: { fsCreateDir: ReturnType<typeof vi.fn> } }).ion
    expect(ion.fsCreateDir).toHaveBeenCalledWith(`${ROOT}/docs`)
    unmount()
  })

  it('the source repository root header menu creates at the root', async () => {
    const { container, unmount } = await render()
    const affordance = container.querySelector('[aria-label="Root menu for main"]')
    expect(affordance).not.toBeNull()
    click(affordance!)
    click(byText('New File')!)

    const input = inlineInput()
    expect(input).not.toBeNull()
    typeName(input!, 'top.txt')
    const ion = (window as unknown as { ion: { fsCreateFile: ReturnType<typeof vi.fn> } }).ion
    expect(ion.fsCreateFile).toHaveBeenCalledWith(`${ROOT}/top.txt`)
    unmount()
  })
})
