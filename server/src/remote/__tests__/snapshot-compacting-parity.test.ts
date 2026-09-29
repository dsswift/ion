/**
 * iOS parity: the live "Compacting…" indicator must reach iOS via the
 * snapshot projection, the same way `inputLocked` and `status` already do.
 *
 * Before this fix, iOS had no way to know a compaction was running: its send
 * button stayed enabled, and a prompt submitted during one vanished once the
 * desktop's authoritative guard refused it. There was no wire field to check.
 */

import { describe, it, expect } from 'vitest'
import { projectRendererTab } from '../snapshot-project'

const BASE = { lastMessage: null, permissionQueue: [] }

describe('projectRendererTab projects isCompacting for iOS', () => {
  it('projects true while the conversation is being compacted', () => {
    const result = projectRendererTab(
      { id: 't1', title: 'T', status: 'idle', engineProfileId: null, isCompacting: true },
      BASE,
    )
    expect(result.isCompacting).toBe(true)
  })

  it('omits the field when not compacting, matching every other transient flag', () => {
    const result = projectRendererTab(
      { id: 't1', title: 'T', status: 'idle', engineProfileId: null, isCompacting: false },
      BASE,
    )
    expect(result.isCompacting).toBeUndefined()
  })

  it('defaults to omitted when isCompacting is absent from the input', () => {
    const result = projectRendererTab(
      { id: 't1', title: 'T', status: 'idle', engineProfileId: null },
      BASE,
    )
    expect(result.isCompacting).toBeUndefined()
  })
})
