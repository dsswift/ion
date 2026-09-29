import { describe, expect, it } from 'vitest'
import {
  PERSONAL_PREFERENCE_DEFAULTS,
  SETTINGS_REGISTRY,
  TRAVELLING_PREFERENCE_KEYS,
  sanitizePersonalPreferences,
  settingScope,
} from '../settings-registry'

describe('settings registry', () => {
  it('files auto-settle under the environment, so no client can bring its own value', () => {
    expect(settingScope('inboxAutoSettleDays')).toBe('environment')
    expect(settingScope('inboxAutoSettleOnMerge')).toBe('environment')
  })

  it('files the default model under the account, per person per server', () => {
    expect(settingScope('preferredModel')).toBe('account')
    expect(settingScope('engineDefaultModel')).toBe('account')
  })

  it('answers undefined for a key it does not know', () => {
    expect(settingScope('defaultTallConversation')).toBeUndefined()
    expect(settingScope('toString')).toBeUndefined()
  })

  it('only personal keys travel, and only environment keys are server-written', () => {
    for (const entry of Object.values(SETTINGS_REGISTRY)) {
      if ('travels' in entry) expect(entry.scope).toBe('personal')
      if ('serverWritten' in entry) expect(entry.scope).toBe('environment')
    }
  })

  it('has a default for every travelling preference, and nothing else', () => {
    expect(Object.keys(PERSONAL_PREFERENCE_DEFAULTS).sort()).toEqual([...TRAVELLING_PREFERENCE_KEYS].sort())
  })

  it('drops malformed wire values rather than coercing them', () => {
    expect(sanitizePersonalPreferences({ defaultPermissionMode: 'yolo', aiGeneratedTitles: 'yes', enableClaudeCompat: true, extra: 1 }))
      .toEqual({ enableClaudeCompat: true })
    expect(sanitizePersonalPreferences(null)).toEqual({})
    expect(sanitizePersonalPreferences([])).toEqual({})
  })
})
