/**
 * Structural guard: no renderer path may force-remove a worktree.
 *
 * `closeTab` and `setBaseDirectory` both used to call
 * `gitWorktreeRemove(..., force = true)`, which destroyed uncommitted changes
 * and (via the handler's `branch -D`) made unlanded commits unreachable.
 *
 * A behavioural test on the store would need the whole tab/pane/IPC harness
 * mocked, and would still only cover the paths it happened to exercise. This
 * asserts the property directly against the source: the destructive call is not
 * reachable from these slices at all. It fails against either old
 * implementation, and it keeps failing if someone reintroduces the call in a
 * new code path.
 *
 * Worktree removal lives behind the explicit Retire verb
 * (`main/worktree/relocate.ts`), which appraises what would be lost first.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const SLICES = join(__dirname, '..', '..', 'renderer', 'stores', 'slices')

function source(file: string): string {
  return readFileSync(join(SLICES, file), 'utf-8')
}

/**
 * Strip comments before scanning. The point is that no code CALLS the
 * destructive removal — prose explaining why it was removed must not trip the
 * guard, or the fix would have to be undocumented to stay green.
 */
function code(file: string): string {
  return source(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

describe('renderer never force-removes a worktree', () => {
  // The two paths that carried the defect. Closing a conversation and changing
  // a directory are both routine, reversible actions; neither is a request to
  // destroy a working directory.
  it.each(['tab-slice.ts', 'directory-slice.ts'])('%s does not call gitWorktreeRemove', (file) => {
    expect(code(file)).not.toContain('gitWorktreeRemove')
  })

  it('no renderer slice calls gitWorktreeRemove', () => {
    const { readdirSync } = require('fs') as typeof import('fs')
    const offenders = readdirSync(SLICES)
      .filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
      .filter((f) => code(f).includes('gitWorktreeRemove'))

    expect(offenders).toEqual([])
  })

  // The preserved-worktree decision must be logged: an operator who closed a
  // tab needs to be able to find where the worktree went from the logs alone.
  it('logs that the worktree was preserved on close', () => {
    const s = source('tab-slice.ts')
    expect(s).toContain('worktree preserved')
    expect(s).toMatch(/worktree_path/)
  })

  it('logs that the worktree was preserved on a base-directory change', () => {
    const s = source('directory-slice.ts')
    expect(s).toContain('worktree preserved')
  })

  // Pins the reasoning, so a future reader does not "restore" the cleanup as an
  // apparent oversight.
  it('records why close no longer removes the worktree', () => {
    expect(source('tab-slice.ts')).toMatch(/never removes its worktree/i)
  })
})
