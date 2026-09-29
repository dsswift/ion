/**
 * discovery/window — when this server is discoverable on the LAN, and the
 * one-time code a person types to pair with it.
 *
 * Off by default. Three ways to be on, in order of authority:
 *
 *   - SEALED (enterprise): never. `lanDiscoverySealed` wins over everything
 *     below; `open` is refused and a persistent config is ignored.
 *   - PERSISTENT (`server.json.discovery.advertise: true`): announced for as
 *     long as the server runs. The headless setting, changed by redeploying
 *     config. No code is shown anywhere (there is no screen); one is minted
 *     on request (`mintCode`, e.g. `ion studio pair --code`).
 *   - WINDOW (a person at a desktop): announced for a bounded time, then it
 *     shuts itself off. A code is live for the window and shown to the
 *     person who opened it.
 *
 * A code pairs ONE device. After it is used a fresh one replaces it while
 * the window is open, so a second device can pair in the same window. After
 * `MAX_FAILED_ATTEMPTS` wrong codes the live code is burned and replaced:
 * a short code must not be guessable, and rotation makes guessing restart.
 */
import type { Scope } from '@ion/shared/studio-wire/types'
import { lanDiscoverySealed } from '@ion/shared/enterprise-lan-discovery'
import type { EnterprisePolicy } from '@ion/shared/types-enterprise'
import { registerPairingCode, revokePairingCode, onPairingCompleted, onPairingAttemptFailed, type PairingCaller } from '../auth/pairing-links'
import { mintDiscoveryCode, formatDiscoveryCode } from './code'
import type { Advertiser, Advertisement } from './advertiser'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'discovery.window'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export const MAX_FAILED_ATTEMPTS = 5
export const MIN_WINDOW_MINUTES = 1
export const MAX_WINDOW_MINUTES = 60
/** How long a code minted outside a window (persistent mode) stays valid. */
export const STANDALONE_CODE_TTL_MS = 10 * 60 * 1000

export type DiscoveryMode = 'off' | 'window' | 'persistent' | 'sealed'

export interface DiscoveryStatus {
  mode: DiscoveryMode
  advertising: boolean
  /** Unix ms the window closes; null outside a window. */
  until: number | null
  /** The live code, formatted `XXXX-XXXX`; null when none is live. Only ever returned to an admin caller. */
  code: string | null
}

export type DiscoveryRefusal = { code: 'sealed' | 'invalid_args' | 'scope'; message: string }

export interface DiscoveryDeps {
  advertiser: Advertiser
  advertisement: () => Advertisement
  policy: () => Pick<EnterprisePolicy, 'customFields'> | null
  persistent: () => boolean
  defaultScopes: () => Scope[]
  onChange: (status: Omit<DiscoveryStatus, 'code'>) => void
  now?: () => number
}

export class DiscoveryWindow {
  private until: number | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private code: string | null = null
  private codeCaller: PairingCaller | null = null
  private failures = 0
  private readonly off: Array<() => void> = []

  constructor(private readonly deps: DiscoveryDeps) {
    this.off.push(onPairingCompleted(({ code }) => this.onCompleted(code)))
    this.off.push(onPairingAttemptFailed(() => this.onFailed()))
  }

  private now(): number { return this.deps.now?.() ?? Date.now() }
  private sealed(): boolean { return lanDiscoverySealed(this.deps.policy()) }

  /** Applies the persistent config (and the seal) at boot and whenever policy may have changed. */
  reconcile(): void {
    if (this.sealed()) {
      if (this.deps.advertiser.advertising || this.until !== null) warn('LAN discovery is sealed by enterprise policy; turning it off', { was_window: this.until !== null })
      else log('LAN discovery is sealed by enterprise policy', { persistent_configured: this.deps.persistent() })
      this.shutDown()
      return
    }
    if (this.deps.persistent()) {
      log('persistent LAN discovery configured; advertising', {})
      this.deps.advertiser.start(this.deps.advertisement())
    } else if (this.until === null && this.deps.advertiser.advertising) {
      log('persistent LAN discovery no longer configured and no window is open; stopping', {})
      this.deps.advertiser.stop()
    } else {
      log('LAN discovery is off (the default)', {})
    }
    this.publish()
  }

  status(): DiscoveryStatus {
    const mode: DiscoveryMode = this.sealed() ? 'sealed' : this.until !== null ? 'window' : this.deps.persistent() ? 'persistent' : 'off'
    return { mode, advertising: this.deps.advertiser.advertising, until: this.until, code: this.code ? formatDiscoveryCode(this.code) : null }
  }

