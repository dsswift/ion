// @vitest-environment jsdom
/**
 * The Pair a phone side panel: the code and the QR code it offers, the
 * discovery window it opens and closes, and how it finishes.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const client = vi.hoisted(() => ({ listClients: vi.fn(), mintPairingLink: vi.fn(), listOwnDevices: vi.fn(), mintOwnPairingLink: vi.fn(), discoveryStatus: vi.fn(), discoveryOpen: vi.fn(), discoveryClose: vi.fn(), discoveryMintCode: vi.fn() }))
const listeners = vi.hoisted(() => [] as Array<{ channel: string; cb: () => void }>)
const fire = (channel: string): void => { for (const entry of [...listeners]) if (entry.channel === channel) entry.cb() }
vi.mock('../../environment/environment-client', () => ({
  environmentClient: client,
  onEnvironmentEvent: (_env: string, channel: string, cb: () => void) => {
    const entry = { channel, cb }
    listeners.push(entry)
    return () => { listeners.splice(listeners.indexOf(entry), 1) }
  },
}))
vi.mock('../../../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000' }) }))
vi.mock('../../../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn() }))
const qr = vi.hoisted(() => ({ qrSvgDataUrl: vi.fn((text: string) => `data:qr,${text}`) }))
vi.mock('../../environment/pairing-qr', () => qr)

const { PairPhonePanel } = await import('../access/PairPhonePanel')
const { ADMIN_PAIRING, OWN_PAIRING } = await import('../access/pairing-access')

const LINK = 'ion-studio://pair?code=abc&url=http%3A%2F%2Fstudio.local%3A7421&env=Studio'
const DESKTOP = { clientId: 'desk-1', kind: 'desktop', scopes: ['admin'], revokedAt: null }
const PHONE = { clientId: 'phone-1', kind: 'mobile', scopes: ['conversations:read', 'conversations:operate', 'git:write', 'terminal:operate', 'admin'], revokedAt: null }

describe('PairPhonePanel', () => {
  let container: HTMLDivElement
  let root: Root
  let onClose: ReturnType<typeof vi.fn<(outcome: string) => void>>
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    for (const fn of Object.values(client)) fn.mockReset()
    qr.qrSvgDataUrl.mockClear()
    listeners.length = 0
    onClose = vi.fn<(outcome: string) => void>()
    client.listClients.mockResolvedValue([DESKTOP])
    client.mintPairingLink.mockResolvedValue({ url: LINK, code: 'abc', expiresAt: 1_000_000 + 300_000 })
    client.discoveryStatus.mockResolvedValue({ mode: 'off', advertising: false, until: null, code: null })
    client.discoveryOpen.mockResolvedValue({ mode: 'window', advertising: true, until: 1_000_000 + 900_000, code: 'ABCD-EFGH' })
    client.discoveryClose.mockResolvedValue({ mode: 'off', advertising: false, until: null, code: null })
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  })
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers() })
  const mount = async (access = ADMIN_PAIRING): Promise<void> => { await act(async () => { root.render(<PairPhonePanel environmentId="env-1" environmentLabel="Studio" access={access} onClose={onClose} />); await vi.advanceTimersByTimeAsync(0) }) }
  const text = (id: string): string | null | undefined => container.querySelector(`[data-testid="${id}"]`)?.textContent
  const button = (label: string): HTMLButtonElement => [...container.querySelectorAll('button')].find((b) => b.textContent === label || b.getAttribute('aria-label') === label) as HTMLButtonElement

  it('shows the eight-character code and a 148px QR code whose text is the pairing link, with the expiry', async () => {
    await mount()
    expect(client.mintPairingLink).toHaveBeenCalledWith('env-1', 'Phone')
    expect(client.discoveryOpen).toHaveBeenCalledWith('env-1', 15)
    expect(text('pair-phone-code')).toBe('ABCD-EFGH')
    expect(qr.qrSvgDataUrl).toHaveBeenCalledWith(LINK)
    const img = container.querySelector('[data-testid="pair-phone-qr"]')
    expect(img?.getAttribute('src')).toBe(`data:qr,${LINK}`)
    expect(img?.getAttribute('width')).toBe('148')
    expect(text('pair-phone-expiry')).toContain('Expires in 5:00')
  })

  it('counts the expiry down every second', async () => {
    await mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(text('pair-phone-expiry')).toContain('Expires in 4:57')
  })

  it('asks for no scopes, so the phone gets the server\'s pairing defaults', async () => {
    await mount()
    expect(client.mintPairingLink.mock.calls[0]).toHaveLength(2)
  })

  it('reuses the code of a discovery window that is already open and leaves that window alone on Cancel', async () => {
    client.discoveryStatus.mockResolvedValue({ mode: 'window', advertising: true, until: 1_000_000 + 600_000, code: 'WXYZ-2345' })
    await mount()
    expect(text('pair-phone-code')).toBe('WXYZ-2345')
    expect(client.discoveryOpen).not.toHaveBeenCalled()
    await act(async () => { button('Cancel').click() })
    expect(onClose).toHaveBeenCalledWith('cancelled')
    expect(client.discoveryClose).not.toHaveBeenCalled()
  })

  it('closing the panel is a cancel that shuts the window it opened', async () => {
    await mount()
    await act(async () => { button('Close panel').click() })
    expect(onClose).toHaveBeenCalledExactlyOnceWith('cancelled')
    expect(client.discoveryClose).toHaveBeenCalledExactlyOnceWith('env-1')
  })

  it('offers the QR code alone when LAN discovery is sealed', async () => {
    client.discoveryStatus.mockResolvedValue({ mode: 'sealed', advertising: false, until: null, code: null })
    await mount()
    expect(container.querySelector('[data-testid="pair-phone-code"]')).toBeNull()
    expect(container.querySelector('[data-testid="pair-phone-qr"]')).not.toBeNull()
    expect(client.discoveryOpen).not.toHaveBeenCalled()
  })

  it('closes itself as paired when the server says its clients changed, and shuts the window it opened', async () => {
    await mount()
    client.listClients.mockResolvedValue([DESKTOP, PHONE])
    // No poll: time alone must not re-list. Only the server's signal does.
    const listsBefore = client.listClients.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(client.listClients.mock.calls.length).toBe(listsBefore)
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => { fire('ion:clients-changed'); await vi.advanceTimersByTimeAsync(0) })
    expect(onClose).toHaveBeenCalledExactlyOnceWith('paired')
    expect(client.discoveryClose).toHaveBeenCalledWith('env-1')
  })

  it('closes a discovery window it opened when it is unmounted without finishing', async () => {
    await mount()
    expect(client.discoveryClose).not.toHaveBeenCalled()
    await act(async () => { root.unmount(); await vi.advanceTimersByTimeAsync(0) })
    expect(client.discoveryClose).toHaveBeenCalledExactlyOnceWith('env-1')
    expect(onClose).not.toHaveBeenCalled()
    root = createRoot(container)
  })

  it('re-lists at once when the server announces a discovery change', async () => {
    await mount()
    client.listClients.mockResolvedValue([DESKTOP, PHONE])
    await act(async () => { fire('ion:discovery'); await vi.advanceTimersByTimeAsync(0) })
    expect(onClose).toHaveBeenCalledWith('paired')
  })

  it('stays open while the pairings are unchanged, then closes itself as expired when the link ends', async () => {
    await mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(299_000) })
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(onClose).toHaveBeenCalledExactlyOnceWith('expired')
  })

  it('says why when the server refuses to mint a pairing', async () => {
    client.mintPairingLink.mockRejectedValue(new Error('requested scopes exceed your granted scopes'))
    await mount()
    expect(container.textContent).toContain('requested scopes exceed your granted scopes')
    expect(container.querySelector('[data-testid="pair-phone-qr"]')).toBeNull()
  })

  describe('without admin, pairing the person\'s own phone', () => {
    const OWN_PHONE = { clientId: 'phone-9', label: 'Phone', kind: 'mobile', pairedAt: 1, lastSeen: 1, connected: true, connectedAt: 1, admin: false, self: false }
    beforeEach(() => {
      client.listOwnDevices.mockResolvedValue([])
      client.mintOwnPairingLink.mockResolvedValue({ url: LINK, code: 'abc', expiresAt: 1_000_000 + 300_000 })
    })

    it('mints through the non-admin action and offers the QR code alone, touching no admin action', async () => {
      await mount(OWN_PAIRING)
      expect(client.mintOwnPairingLink).toHaveBeenCalledWith('env-1', 'Phone')
      expect(qr.qrSvgDataUrl).toHaveBeenCalledWith(LINK)
      expect(container.querySelector('[data-testid="pair-phone-code"]')).toBeNull()
      expect(container.textContent).toContain('The phone will act as you on this server.')
      for (const adminOnly of [client.mintPairingLink, client.listClients, client.discoveryStatus, client.discoveryOpen]) expect(adminOnly).not.toHaveBeenCalled()
    })

    it('closes itself as paired when a new device of the person\'s own appears', async () => {
      await mount(OWN_PAIRING)
      client.listOwnDevices.mockResolvedValue([OWN_PHONE])
      await act(async () => { fire('ion:clients-changed'); await vi.advanceTimersByTimeAsync(0) })
      expect(onClose).toHaveBeenCalledExactlyOnceWith('paired')
      expect(client.discoveryClose).not.toHaveBeenCalled()
    })
  })
})
