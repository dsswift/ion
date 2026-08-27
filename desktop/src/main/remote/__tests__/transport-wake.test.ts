import { describe, expect, it, vi } from 'vitest'
import { renewRelaysAfterWake } from '../transport-wake'

describe('renewRelaysAfterWake', () => {
  it('renews relay sockets once when a transport exists', () => {
    const reconnectRelays = vi.fn()
    const log = vi.fn()

    renewRelaysAfterWake({ transport: { reconnectRelays } as never, log })

    expect(reconnectRelays).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith('remote_transport: relay sockets renewed after system wake')
  })

  it('does not attempt renewal without a transport', () => {
    const log = vi.fn()

    renewRelaysAfterWake({ transport: null, log })

    expect(log).toHaveBeenCalledWith('remote_transport: wake relay renewal skipped, no transport')
  })
})
