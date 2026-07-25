// @vitest-environment jsdom
/**
 * Pins the interactive-state contract of the file-explorer tree row
 * (the showcase adopter of `useInteractiveState` / `interactiveBg` /
 * `Chevron`):
 *
 * - selected row → `colors.surfaceSelected` background + fontWeight 500
 *   on the name span (NOT the old surfaceHover-as-selected styling)
 * - hovered row → `colors.surfaceHover` background
 * - directory chevron rotates (transform contains rotate(90deg)) when
 *   expanded, instead of swapping CaretRight/CaretDown glyphs
 *
 * Renders via react-dom/client + act into jsdom (matching
 * StatusBarEngineState.test.tsx). The palette is passed through the
 * component's `colors` prop, so no theme/store stubbing is needed —
 * hover is driven by dispatching a bubbling `mouseover` (which React
 * synthesizes into onMouseEnter).
 */

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect } from 'vitest'

import { FileExplorerTreeRow } from './FileExplorerTreeRow'
import type { FsEntry } from '../../shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type RowColors = React.ComponentProps<typeof FileExplorerTreeRow>['colors']

const palette = {
  surfaceHover: 'rgb(10, 10, 10)',
  surfacePressed: 'rgb(20, 20, 20)',
  surfaceSelected: 'rgb(30, 30, 30)',
  textPrimary: 'rgb(240, 240, 240)',
  textSecondary: 'rgb(200, 200, 200)',
  textTertiary: 'rgb(150, 150, 150)',
  accent: 'rgb(50, 100, 250)',
} as unknown as RowColors

const fileEntry: FsEntry = { name: 'main.ts', path: '/repo/main.ts', isDirectory: false, size: 10, modifiedMs: 0 }
const dirEntry: FsEntry = { name: 'src', path: '/repo/src', isDirectory: true, size: 0, modifiedMs: 0 }

function renderRow(props: Partial<React.ComponentProps<typeof FileExplorerTreeRow>> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <FileExplorerTreeRow
        entry={fileEntry}
        depth={0}
        expanded={false}
        selected={false}
        onToggle={() => {}}
        onClick={() => {}}
        onContextMenu={() => {}}
        colors={palette}
        {...props}
      />,
    )
  })
  const cleanup = () => {
    act(() => {
      root.unmount()
    })
    container.remove()
  }
  return { container, cleanup }
}

function rowEl(container: HTMLElement): HTMLDivElement {
  const el = container.firstElementChild as HTMLDivElement | null
  if (!el) throw new Error('row did not render')
  return el
}

function nameSpan(container: HTMLElement, name: string): HTMLSpanElement {
  const span = Array.from(container.querySelectorAll('span')).find((s) => s.textContent === name)
  if (!span) throw new Error(`name span "${name}" not found`)
  return span
}

describe('FileExplorerTreeRow — interactive states', () => {
  it('selected row gets surfaceSelected background and fontWeight 500 name', () => {
    const { container, cleanup } = renderRow({ selected: true })
    try {
      expect(rowEl(container).style.background).toBe(palette.surfaceSelected)
      expect(nameSpan(container, fileEntry.name).style.fontWeight).toBe('500')
    } finally {
      cleanup()
    }
  })

  it('unselected row has transparent background and normal-weight name', () => {
    const { container, cleanup } = renderRow()
    try {
      expect(rowEl(container).style.background).toBe('transparent')
      expect(nameSpan(container, fileEntry.name).style.fontWeight).toBe('')
    } finally {
      cleanup()
    }
  })

  it('hovered row gets surfaceHover background (hover wins over selected)', () => {
    const { container, cleanup } = renderRow({ selected: true })
    try {
      act(() => {
        rowEl(container).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      })
      expect(rowEl(container).style.background).toBe(palette.surfaceHover)
      act(() => {
        rowEl(container).dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
      })
      expect(rowEl(container).style.background).toBe(palette.surfaceSelected)
    } finally {
      cleanup()
    }
  })

  it('directory chevron rotates 90deg when expanded, 0deg when collapsed', () => {
    const expanded = renderRow({ entry: dirEntry, expanded: true })
    try {
      const chevron = expanded.container.querySelector('span[aria-hidden]') as HTMLSpanElement | null
      expect(chevron).not.toBeNull()
      expect(chevron!.style.transform).toContain('rotate(90deg)')
    } finally {
      expanded.cleanup()
    }

    const collapsed = renderRow({ entry: dirEntry, expanded: false })
    try {
      const chevron = collapsed.container.querySelector('span[aria-hidden]') as HTMLSpanElement | null
      expect(chevron).not.toBeNull()
      expect(chevron!.style.transform).toContain('rotate(0deg)')
    } finally {
      collapsed.cleanup()
    }
  })
})
