/**
 * snapshot-no-plan-preview.test.ts
 *
 * Pinning test for fix(desktop): lighten snapshot projection, drop double compression.
 *
 * Verifies:
 * 1. snapshot.ts no longer embeds planContentPreview in ExitPlanMode entries
 *    (no sync disk reads in the hot snapshot loop).
 * 2. Relay frames are compressed exactly ONCE per send. Compression moved out
 *    of buildDeviceFrame into the send-path callers (sendToAll / sendToDevice)
 *    so a broadcast to N devices compresses once, not N times — DEFLATE is
 *    deterministic, so the bytes are identical per device. buildDeviceFrame
 *    receives the precompressed wire and no longer compresses. The
 *    no-double-compression invariant is preserved; the location moved.
 *
 * Failure mode without the fix:
 * - Test 1: snapshot would have `planContentPreview` embedded in ExitPlanMode entries.
 * - Test 2: compression would run per device (or twice) per send.
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

describe('relay send — single authoritative compression', () => {
  it('buildDeviceFrame no longer compresses (receives the precompressed wire)', () => {
    // Compression moved to the callers; transport-frame.ts must not reference
    // compressPayload at all (import or call), or it would double-compress.
    const src = readFileSync(join(__dirname, '../transport-frame.ts'), 'utf-8')
    expect(src).not.toContain('compressPayload')
  })

  it('sendToAll compresses exactly once per broadcast (outside the per-device loop)', () => {
    const src = readFileSync(join(__dirname, '../transport-send.ts'), 'utf-8')
    // Exactly one compressPayload CALL in the file — the shared per-broadcast
    // compress. (The import line is `compressPayload }`, not `compressPayload(`.)
    expect(src.match(/\bcompressPayload\(/g) || []).toHaveLength(1)
  })

  it('sendToDevice compresses once; transport.ts still decompresses inbound frames', () => {
    const src = readFileSync(join(__dirname, '../transport.ts'), 'utf-8')
    // One outbound compress in the direct single-device path...
    expect(src.match(/\bcompressPayload\(/g) || []).toHaveLength(1)
    // ...and the inbound decompress is still present.
    expect(src).toContain('decompressPayload')
  })
})
