// Focused validation tests for projectable settings.

import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return false
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}))

const planBashMock = vi.hoisted(() => ({
  readPlanBashAllowlist: vi.fn(() => [] as string[]),
}))
vi.mock('../plan-bash-allowlist-store', () => ({
  readPlanBashAllowlist: () => planBashMock.readPlanBashAllowlist(),
  writePlanBashAllowlist: vi.fn(),
}))

const themePolicyMock = vi.hoisted(() => ({
  getEnterpriseThemePolicy: vi.fn(
    (): { themeId: string; locked: boolean } | null => null,
  ),
}))
vi.mock('../theme-policy', () => ({
  getEnterpriseThemePolicy: () => themePolicyMock.getEnterpriseThemePolicy(),
  isThemeLocked: () =>
    themePolicyMock.getEnterpriseThemePolicy()?.locked === true,
}))

import { validateSettingValue } from '../projectable-settings'

describe('validateSettingValue', () => {
  it('accepts a boolean for a boolean key', () => {
    expect(validateSettingValue('enableEarlyStopContinuation', true)).toBeNull()
    expect(
      validateSettingValue('enableEarlyStopContinuation', false),
    ).toBeNull()
  })

  it('accepts/rejects values for streamThinkingToRemote like any boolean (issue #158)', () => {
    expect(validateSettingValue('streamThinkingToRemote', true)).toBeNull()
    expect(validateSettingValue('streamThinkingToRemote', false)).toBeNull()
    // Non-booleans rejected so the iOS write cannot drift the type.
    expect(
      validateSettingValue('streamThinkingToRemote', 'true'),
    ).not.toBeNull()
    expect(validateSettingValue('streamThinkingToRemote', 1)).not.toBeNull()
    expect(validateSettingValue('streamThinkingToRemote', null)).not.toBeNull()
  })

  it('rejects a non-boolean for a boolean key', () => {
    expect(
      validateSettingValue('enableEarlyStopContinuation', 'true'),
    ).not.toBeNull()
    expect(
      validateSettingValue('enableEarlyStopContinuation', 1),
    ).not.toBeNull()
    expect(
      validateSettingValue('enableEarlyStopContinuation', null),
    ).not.toBeNull()
    expect(
      validateSettingValue('enableEarlyStopContinuation', undefined),
    ).not.toBeNull()
  })

  it('rejects an unknown key regardless of value', () => {
    expect(validateSettingValue('not_a_real_setting', true)).not.toBeNull()
    expect(validateSettingValue('not_a_real_setting', 'value')).not.toBeNull()
  })

  it('rejects NaN even when a number is expected', () => {
    // NaN technically passes `typeof n === 'number'` but is never a
    // valid setting value. The validator guards it explicitly so
    // every number-typed projection inherits the right behavior.
    expect(validateSettingValue('uiZoom', NaN)).not.toBeNull()
  })

  it('accepts a string value within a static enum choice set', () => {
    // gitOpsMode is a static enum: manual | worktree.
    expect(validateSettingValue('gitOpsMode', 'manual')).toBeNull()
    expect(validateSettingValue('gitOpsMode', 'worktree')).toBeNull()
  })

  it('rejects a string value outside a static enum choice set', () => {
    expect(validateSettingValue('gitOpsMode', 'invalid-mode')).not.toBeNull()
  })

  it('rejects null for a non-nullable static enum', () => {
    // gitOpsMode has no { value: null } choice — null must be rejected.
    expect(validateSettingValue('gitOpsMode', null)).not.toBeNull()
  })

  it('accepts null for dynamic group-id enums (the "None" choice)', () => {
    expect(validateSettingValue('planningGroupId', null)).toBeNull()
    expect(validateSettingValue('inProgressGroupId', null)).toBeNull()
    expect(validateSettingValue('doneGroupId', null)).toBeNull()
  })

  it('accepts an arbitrary string for dynamic group-id enums', () => {
    // The canonical choice set depends on live tabGroups; we trust
    // iOS not to fabricate a string outside the current set, and the
    // projection layer self-heals stale references to None.
    expect(validateSettingValue('planningGroupId', 'group-abc')).toBeNull()
  })

  it('rejects non-string non-null for a dynamic group-id enum', () => {
    expect(validateSettingValue('planningGroupId', 42)).not.toBeNull()
    expect(validateSettingValue('planningGroupId', true)).not.toBeNull()
  })

  it('accepts an array for a list-typed key', () => {
    expect(validateSettingValue('quickTools', [])).toBeNull()
    expect(
      validateSettingValue('quickTools', [
        { id: 'a', name: 'a', icon: 'Gear', command: 'echo' },
      ]),
    ).toBeNull()
  })

  it('rejects a non-array for a list-typed key', () => {
    expect(validateSettingValue('quickTools', null)).not.toBeNull()
    expect(validateSettingValue('quickTools', {})).not.toBeNull()
    expect(validateSettingValue('quickTools', 'tools')).not.toBeNull()
  })

  // Primitive-list ('list' + itemType: 'string') round-trip tests.
  // planModeAllowedBashCommands is the first primitive-list projectable
  // setting. The defect this guards: before the projection used
  // itemType, iOS sent the value back as a string and the desktop
  // accepted it (declared type was 'string'), breaking the engine wire
  // round-trip the next time the prompt pipeline read string[].
  it('accepts a string[] for planModeAllowedBashCommands', () => {
    expect(validateSettingValue('planModeAllowedBashCommands', [])).toBeNull()
    expect(
      validateSettingValue('planModeAllowedBashCommands', ['gh']),
    ).toBeNull()
    expect(
      validateSettingValue('planModeAllowedBashCommands', [
        'gh',
        'git log',
        'git diff',
      ]),
    ).toBeNull()
  })

  it('rejects a string (not array) for planModeAllowedBashCommands', () => {
    // The original BLOCKER: iOS used to send "gh, git log" as a string.
    // The validator must refuse so persistence cannot drift to the wrong
    // shape. The engine expects []string on the wire.
    const err = validateSettingValue(
      'planModeAllowedBashCommands',
      'gh, git log',
    )
    expect(err).not.toBeNull()
    expect(err).toMatch(/expects array/)
  })

  it('rejects a list of non-strings for planModeAllowedBashCommands', () => {
    const err = validateSettingValue('planModeAllowedBashCommands', ['gh', 42])
    expect(err).not.toBeNull()
    // Error message names the expected element type and the bad index
    // so the iOS-side debugger can point at the offending row.
    expect(err).toMatch(/expects list of string/)
    expect(err).toMatch(/index 1/)
  })

  it('rejects null inside a primitive-list', () => {
    const err = validateSettingValue('planModeAllowedBashCommands', [
      'gh',
      null,
    ])
    expect(err).not.toBeNull()
  })
})
