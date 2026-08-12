// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { State } from '../stores/session-store-types'
import { selectActiveEditorDir } from './atv-shell-selectors'

function selectorState(): Pick<State, 'activeTabId' | 'tabs' | 'fileEditorStates' | 'fileEditorOpenDirs'> {
  const tab = { id: 'tab-editor', workingDirectory: '/workspace' } as State['tabs'][number]
  return {
    activeTabId: tab.id,
    tabs: [tab],
    fileEditorStates: new Map([['/workspace', {
      activeFileId: 'note',
      files: [{
        id: 'note', filePath: '/workspace/note.txt', fileName: 'note.txt',
        content: '', savedContent: '', isDirty: false, isReadOnly: false, isPreview: false,
      }],
    }]]) as State['fileEditorStates'],
    fileEditorOpenDirs: new Set(['/workspace']),
  }
}

describe('selectActiveEditorDir', () => {
  it('returns same primitive reference across unrelated store notifications', () => {
    const state = selectorState()

    const first = selectActiveEditorDir(state)
    const second = selectActiveEditorDir({ ...state })

    expect(first).toBe('/workspace')
    expect(Object.is(first, second)).toBe(true)
  })

  it('returns null when active editor has no open files', () => {
    const state = selectorState()
    state.fileEditorOpenDirs.clear()

    expect(selectActiveEditorDir(state)).toBeNull()
  })
})
