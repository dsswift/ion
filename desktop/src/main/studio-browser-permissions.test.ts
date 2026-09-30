import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Deny-by-default page permissions, HTTP auth, and certificate prompts.
 *
 * The session and guest are stand-ins that capture the handlers Electron
 * would call; the decisions and the prompt lifecycle are the real code.
 */
type Handler = (...args: unknown[]) => unknown
const sessions = vi.hoisted(() => new Map<string, { request?: Handler; check?: Handler }>())

vi.mock('electron', () => ({
  session: {
    fromPartition: (partition: string) => {
      const entry = sessions.get(partition) ?? {}
      sessions.set(partition, entry)
      return {
        setPermissionRequestHandler: (fn: Handler) => { entry.request = fn },
        setPermissionCheckHandler: (fn: Handler) => { entry.check = fn },
      }
    },
  },
}))
vi.mock('./logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn() }))

import {
  PermissionDecisions,
  answerBrowserPrompt,
  installBrowserPermissionHandlers,
  installGuestSecurityPrompts,
  pendingBrowserPrompts,
  refuseBrowserPromptsFor,
  setBrowserPromptSender,
  decisions,
} from './studio-browser-permissions'
import type { StudioBrowserPrompt } from '@ion/shared/studio-browser-types'

function fakeGuest(): { contents: object; emit(event: string, ...args: unknown[]): void } {
  const handlers = new Map<string, Handler>()
  const contents = { on: (event: string, fn: Handler) => { handlers.set(event, fn) } }
  return { contents, emit: (event, ...args) => handlers.get(event)?.(...args) }
}

const context = { conversationId: 'c1', instanceId: 'i1', partition: 'persist:studio-browser' }
let sent: StudioBrowserPrompt[]

beforeEach(() => {
  sent = []
  setBrowserPromptSender((prompt) => { sent.push(prompt) })
})

describe('PermissionDecisions', () => {
  it('reuses a decision for the same partition, origin, and permission only', () => {
    const d = new PermissionDecisions()
    d.record('p', 'https://a.example', 'geolocation', true)
    expect(d.decide('p', 'https://a.example', 'geolocation')).toBe(true)
    expect(d.decide('p', 'https://b.example', 'geolocation')).toBeUndefined()
    expect(d.decide('q', 'https://a.example', 'geolocation')).toBeUndefined()
    expect(d.decide('p', 'https://a.example', 'media')).toBeUndefined()
  })

  it('scopes certificate trust to one host and one certificate', () => {
    const d = new PermissionDecisions()
    d.allowCertificate('p', 'a.example', 'AA')
    expect(d.certificateAllowed('p', 'a.example', 'AA')).toBe(true)
    expect(d.certificateAllowed('p', 'b.example', 'AA')).toBe(false)
    expect(d.certificateAllowed('p', 'a.example', 'BB')).toBe(false)
  })
})

describe('permission request handler', () => {
  const partition = `persist:test-${Math.random()}`
  const guest = { id: 1 }
  const outsider = { id: 2 }
  let request: Handler
  let check: Handler

  beforeEach(() => {
    installBrowserPermissionHandlers(partition, (contents) => (contents === guest ? { ...context, partition } : null))
    request = sessions.get(partition)!.request!
    check = sessions.get(partition)!.check!
  })

  it('asks the operator and denies until answered; a grant is then remembered', () => {
    const callback = vi.fn()
    request(guest, 'geolocation', callback, { requestingUrl: 'https://a.example/page' })
    expect(callback).not.toHaveBeenCalled()
    expect(sent.at(-1)).toMatchObject({ kind: 'permission', origin: 'https://a.example', permission: 'geolocation', conversationId: 'c1' })
    expect(check(guest, 'geolocation', 'https://a.example')).toBe(false)

    answerBrowserPrompt({ promptId: sent.at(-1)!.promptId, kind: 'permission', granted: true })
    expect(callback).toHaveBeenCalledWith(true)
    expect(check(guest, 'geolocation', 'https://a.example')).toBe(true)

    const again = vi.fn()
    request(guest, 'geolocation', again, { requestingUrl: 'https://a.example/other' })
    expect(again).toHaveBeenCalledWith(true)
    expect(sent.filter((p) => p.kind === 'permission')).toHaveLength(1)
  })

  it('asks again for a different origin', () => {
    const callback = vi.fn()
    request(guest, 'geolocation', callback, { requestingUrl: 'https://b.example/page' })
    expect(callback).not.toHaveBeenCalled()
    expect(sent.at(-1)).toMatchObject({ origin: 'https://b.example' })
    answerBrowserPrompt({ promptId: sent.at(-1)!.promptId, kind: 'permission', granted: false })
    expect(callback).toHaveBeenCalledWith(false)
  })

  it('denies a WebContents that is not a browser guest, and non-promptable permissions, without asking', () => {
    const callback = vi.fn()
    request(outsider, 'geolocation', callback, { requestingUrl: 'https://a.example/page' })
    expect(callback).toHaveBeenCalledWith(false)
    const usb = vi.fn()
    request(guest, 'usb', usb, { requestingUrl: 'https://a.example/page' })
    expect(usb).toHaveBeenCalledWith(false)
    expect(sent).toHaveLength(0)
  })

  it('carries the media types on a camera or microphone request', () => {
    request(guest, 'media', vi.fn(), { requestingUrl: 'https://c.example/', mediaTypes: ['video'] })
    expect(sent.at(-1)).toMatchObject({ permission: 'media', mediaTypes: ['video'] })
  })
})

describe('guest security prompts', () => {
  it('answers an HTTP login exactly once, with credentials or with a cancel', () => {
    const guest = fakeGuest()
    installGuestSecurityPrompts(guest.contents as never, context)
    const callback = vi.fn()
    const event = { preventDefault: vi.fn() }
    guest.emit('login', event, {}, { isProxy: false, scheme: 'basic', host: 'a.example', port: 443, realm: 'Staff' }, callback)
    expect(event.preventDefault).toHaveBeenCalled()
    const prompt = sent.at(-1)!
    expect(prompt).toMatchObject({ kind: 'auth', host: 'a.example:443', realm: 'Staff' })
    answerBrowserPrompt({ promptId: prompt.promptId, kind: 'auth', username: 'u', password: 'p' })
    answerBrowserPrompt({ promptId: prompt.promptId, kind: 'auth', username: 'u', password: 'p' })
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith('u', 'p')

    const cancelled = vi.fn()
    guest.emit('login', { preventDefault: vi.fn() }, {}, { isProxy: true, scheme: 'basic', host: 'proxy', port: 8080, realm: '' }, cancelled)
    answerBrowserPrompt({ promptId: sent.at(-1)!.promptId, kind: 'auth', cancel: true })
    expect(cancelled).toHaveBeenCalledTimes(1)
    expect(cancelled).toHaveBeenCalledWith()
  })

  it('refuses a bad certificate unless the operator proceeds, then trusts that one host only', () => {
    const guest = fakeGuest()
    installGuestSecurityPrompts(guest.contents as never, context)
    const cert = { fingerprint: 'AA', issuerName: 'Self' }
    const callback = vi.fn()
    guest.emit('certificate-error', { preventDefault: vi.fn() }, 'https://self.example/x', 'net::ERR_CERT_AUTHORITY_INVALID', cert, callback, true)
    expect(callback).not.toHaveBeenCalled()
    expect(sent.at(-1)).toMatchObject({ kind: 'certificate', host: 'self.example', fingerprint: 'AA' })
    answerBrowserPrompt({ promptId: sent.at(-1)!.promptId, kind: 'certificate', proceed: true })
    expect(callback).toHaveBeenCalledWith(true)

    // Same host and certificate: trusted without asking.
    const again = vi.fn()
    const event = { preventDefault: vi.fn() }
    guest.emit('certificate-error', event, 'https://self.example/y', 'net::ERR_CERT_AUTHORITY_INVALID', cert, again, true)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(again).toHaveBeenCalledWith(true)

    // Another host with the same certificate asks again.
    const other = vi.fn()
    guest.emit('certificate-error', { preventDefault: vi.fn() }, 'https://other.example/', 'net::ERR_CERT_COMMON_NAME_INVALID', cert, other, true)
    expect(other).not.toHaveBeenCalled()
    answerBrowserPrompt({ promptId: sent.at(-1)!.promptId, kind: 'certificate', proceed: false })
    expect(other).toHaveBeenCalledWith(false)
    expect(decisions.certificateAllowed(context.partition, 'other.example', 'AA')).toBe(false)

    // A subresource never prompts.
    const sub = vi.fn()
    guest.emit('certificate-error', { preventDefault: vi.fn() }, 'https://cdn.example/a.js', 'net::ERR_CERT_DATE_INVALID', cert, sub, false)
    expect(sub).toHaveBeenCalledWith(false)
  })

  it('lists pending prompts for a document and refuses them when the guest goes away', () => {
    const guest = fakeGuest()
    installGuestSecurityPrompts(guest.contents as never, { ...context, instanceId: 'gone' })
    const callback = vi.fn()
    guest.emit('login', { preventDefault: vi.fn() }, {}, { isProxy: false, scheme: 'basic', host: 'a', port: 80, realm: '' }, callback)
    expect(pendingBrowserPrompts('c1', 'gone')).toHaveLength(1)
    refuseBrowserPromptsFor('c1', 'gone')
    expect(pendingBrowserPrompts('c1', 'gone')).toHaveLength(0)
    expect(callback).toHaveBeenCalledWith()
    expect(answerBrowserPrompt({ promptId: 'browser-prompt-nope', kind: 'auth', cancel: true })).toBe(false)
  })
})
