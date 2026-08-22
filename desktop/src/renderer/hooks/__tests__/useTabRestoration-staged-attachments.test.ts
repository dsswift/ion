/**
 * useTabRestoration — the staged tray restores wherever the draft does.
 *
 * The persistence side of this pairing is pinned behaviorally in
 * stores/__tests__/staged-attachments.test.ts (persistTabs is reachable through
 * setupPersistence's subscriber). The RESTORE side is not: it lives in three
 * inline tab literals inside one 600-line bootstrap effect that awaits IPC,
 * starts engine sessions, and loads history — there is no seam to call it at.
 *
 * So this pins the invariant structurally instead of leaving it unpinned:
 * unsent composition is text + attachments, and every restore path that hands
 * `queuedPrompts` back to a tab must hand `attachments` back too. Deleting one
 * of the three `attachments: st.attachments ?? []` lines re-creates the exact
 * defect (the draft returns, the images do not) and turns this red.
 *
 * If the three literals are ever consolidated into one helper, replace this
 * with a direct call test on that helper — a real seam beats a source scan.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = readFileSync(join(__dirname, '..', 'useTabRestoration.ts'), 'utf8')

describe('useTabRestoration — staged attachments restore with the draft', () => {
  it('restores attachments at every site that restores queuedPrompts', () => {
    const queued = SOURCE.match(/queuedPrompts: st\.queuedPrompts\?\./g) ?? []
    const staged = SOURCE.match(/attachments: st\.attachments \?\? \[\]/g) ?? []

    expect(queued.length).toBeGreaterThan(0)
    expect(staged.length).toBe(queued.length)
  })

  it('kicks off preview rehydration after the restore loop', () => {
    // Persistence strips `dataUrl`; without this call a restored tray renders
    // every image as a nameless placeholder for the rest of the session.
    expect(SOURCE).toContain('rehydrateAttachmentPreviews()')
  })
})
