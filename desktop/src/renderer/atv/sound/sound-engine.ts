/**
 * sound-engine — the ATV's ambient soundscape, fully procedural (WebAudio
 * oscillator/noise synthesis; no pack assets required — the same ships-
 * art-free philosophy as the badge glyphs). Pure decision core
 * (soundActions: intents + state → actions with cooldowns) separated from
 * the WebAudio shell so the mapping is testable.
 *
 * Muted by default until the user's first gesture enables the AudioContext
 * (Chromium autoplay policy); the atvSound setting persists the toggle.
 */
import type { Intent } from '../engine/mapping'

export type SoundKind = 'mail-chime' | 'attention-chime' | 'error-sting' | 'celebrate'

export interface SoundCooldowns {
  /** Last-fired clock (seconds) per kind. */
  lastAt: Partial<Record<SoundKind, number>>
}

const COOLDOWN_S: Record<SoundKind, number> = {
  'mail-chime': 1.5,
  'attention-chime': 1.5,
  'error-sting': 3,
  celebrate: 5,
}

/** Pure: which one-shots fire for a batch of intents at `now` (seconds). */
export function soundActions(intents: readonly Intent[], cooldowns: SoundCooldowns, now: number): SoundKind[] {
  const out: SoundKind[] = []
  const fire = (kind: SoundKind): void => {
    const last = cooldowns.lastAt[kind] ?? -Infinity
    if (now - last < COOLDOWN_S[kind]) return
    cooldowns.lastAt[kind] = now
    out.push(kind)
  }
  for (const intent of intents) {
    switch (intent.kind) {
      case 'deliver':
        fire('mail-chime')
        break
      case 'permission-wait':
        fire('attention-chime')
        break
      case 'agent-error':
        fire('error-sting')
        break
      default:
        break
    }
  }
  return out
}

/** WebAudio shell: constructed lazily after a user gesture. */
export class AtvSoundEngine {
  private ctx: AudioContext | null = null
  private cooldowns: SoundCooldowns = { lastAt: {} }
  private startAt = 0
  enabled = false

  private ensureCtx(): AudioContext | null {
    if (!this.enabled) return null
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext()
        this.startAt = performance.now() / 1000
      } catch {
        return null
      }
    }
    return this.ctx
  }

  /** Feed the intent stream; fires cooldown-gated one-shots. */
  handleIntents(intents: readonly Intent[]): void {
    if (!this.enabled || intents.length === 0) return
    const now = performance.now() / 1000 - this.startAt
    for (const kind of soundActions(intents, this.cooldowns, now)) this.play(kind)
  }

  /** Celebration hook (confetti trigger). */
  celebrate(): void {
    if (!this.enabled) return
    const now = performance.now() / 1000 - this.startAt
    for (const kind of soundActions([], this.cooldowns, now)) void kind
    const last = this.cooldowns.lastAt.celebrate ?? -Infinity
    if (now - last < COOLDOWN_S.celebrate) return
    this.cooldowns.lastAt.celebrate = now
    this.play('celebrate')
  }

  private tone(freq: number, at: number, dur: number, gain = 0.08, type: OscillatorType = 'triangle'): void {
    const ctx = this.ensureCtx()
    if (!ctx) return
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = type
    osc.frequency.value = freq
    g.gain.setValueAtTime(gain, ctx.currentTime + at)
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + at + dur)
    osc.connect(g).connect(ctx.destination)
    osc.start(ctx.currentTime + at)
    osc.stop(ctx.currentTime + at + dur + 0.05)
  }

  private play(kind: SoundKind): void {
    switch (kind) {
      case 'mail-chime': // two-note doorbell blip
        this.tone(880, 0, 0.12)
        this.tone(1174.7, 0.1, 0.18)
        break
      case 'attention-chime': // rising triad — "needs you"
        this.tone(659.3, 0, 0.14)
        this.tone(830.6, 0.12, 0.14)
        this.tone(987.8, 0.24, 0.3)
        break
      case 'error-sting': // descending buzz
        this.tone(220, 0, 0.2, 0.09, 'sawtooth')
        this.tone(164.8, 0.15, 0.35, 0.09, 'sawtooth')
        break
      case 'celebrate': // quick major arpeggio
        this.tone(523.3, 0, 0.1)
        this.tone(659.3, 0.09, 0.1)
        this.tone(784, 0.18, 0.1)
        this.tone(1046.5, 0.27, 0.3)
        break
    }
  }
}
