/**
 * Opening a file in the editor leaves the explorer's open-set alone.
 *
 * The retired `closeExplorerOnFileOpen` preference used to delete the tab's
 * directory from `fileExplorerOpenDirs` on every open. That only meant
 * something in the overlay window, where the explorer was a floating panel
 * keyed on that set. Studio docks the explorer and never reads the set to
 * decide visibility, so the deletion was an invisible side effect. It is gone;
 * this pins that it stays gone.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../rendererLogger', () => ({ rDebug: vi.fn(), rWarn: vi.fn() }))
vi.mock('../../persistence/preferences', () => ({
  usePreferencesStore: { getState: () => ({ openMarkdownInPreview: true }) },
}))

import { createFileEditorSlice } from '../slices/file-editor-slice'

function buildHarness() {
  const state: any = {
    tabs: [{ id: 'tab1', workingDirectory: '/proj', worktree: null }],
    fileExplorerOpenDirs: new Set(['/proj']),
    fileEditorOpenDirs: new Set<string>(),
    fileEditorStates: new Map(),
    fileEditorFocused: false,
  }
  const set = (patch: any) => {
    const next = typeof patch === 'function' ? patch(state) : patch
    Object.assign(state, next)
  }
  const get = () => state
  Object.assign(state, createFileEditorSlice(set as any, get as any))
  return state
}

describe('openFileInEditor', () => {
  it('opens the file without touching fileExplorerOpenDirs', () => {
    const s = buildHarness()
    s.openFileInEditor('/proj', 'tab1', '/proj/README.md')

    expect(s.fileEditorOpenDirs.has('/proj')).toBe(true)
    expect(s.fileExplorerOpenDirs.has('/proj')).toBe(true)
  })
})