  open(caller: PairingCaller, minutes: number): { ok: true; status: DiscoveryStatus } | { ok: false; refusal: DiscoveryRefusal } {
    if (this.sealed()) {
      warn('open refused: sealed by enterprise policy', { subject: caller.subject })
      return { ok: false, refusal: { code: 'sealed', message: 'LAN discovery is disabled by your organization. Pair with a pairing link instead.' } }
    }
    if (!Number.isFinite(minutes) || minutes < MIN_WINDOW_MINUTES || minutes > MAX_WINDOW_MINUTES) {
      return { ok: false, refusal: { code: 'invalid_args', message: `minutes must be between ${MIN_WINDOW_MINUTES} and ${MAX_WINDOW_MINUTES}` } }
    }
    this.clearTimer()
    this.until = this.now() + Math.round(minutes) * 60_000
    this.timer = setTimeout(() => { log('window elapsed; closing itself', {}); this.close() }, this.until - this.now())
    if (!this.rotateCode(caller, this.until)) {
      this.clearTimer(); this.until = null
      return { ok: false, refusal: { code: 'scope', message: 'your scopes do not cover the default pairing scopes' } }
    }
    this.deps.advertiser.start(this.deps.advertisement())
    log('window opened', { subject: caller.subject, minutes: Math.round(minutes), until: this.until })
    this.publish()
    return { ok: true, status: this.status() }
  }

  close(): DiscoveryStatus {
    const wasOpen = this.until !== null
    this.clearTimer()
    this.until = null
    this.dropCode()
    if (!this.deps.persistent() || this.sealed()) this.deps.advertiser.stop()
    if (wasOpen) log('window closed', { still_advertising: this.deps.advertiser.advertising })
    this.publish()
    return this.status()
  }

  /** A code outside a window, for a persistently advertised (headless) server. */
  mintCode(caller: PairingCaller): { ok: true; code: string; expiresAt: number } | { ok: false; refusal: DiscoveryRefusal } {
    if (this.sealed()) return { ok: false, refusal: { code: 'sealed', message: 'LAN discovery is disabled by your organization. Pair with a pairing link instead.' } }
    const expiresAt = this.until ?? this.now() + STANDALONE_CODE_TTL_MS
    if (!this.rotateCode(caller, expiresAt)) return { ok: false, refusal: { code: 'scope', message: 'your scopes do not cover the default pairing scopes' } }
    return { ok: true, code: formatDiscoveryCode(this.code!), expiresAt }
  }

  dispose(): void {
    this.shutDown()
    for (const off of this.off) off()
  }

  private shutDown(): void {
    this.clearTimer()
    this.until = null
    this.dropCode()
    this.deps.advertiser.stop()
    this.publish()
  }

  private rotateCode(caller: PairingCaller, expiresAt: number): boolean {
    this.dropCode()
    const code = mintDiscoveryCode()
    if (!registerPairingCode(caller, code, this.deps.defaultScopes(), 'paired nearby', expiresAt)) return false
    this.code = code
    this.codeCaller = caller
    this.failures = 0
    log('discovery code is live', { expires_at: expiresAt })
    return true
  }

  private dropCode(): void {
    if (this.code) revokePairingCode(this.code)
    this.code = null
    this.failures = 0
  }

  private onCompleted(code: string): void {
    if (code !== this.code) return
    log('discovery code used', { window_open: this.until !== null })
    const caller = this.codeCaller
    this.code = null
    // A window stays useful for the next device; a standalone code does not renew itself.
    if (this.until !== null && caller) this.rotateCode(caller, this.until)
    this.publish()
  }

  private onFailed(): void {
    if (!this.code) return
    this.failures++
    if (this.failures < MAX_FAILED_ATTEMPTS) {
      log('wrong pairing code while a discovery code is live', { failures: this.failures, limit: MAX_FAILED_ATTEMPTS })
      return
    }
    warn('too many wrong pairing codes; burning the live discovery code', { failures: this.failures })
    const caller = this.codeCaller
    const until = this.until
    this.dropCode()
    if (until !== null && caller) this.rotateCode(caller, until)
    this.publish()
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private publish(): void {
    const { code: _code, ...rest } = this.status()
    this.deps.onChange(rest)
  }
}
