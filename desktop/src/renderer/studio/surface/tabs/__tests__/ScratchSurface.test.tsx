// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { ScratchDocument } from '../../../../../shared/studio-surface-types'

const { rInfo, rWarn } = vi.hoisted(() => ({ rInfo: vi.fn(), rWarn: vi.fn() }))
vi.mock('../../../../rendererLogger', () => ({ rInfo, rWarn, rTrace: vi.fn(), rDebug: vi.fn(), rError: vi.fn() }))
vi.mock('../../../../theme', () => ({ useColors: () => ({}) }))
vi.mock('../../../../stores/sessionStore', () => ({ useSessionStore: Object.assign(vi.fn(), { getState: vi.fn() }) }))
vi.mock('../../../../preferences', () => ({ usePreferencesStore: vi.fn() }))
vi.mock('../../../../components/FileEditorCodeMirror', () => ({ FileEditorCodeMirror: () => null }))
vi.mock('../../../../components/FileEditorPreview', () => ({ FileEditorPreview: () => null }))
vi.mock('../../../../components/FileEditorStatusBar', () => ({ FileEditorStatusBar: () => null }))
vi.mock('../FileSurfaceControls', () => ({ FileSurfaceControls: () => null }))
vi.mock('../../surface-store', () => ({ useSurfaceStore: vi.fn() }))

import { saveScratchDocument } from '../ScratchSurface'

const document: ScratchDocument = {
  id: 'scratch-1',
  fileName: 'Untitled-1.md',
  content: 'project notes',
  savedContent: '',
  isPreview: false,
}

describe('saveScratchDocument', () => {
  it('starts in the active physical directory and promotes after a successful write', async () => {
    const showSaveDialog = vi.fn(async () => ({ filePath: '/worktrees/one/notes.md' }))
    const writeFile = vi.fn(async () => ({ ok: true }))
    const setError = vi.fn()
    const promote = vi.fn()

    await saveScratchDocument(document, '/worktrees/one', '/repo', { showSaveDialog, writeFile, setError, promote })

    expect(showSaveDialog).toHaveBeenCalledWith('/worktrees/one/Untitled-1.md')
    expect(writeFile).toHaveBeenCalledWith('/worktrees/one/notes.md', 'project notes')
    expect(promote).toHaveBeenCalledWith('/worktrees/one/notes.md')
  })

  it('keeps the Scratch Document when Save is cancelled', async () => {
    const writeFile = vi.fn()
    const promote = vi.fn()

    await saveScratchDocument(document, '/repo', '/repo', {
      showSaveDialog: async () => ({ filePath: null }),
      writeFile,
      setError: vi.fn(),
      promote,
    })

    expect(writeFile).not.toHaveBeenCalled()
    expect(promote).not.toHaveBeenCalled()
  })

  it('keeps the Scratch Document and surfaces a write failure', async () => {
    const setError = vi.fn()
    const promote = vi.fn()

    await saveScratchDocument(document, '/repo', '/repo', {
      showSaveDialog: async () => ({ filePath: '/repo/notes.md' }),
      writeFile: async () => ({ ok: false, error: 'disk full' }),
      setError,
      promote,
    })

    expect(setError).toHaveBeenLastCalledWith('disk full')
    expect(promote).not.toHaveBeenCalled()
    expect(rWarn).toHaveBeenCalledWith('studio.scratch', 'scratch save failed', expect.objectContaining({ error: 'disk full' }))
  })
})
