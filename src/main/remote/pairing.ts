/**
 * Pairing flow for iOS companion app.
 *
 * 1. CODA generates a 6-digit code and displays it in the UI.
 * 2. iOS discovers CODA via Bonjour, connects over LAN WebSocket.
 * 3. iOS sends the 6-digit code to prove physical proximity.
 * 4. X25519 key exchange: both sides generate keypairs, exchange public keys.
 * 5. Shared secret derived via DH + HKDF-SHA256.
 * 6. CODA generates device token (256-bit), sends to iOS.
 * 7. CODA sends relay config { relayUrl, relayApiKey } to iOS.
 * 8. Both store credentials.
 *
 * The pairing code expires after 5 minutes.
 */

import { randomInt } from 'crypto'
import { EventEmitter } from 'events'
import { log as _log } from '../logger'
import {
  generateKeyPair,
  deriveSharedSecret,
  deriveChannelId,
} from './crypto'
import type { PairedDevice } from './protocol'

function log(msg: string): void {
  _log('Pairing', msg)
}

const CODE_EXPIRY_MS = 5 * 60 * 1000
const CODE_LENGTH = 6
const MAX_FAILED_ATTEMPTS = 5

export interface PairingResult {
  device: PairedDevice
  /** Shared secret as Buffer for encryption operations */
  sharedSecretBuf: Buffer
}

export interface RelayConfig {
  relayUrl: string
  relayApiKey: string
}

/**
 * Events:
 *  - 'code-generated' (code: string) -- display this code in the UI
 *  - 'paired' (result: PairingResult) -- pairing complete
 *  - 'error' (message: string) -- pairing failed
 *  - 'expired' -- pairing code expired
 */
export class PairingManager extends EventEmitter {
  private activeCode: string | null = null
  private codeExpiry: number = 0
  private expiryTimer: ReturnType<typeof setTimeout> | null = null
  private keyPair: { publicKey: Buffer; secretKey: Buffer } | null = null
  private failedAttempts = 0

  /** Generate a new pairing code and start the 5-minute timer. */
  startPairing(): string {
    this.cancelPairing()
    this.failedAttempts = 0

    // Generate a 6-digit code (000000-999999).
    this.activeCode = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0')
    this.codeExpiry = Date.now() + CODE_EXPIRY_MS

    // Pre-generate our key pair for the exchange.
    this.keyPair = generateKeyPair()

    this.expiryTimer = setTimeout(() => {
      log('pairing code expired')
      this.activeCode = null
      this.keyPair = null
      this.emit('expired')
    }, CODE_EXPIRY_MS)

    log(`pairing code generated: ${this.activeCode}`)
    this.emit('code-generated', this.activeCode)
    return this.activeCode
  }

  /**
   * Handle an incoming pairing request from iOS.
   *
   * @param code The 6-digit code entered by the user on iOS.
   * @param peerPublicKey The iOS app's X25519 public key (base64).
   * @param deviceName Human-readable device name (e.g., "Josh's iPhone").
   * @param apnsToken Optional APNs device token for push notifications.
   * @param relayConfig Relay URL and API key to send to the iOS app.
   * @returns The pairing result with device info and our public key.
   */
  completePairing(
    code: string,
    peerPublicKey: string,
    deviceName: string,
    apnsToken: string | undefined,
    relayConfig: RelayConfig,
  ): { device: PairedDevice; ourPublicKey: string; relayConfig: RelayConfig; sharedSecretBuf: Buffer } | null {
    if (!this.activeCode || !this.keyPair) {
      log('no active pairing session')
      this.emit('error', 'No active pairing session')
      return null
    }

    if (Date.now() > this.codeExpiry) {
      log('pairing code expired')
      this.cancelPairing()
      this.emit('error', 'Pairing code expired')
      return null
    }

    if (code !== this.activeCode) {
      this.failedAttempts++
      log(`incorrect pairing code (attempt ${this.failedAttempts}/${MAX_FAILED_ATTEMPTS})`)
      if (this.failedAttempts >= MAX_FAILED_ATTEMPTS) {
        log('too many failed pairing attempts, cancelling session')
        this.cancelPairing()
        this.emit('error', 'Too many failed attempts. Pairing cancelled.')
        return null
      }
      this.emit('error', 'Incorrect pairing code')
      return null
    }

    // Derive shared secret from DH exchange.
    const peerPubBuf = Buffer.from(peerPublicKey, 'base64')
    const sharedSecret = deriveSharedSecret(this.keyPair.secretKey, peerPubBuf)

    // Derive channel ID from shared secret (matches iOS E2ECrypto.deriveChannelId).
    const channelId = deriveChannelId(sharedSecret)

    const device: PairedDevice = {
      id: channelId.substring(0, 16),
      name: deviceName,
      pairedAt: new Date().toISOString(),
      lastSeen: null,
      channelId,
      sharedSecret: sharedSecret.toString('base64'),
      apnsToken,
    }

    const ourPublicKey = this.keyPair.publicKey.toString('base64')

    // Clean up pairing state.
    this.cancelPairing()

    log(`paired with ${deviceName} (channel=${channelId.substring(0, 8)}...)`)
    this.emit('paired', { device, sharedSecretBuf: sharedSecret } as PairingResult)

    return { device, ourPublicKey, relayConfig, sharedSecretBuf: sharedSecret }
  }

  cancelPairing(): void {
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer)
      this.expiryTimer = null
    }
    this.activeCode = null
    this.keyPair = null
  }

  get isPairing(): boolean {
    return this.activeCode !== null && Date.now() < this.codeExpiry
  }

  get currentCode(): string | null {
    if (!this.activeCode || Date.now() > this.codeExpiry) return null
    return this.activeCode
  }
}
