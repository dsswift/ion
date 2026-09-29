// @vitest-environment jsdom
/**
 * toggleEditorWordWrap — per-tab override semantics:
 *   - first toggle flips AWAY from the effective value (the editorWordWrap
 *     preference when no override exists), then alternates
 *   - the preference itself never changes
 */
import { describe, it, expect, beforeEach } from 'vitest'

// The default word wrap is a Device setting. The client registers a reader
// over its own store (client-preferences.ts); the test registers one here.
import { useSessionStore } from '../../sessionStore'
import { registerClientPreferences } from '../../client-preferences'

const device = { soundEnabled: true, editorWordWrap: true, openMarkdownInPreview: true }
registerClientPreferences(() => device)
const usePreferencesStore = {
  getState: () => device,
  setState: (patch: Partial<typeof device>) => { Object.assign(device, patch) },
}

function seedFileTab(dir: string, filePath: string): string {
  const s = useSessionStore.getState()
  const states = new Map(s.fileEditorStates)
  const id = `test-${filePath}`
  states.set(dir, {
    activeFileId: id,
    files: [
      {
        id,
        filePath,
        fileName: filePath.split('/').pop()!,
        content: '',
        savedContent: '',
        isDirty: false,
        isReadOnly: false,
        isPreview: false,
      },
    ],
  })
  useSessionStore.setState({ fileEditorStates: states })
  return id
}

function wrapOf(dir: string, fileId: string): boolean | undefined {
  return useSessionStore
    .getState()
    .fileEditorStates.get(dir)!
    .files.find((f) => f.id === fileId)!.wordWrap
}

describe('toggleEditorWordWrap', () => {
  beforeEach(() => {
    useSessionStore.setState({ fileEditorStates: new Map() })
  })

  it('first toggle flips away from the preference default, then alternates', () => {
    usePreferencesStore.setState({ editorWordWrap: true })
    const id = seedFileTab('/repo', '/repo/a.ts')
    expect(wrapOf('/repo', id)).toBeUndefined() // follows preference
    useSessionStore.getState().toggleEditorWordWrap('/repo', id)
    expect(wrapOf('/repo', id)).toBe(false) // away from true
    useSessionStore.getState().toggleEditorWordWrap('/repo', id)
    expect(wrapOf('/repo', id)).toBe(true)
  })

  it('preference false → first toggle turns wrap ON for that tab only', () => {
    usePreferencesStore.setState({ editorWordWrap: false })
    const a = seedFileTab('/repo', '/repo/a.ts')
    useSessionStore.getState().toggleEditorWordWrap('/repo', a)
    expect(wrapOf('/repo', a)).toBe(true)
    // The preference is untouched.
    expect(usePreferencesStore.getState().editorWordWrap).toBe(false)
  })

  it('unknown dir is a no-op', () => {
    expect(() => useSessionStore.getState().toggleEditorWordWrap('/nope', 'x')).not.toThrow()
  })
})
