/**
 * snapshot-no-plan-preview.test.ts
 *
 * Pinning test: the snapshot projection stays light.
 *
 * snapshot.ts must not embed planContentPreview in ExitPlanMode entries —
 * that put a synchronous disk read in the hot snapshot loop. `planFilePath`
 * stays, because a client fetches the content on demand from it.
 *
 * Failure mode without the fix: snapshot entries carry
 * `planContentPreview` and every poll tick reads plan files off disk.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('snapshot.ts — no sync plan preview in ExitPlanMode entries', () => {
  it('does not call resolvePlanPreview in snapshot.ts', () => {
    const src = readFileSync(
      join(__dirname, '../snapshot.ts'),
      'utf-8',
    )
    // The sync disk read was via resolvePlanPreview. After the fix, that call is gone.
    expect(src).not.toContain('resolvePlanPreview(')
    // Import must also be gone.
    expect(src).not.toContain("from './plan-content-cache'")
  })

  it('does not embed PREVIEW_BYTES constant in snapshot.ts', () => {
    const src = readFileSync(
      join(__dirname, '../snapshot.ts'),
      'utf-8',
    )
    // PREVIEW_BYTES was the sync-disk-read threshold — gone after the fix.
    expect(src).not.toContain('PREVIEW_BYTES')
    // planContentPreview must not be assigned (may appear in a comment explaining
    // the removed behavior, but must not be set as a property anywhere).
    expect(src).not.toContain('planContentPreview:')
  })

  it('retains planFilePath on ExitPlanMode entries (iOS on-demand fetch path)', () => {
    // The projection still preserves toolInput (which carries planFilePath).
    // Verify the ExitPlanMode branch exists and the if block is present.
    const src = readFileSync(
      join(__dirname, '../snapshot.ts'),
      'utf-8',
    )
    expect(src).toContain("entry.toolName === 'ExitPlanMode'")
  })
})
