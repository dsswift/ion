import { describe, it, expect } from 'vitest'
import { soundActions, type SoundCooldowns } from '../sound-engine'
import type { Intent } from '../../engine/mapping'

const deliver = { kind: 'deliver', from: 'manager', toAgent: 'dev' } as Intent
const wait = { kind: 'permission-wait', bubble: 'plan' } as Intent
const error = { kind: 'agent-error', agent: 'dev' } as Intent

describe('soundActions', () => {
  it('maps intents to one-shots', () => {
    const cd: SoundCooldowns = { lastAt: {} }
    expect(soundActions([deliver, wait, error], cd, 0)).toEqual(['mail-chime', 'attention-chime', 'error-sting'])
  })
  it('enforces per-kind cooldowns', () => {
    const cd: SoundCooldowns = { lastAt: {} }
    expect(soundActions([deliver], cd, 0)).toEqual(['mail-chime'])
    expect(soundActions([deliver], cd, 1.0)).toEqual([])
    expect(soundActions([deliver], cd, 2.0)).toEqual(['mail-chime'])
  })
  it('cooldowns are independent per kind', () => {
    const cd: SoundCooldowns = { lastAt: {} }
    soundActions([deliver], cd, 0)
    expect(soundActions([wait], cd, 0.5)).toEqual(['attention-chime'])
  })
})
