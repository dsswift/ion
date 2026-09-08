// @vitest-environment jsdom
/**
 * The editor anchor is what makes Graph View's neighborhood opening scope
 * reachable. It records the last FILE tab activated in a conversation, so
 * opening the graph afterwards can ask what the operator was reading.
 *
 * The bug this fixes: the graph used to read the CURRENTLY active tab, but
 * opening the graph makes the graph active, so the answer was always "not a
 * file" and the scope silently fell back to the whole corpus on every
 * launch.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { recordTabActivation, lastEditorFilePath, forgetAnchorIfGone, clearAllAnchors } from './editor-anchor'
import type { SurfaceTab } from '../../../shared/studio-surface-types'

function fileTab(id: string, filePath: string): SurfaceTab {
  return { kind: 'file', id, filePath, dir: '/repo', tabId: 'conv-1' } as SurfaceTab
}

const graphTab: SurfaceTab = { kind: 'singleton', id: 'graph' }
const gitTab: SurfaceTab = { kind: 'singleton', id: 'gitpanel' }

beforeEach(() => {
  clearAllAnchors()
})

describe('recording the anchor', () => {
  it('a file activation is remembered for that conversation', () => {
    recordTabActivation('conv-1', fileTab('f1', '/repo/a.md'))
    expect(lastEditorFilePath('conv-1')).toBe('/repo/a.md')
  })

  it('activating the graph does NOT clear the anchor — the whole point', () => {
    recordTabActivation('conv-1', fileTab('f1', '/repo/a.md'))
    recordTabActivation('conv-1', graphTab)
    expect(lastEditorFilePath('conv-1')).toBe('/repo/a.md')
  })

  it('a non-file singleton leaves the anchor alone', () => {
    recordTabActivation('conv-1', fileTab('f1', '/repo/a.md'))
    recordTabActivation('conv-1', gitTab)
    expect(lastEditorFilePath('conv-1')).toBe('/repo/a.md')
  })

  it('a later file activation replaces the earlier one', () => {
    recordTabActivation('conv-1', fileTab('f1', '/repo/a.md'))
    recordTabActivation('conv-1', fileTab('f2', '/repo/b.md'))
    expect(lastEditorFilePath('conv-1')).toBe('/repo/b.md')
  })

  it('anchors are per conversation, never shared', () => {
    recordTabActivation('conv-1', fileTab('f1', '/repo/a.md'))
    recordTabActivation('conv-2', fileTab('f2', '/repo/b.md'))
    expect(lastEditorFilePath('conv-1')).toBe('/repo/a.md')
    expect(lastEditorFilePath('conv-2')).toBe('/repo/b.md')
  })

  it('a conversation that never opened a file has no anchor', () => {
    recordTabActivation('conv-1', graphTab)
    expect(lastEditorFilePath('conv-1')).toBeNull()
  })

  it('a null conversation id records nothing rather than throwing', () => {
    recordTabActivation(null, fileTab('f1', '/repo/a.md'))
    expect(lastEditorFilePath(null)).toBeNull()
  })
})

describe('forgetting the anchor when its file closes', () => {
  it('drops the anchor when no remaining tab shows that file', () => {
    recordTabActivation('conv-1', fileTab('f1', '/repo/a.md'))
    forgetAnchorIfGone('conv-1', [graphTab])
    expect(lastEditorFilePath('conv-1')).toBeNull()
  })

  it('keeps the anchor when another tab still shows the same file', () => {
    recordTabActivation('conv-1', fileTab('f1', '/repo/a.md'))
    forgetAnchorIfGone('conv-1', [fileTab('f2', '/repo/a.md'), graphTab])
    expect(lastEditorFilePath('conv-1')).toBe('/repo/a.md')
  })

  it('closing an unrelated file leaves the anchor intact', () => {
    recordTabActivation('conv-1', fileTab('f1', '/repo/a.md'))
    forgetAnchorIfGone('conv-1', [fileTab('f1', '/repo/a.md')])
    expect(lastEditorFilePath('conv-1')).toBe('/repo/a.md')
  })

  it('forgetting one conversation does not touch another', () => {
    recordTabActivation('conv-1', fileTab('f1', '/repo/a.md'))
    recordTabActivation('conv-2', fileTab('f2', '/repo/a.md'))
    forgetAnchorIfGone('conv-1', [])
    expect(lastEditorFilePath('conv-1')).toBeNull()
    expect(lastEditorFilePath('conv-2')).toBe('/repo/a.md')
  })
})
