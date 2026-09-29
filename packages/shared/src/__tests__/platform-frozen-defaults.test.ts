import { describe, it, expect } from 'vitest'
import { sanitizeExplorerState } from '../explorer-state'
import { resolveProjectDir } from '../project-workspace'
import { isAbsolutePath } from '../paths'

// A class of defect found by running Ion on Windows for the first time: not
// Windows-specific logic gone wrong, but a macOS assumption frozen into a
// default or a validator. It works perfectly on the machine it was written on
// and fails silently everywhere else.
//
// Two shipped instances: a `startsWith('/')` path check that rejected every
// Windows path (twelve IPC surfaces returned empty), and a Menlo-only font
// stack that made xterm measure a proportional fallback and wrap at a third
// of the pane. These pin the remaining path validators found in the sweep.
describe('platform-frozen path assumptions', () => {
  const windowsPaths = ['C:\\Users\\josh', 'C:/Users/josh', '\\\\server\\share\\dir']
  const posixPaths = ['/Users/josh', '/home/josh', '/']

  it.each([...windowsPaths, ...posixPaths])('isAbsolutePath accepts %s', (p) => {
    expect(isAbsolutePath(p)).toBe(true)
  })

  // resolveProjectDir returned a Windows directory unchanged before consulting
  // any worktree or bench, so worktree-aware behaviour was dead on Windows.
  it.each(windowsPaths)('resolveProjectDir consults worktrees for %s', (dir) => {
    const sources = {
      worktrees: [{ repoPath: 'C:\\repo', worktreePath: dir }],
      benches: [],
      projects: [],
    }
    // A Windows dir that IS a registered worktree must resolve to its repo,
    // not be handed back untouched. normalizeWorkspacePath only trims a
    // trailing slash, so the repo path returns exactly as registered.
    expect(resolveProjectDir(dir, null, sources)).toBe('C:\\repo')
  })

  // A relative or placeholder value has no repo to match and is returned as-is
  // on every platform -- widening "absolute" must not change that.
  it.each(['~', 'relative/dir', './here'])('resolveProjectDir passes through %s', (dir) => {
    const sources = { worktrees: [], benches: [], projects: [] }
    expect(resolveProjectDir(dir, null, sources)).toBe(dir)
  })
})

// The explorer persists expansion keyed by absolute root dir. Its own comment
// said it matched isValidProjectPath, but it tested startsWith('/') -- so
// every persisted Windows root was silently dropped on restore, which is a
// second reason the explorer came up empty on that platform.
describe('explorer state restores windows roots', () => {
  // A root with an EMPTY expansion list is dropped by design on every
  // platform (nothing to remember), so the fixture gives each root a real
  // expanded child. That distinction is what the first version of this test
  // got wrong -- it read a by-design drop as a platform bug.
  const keep = (root: string) =>
    sanitizeExplorerState({
      version: 1,
      expanded: { [root]: [root] },
      collapsedRoots: [root],
    })

  it.each(['C:\\Users\\josh', 'C:/Users/josh', '\\\\server\\share'])(
    'keeps the persisted root %s',
    (root) => {
      expect(Object.keys(keep(root).expanded)).toContain(root)
      expect(keep(root).collapsedRoots).toContain(root)
    },
  )

  it.each(['/Users/josh', '/home/josh'])('keeps the persisted root %s', (root) => {
    expect(Object.keys(keep(root).expanded)).toContain(root)
  })

  // Sanitising still has a job: a relative path, or one carrying control
  // characters, is not a usable filesystem key on any platform.
  it.each(['relative/dir', '/tmp/a\u0000b', 'C:\\tmp\\a\nb'])('drops %s', (root) => {
    expect(Object.keys(keep(root).expanded)).not.toContain(root)
  })
})
