// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Boot restoration must adopt each tab's persisted id, never mint a new one.
 *
 * A restored tab is the SAME tab. Its id is the key for per-conversation state
 * that lives outside `tabs.json` — the Studio Surface stores browser tabs,
 * terminals, and open files per conversation id, and the engine binds its
 * conversation to the same key.
 *
 * Restoring under a fresh id silently orphans all of it. On a real machine that
 * left 579 stored Surface records against 37 live tabs, only 18 of which
 * matched, and a browser tab the operator left open was simply gone on the next
 * launch. Nothing failed loudly; the state was written correctly and then
 * looked up under a key that no longer existed.
 *
 * Structural because the failure mode is a restore branch being FORGOTTEN. The
 * extension branch already adopted correctly while three others did not, so a
 * behavioural test would only have covered whichever branch someone remembered.
 */
const RESTORE = 'src/renderer/hooks/useTabRestoration.ts'

function read(relative: string): string {
  return readFileSync(join(process.cwd(), relative), 'utf8')
}

describe('tab identity survives a restart', () => {
  it('never mints a fresh id in the restore loop', () => {
    const source = read(RESTORE)
    // Bounded to the loop itself. The only legitimate createTab in this file
    // is the no-saved-tabs fallback further down, where there is no persisted
    // identity to preserve.
    const start = source.indexOf('for (let i = 0; i < saved.tabs.length; i++)')
    const end = source.indexOf('// Restore expanded/collapsed state')
    const body = source.slice(start, end)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    // `createTab()` mints a new UUID. A call inside the loop is a tab whose
    // identity was just thrown away.
    expect(body).not.toContain('window.ion.createTab()')
  })

  it('adopts the persisted id on the skeleton branch', () => {
    // The common case: every non-active conversation tab.
    expect(read(RESTORE)).toContain('window.ion.adoptTab(persistedId)')
  })

  it('passes the persisted id through resumeSession for the active tab', () => {
    // resumeSession is shared with the History Picker, which legitimately
    // opens a NEW tab, so the id is a parameter rather than a default.
    const source = read(RESTORE)
    expect(source).toMatch(/resumeSession\([\s\S]{0,400}st\.id \|\| undefined,/)
  })

  it('passes the persisted id through createTerminalTab', () => {
    expect(read(RESTORE)).toContain('createTerminalTab(undefined, st.id || undefined)')
  })

  it('keeps reusing the persisted id on the extension branch', () => {
    // This branch was already correct; pinning it stops a later edit from
    // regressing the one path that had it right.
    expect(read('src/renderer/hooks/useTabRestoration-engine.ts')).toContain('reuseTabId: st.id')
  })
})

describe('adoption falls back without changing identity', () => {
  it('reuses the persisted id when the adopt IPC fails', () => {
    const source = read(RESTORE)
    // A transient IPC failure is no reason to change a tab's identity; the
    // old code fell back to crypto.randomUUID() and orphaned the tab anyway.
    const from = source.indexOf('let tabId: string', source.indexOf('const persistedId'))
    const branch = source.slice(from, from + 220)
    expect(from).toBeGreaterThan(0)
    expect(branch).toContain('tabId = persistedId')
    // The catch must not mint. `crypto.randomUUID()` is legitimate one line
    // above, for a legacy record that never had an id, so the window starts
    // after it.
    expect(branch).not.toContain('crypto.randomUUID()')
  })

  it('mints only for a legacy record that has no id', () => {
    // Records saved before ids were persisted have no prior identity to keep,
    // so a fresh id is correct there and nowhere else.
    expect(read(RESTORE)).toContain('const persistedId = st.id || crypto.randomUUID()')
  })
})

describe('restore does not fold a tab into another', () => {
  it('skips blank-terminal reuse when restoring', () => {
    // Reusing an existing blank terminal during restore would merge two
    // distinct tabs and drop everything keyed by the id being restored.
    expect(read('src/renderer/stores/slices/terminal-slice.ts'))
      .toContain('adoptTabId ? undefined : get().tabs.find((t) => isReusableBlankTerminalTab(t, startDir))')
  })
})
