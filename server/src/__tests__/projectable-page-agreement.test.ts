/**
 * The settings registry names every key's page, and the server refuses a
 * hidden page's keys by that name. The phone's allowlist groups the same
 * keys for display. The two must agree, or a page hidden in Studio would
 * still be saved from the phone under another name.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../persistence/effective-settings', () => ({ readEffectiveSettings: () => ({ allowSettingsEdits: true }) }))
vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { settingPage } from '@ion/shared/settings-registry'
import { PROJECTABLE_SETTINGS, projectCurrentSettings, projectableSchema } from '../projectable-settings'
import { registerEnterprisePolicySource } from '../enterprise-policy-source'

beforeEach(() => registerEnterprisePolicySource(() => null))

/**
 * Keys whose Studio page the phone does not project. The phone shows them
 * under a page it does have; the registry names the Studio page, which is the
 * one an organization hides. Hidden groups never apply to a phone (it is
 * never the local connection), so the two names cannot disagree in effect.
 */
const SHOWN_ELSEWHERE_ON_THE_PHONE: Record<string, string> = {
  streamThinkingToRemote: 'remote',
  pushConversationTitles: 'remote',
}

describe('projectable groups agree with registry pages', () => {
  it('every projectable key is grouped on the page the registry names', () => {
    const drift = PROJECTABLE_SETTINGS
      .filter((s) => settingPage(s.key) !== (SHOWN_ELSEWHERE_ON_THE_PHONE[s.key] ?? s.group))
      .map((s) => `${s.key}: allowlist=${s.group} registry=${settingPage(s.key) ?? 'unknown'}`)
    expect(drift).toEqual([])
  })
})

describe('a sealed key on the phone', () => {
  it('is marked sealed and shows the sealed value, not the saved one', () => {
    registerEnterprisePolicySource(() => ({ customFields: { 'ion-server': { agentSettingsEdits: { allowed: false } } } }))
    expect(projectableSchema().find((s) => s.key === 'allowSettingsEdits')?.sealed).toBe(true)
    expect(projectCurrentSettings().allowSettingsEdits).toBe(false)
  })

  it('is an ordinary entry when there is no seal', () => {
    expect(projectableSchema().find((s) => s.key === 'allowSettingsEdits')?.sealed).toBeUndefined()
    expect(projectCurrentSettings().allowSettingsEdits).toBe(true)
  })
})
