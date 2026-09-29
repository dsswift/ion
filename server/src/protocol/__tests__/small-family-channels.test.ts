/**
 * The channels the graph-view and backup action families publish on are on
 * the wire contract, so `broadcast()` fans them out instead of dropping
 * them as off-contract.
 */
import { describe, expect, it } from 'vitest'
import { EVENT_CHANNELS } from '@ion/shared/studio-wire/channels'

describe('graph view and backup channels', () => {
  it.each(['ion:graph-corpus-delta', 'ion:graph-view-config-changed', 'ion:conversation-backup-progress'])('%s is registered environment-wide', (name) => {
    expect(EVENT_CHANNELS.find((c) => c.name === name)).toEqual({ name, scope: 'environment' })
  })
})
