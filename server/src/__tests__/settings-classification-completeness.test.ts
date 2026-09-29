/**
 * Task 10 completeness gate: every server-projectable settings group must
 * have a personal/environment classification in `@ion/shared/settings-
 * classification`. The classification table lives in packages/shared (it
 * also covers desktop-only categories shared cannot see), so this cross-
 * check lives here, where both `PROJECTABLE_GROUP_ORDER` and the
 * classification table are visible without a circular import.
 */
import { describe, expect, it } from 'vitest'
import { PROJECTABLE_GROUP_ORDER } from '../projectable-settings'
import { classifySettingsGroup } from '@ion/shared/settings-classification'

describe('settings-classification completeness', () => {
  it('every projectable group has a classification', () => {
    const unclassified = PROJECTABLE_GROUP_ORDER.filter((id) => classifySettingsGroup(id) === undefined)
    expect(unclassified).toEqual([])
  })
})
