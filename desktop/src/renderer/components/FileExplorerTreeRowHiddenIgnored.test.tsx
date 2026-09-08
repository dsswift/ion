// @vitest-environment jsdom
/**
 * Hidden and git-ignored are independent facts, so they ride independent
 * visual channels and all four combinations stay distinguishable:
 *
 *   normal          tracked, visible
 *   amber           git-ignored
 *   dimmed          hidden (a dotfile, or the Windows hidden attribute)
 *   dimmed + amber  hidden AND git-ignored
 *
 * Before this, opacity encoded git-ignored and nothing encoded hidden, so a
 * dotfile rendered identically to a source folder. On Windows nothing dimmed
 * at all, because the ignore comparison matched only forward slashes while
 * the paths carried backslashes.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect } from 'vitest'
import { FileExplorerTreeRow } from './FileExplorerTreeRow'
import type { FsEntry } from '../../shared/types'

type RowColors = React.ComponentProps<typeof FileExplorerTreeRow>['colors']

const palette = {
  surfaceHover: 'rgb(10, 10, 10)',
  surfacePressed: 'rgb(20, 20, 20)',
  surfaceSelected: 'rgb(30, 30, 30)',
  textPrimary: 'rgb(240, 240, 240)',
  textSecondary: 'rgb(200, 200, 200)',
  textTertiary: 'rgb(150, 150, 150)',
  accent: 'rgb(50, 100, 250)',
  gitUntracked: 'rgb(251, 191, 36)',
} as unknown as RowColors

const dirEntry: FsEntry = {
  name: 'AppData',
  path: 'C:\\Users\\josh\\AppData',
  isDirectory: true,
  size: 0,
  modifiedMs: 0,
}

function readRow(props: Partial<React.ComponentProps<typeof FileExplorerTreeRow>>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <FileExplorerTreeRow
        entry={dirEntry}
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
  const rowEl = container.firstElementChild as HTMLElement
  const spans = container.querySelectorAll('span')
  const label = spans[spans.length - 1] as HTMLElement
  const result = { opacity: rowEl.style.opacity, color: label.style.color }
  act(() => root.unmount())
  container.remove()
  return result
}

describe('hidden and git-ignored ride separate channels', () => {
  it('a normal entry carries neither treatment', () => {
    const { opacity, color } = readRow({})
    expect(opacity).toBe('')
    expect(color).toBe(palette.textPrimary)
  })

  it('git-ignored is amber and stays full opacity', () => {
    // Dimming is reserved for hidden, so an ignored-but-visible file remains
    // easy to read -- it is information, not noise.
    const { opacity, color } = readRow({ isGitIgnored: true })
    expect(color).toBe(palette.gitUntracked)
    expect(opacity).toBe('')
  })

  it('hidden is dimmed and keeps the normal text colour', () => {
    const { opacity, color } = readRow({ isHidden: true })
    expect(opacity).not.toBe('')
    expect(color).toBe(palette.textPrimary)
  })

  it('hidden AND git-ignored carries both', () => {
    const both = readRow({ isHidden: true, isGitIgnored: true })
    expect(both.opacity).toBe(readRow({ isHidden: true }).opacity)
    expect(both.color).toBe(palette.gitUntracked)
  })

  // The point of two channels: one channel cannot express four states.
  it('produces four distinguishable renderings', () => {
    const states = [
      readRow({}),
      readRow({ isGitIgnored: true }),
      readRow({ isHidden: true }),
      readRow({ isHidden: true, isGitIgnored: true }),
    ].map((s) => `${s.opacity}|${s.color}`)
    expect(new Set(states).size).toBe(4)
  })
})
