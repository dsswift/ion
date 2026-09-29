import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TextSearchResult } from '@ion/shared/text-search'

const searchText = vi.fn<(request: unknown) => Promise<TextSearchResult>>()
vi.mock('../../../host/host-instance', () => ({ host: { shell: { searchText: (request: unknown) => searchText(request) } } }))
vi.mock('../../../rendererLogger', () => ({ rDebug: vi.fn(), rWarn: vi.fn() }))

const { useWorkspaceSearchStore } = await import('../workspace-search-store')

function result(path: string): TextSearchResult {
  return {
    files: [{ root: '/repo', path: `/repo/${path}`, relativePath: path, matches: [{ line: 1, column: 1, length: 3, preview: 'foo', ranges: [[0, 3]] }] }],
    totalMatches: 1,
    truncated: false,
  }
}

describe('workspace search store', () => {
  beforeEach(() => {
    searchText.mockReset()
    useWorkspaceSearchStore.setState({ query: '', caseSensitive: false, wholeWord: false, status: 'idle', result: null, collapsed: new Set() })
  })

  it('sends the query and options for every root', async () => {
    searchText.mockResolvedValue(result('a.ts'))
    useWorkspaceSearchStore.setState({ query: 'foo', caseSensitive: true })
    await useWorkspaceSearchStore.getState().run(['/repo', '/extra'])
    expect(searchText).toHaveBeenCalledWith({ roots: ['/repo', '/extra'], query: 'foo', caseSensitive: true, wholeWord: false })
    expect(useWorkspaceSearchStore.getState().result?.files[0].relativePath).toBe('a.ts')
  })

  it('never lets a slow earlier answer replace a newer one', async () => {
    let answerFirst: (value: TextSearchResult) => void = () => undefined
    searchText
      .mockImplementationOnce(() => new Promise((resolve) => { answerFirst = resolve }))
      .mockResolvedValueOnce(result('new.ts'))
    useWorkspaceSearchStore.setState({ query: 'fo' })
    const first = useWorkspaceSearchStore.getState().run(['/repo'])
    useWorkspaceSearchStore.setState({ query: 'foo' })
    await useWorkspaceSearchStore.getState().run(['/repo'])
    answerFirst(result('old.ts'))
    await first
    expect(useWorkspaceSearchStore.getState().result?.files[0].relativePath).toBe('new.ts')
  })

  it('clears the result for an empty query without asking the server', async () => {
    useWorkspaceSearchStore.setState({ result: result('a.ts'), status: 'done' })
    await useWorkspaceSearchStore.getState().run(['/repo'])
    expect(searchText).not.toHaveBeenCalled()
    expect(useWorkspaceSearchStore.getState()).toMatchObject({ result: null, status: 'idle' })
  })

  it('folds and unfolds every file group', () => {
    useWorkspaceSearchStore.setState({ result: result('a.ts') })
    useWorkspaceSearchStore.getState().setAllCollapsed(true)
    expect([...useWorkspaceSearchStore.getState().collapsed]).toEqual(['/repo/a.ts'])
    useWorkspaceSearchStore.getState().toggleCollapsed('/repo/a.ts')
    expect(useWorkspaceSearchStore.getState().collapsed.size).toBe(0)
  })
})
