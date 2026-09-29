import { describe, expect, it } from 'vitest'
import {
  SETTINGS_GROUP_CLASSIFICATIONS,
  ENVIRONMENT_SETTINGS_GROUP_IDS,
  classifySettingsGroup,
} from '../settings-classification'

describe('settings-classification', () => {
  it('has no duplicate group ids', () => {
    const ids = SETTINGS_GROUP_CLASSIFICATIONS.map((g) => g.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every entry is tagged personal or environment', () => {
    for (const g of SETTINGS_GROUP_CLASSIFICATIONS) {
      expect(['personal', 'environment']).toContain(g.classification)
    }
  })

  it('classifySettingsGroup resolves a known id and returns undefined for an unknown one', () => {
    expect(classifySettingsGroup('ai')).toBe('environment')
    expect(classifySettingsGroup('appearance')).toBe('personal')
    expect(classifySettingsGroup('not-a-real-group')).toBeUndefined()
  })

  it('ENVIRONMENT_SETTINGS_GROUP_IDS matches the table', () => {
    const expected = SETTINGS_GROUP_CLASSIFICATIONS
      .filter((g) => g.classification === 'environment')
      .map((g) => g.id)
      .sort()
    expect([...ENVIRONMENT_SETTINGS_GROUP_IDS].sort()).toEqual(expected)
  })

  // A person's own git identity and the Environment's git operation policy are
  // different things and land on opposite sides of the partition. Identity is
  // reached through the Environments category (`git-identity` is a legacy tab
  // id that `settings-catalog.ts` folds into `environments`, not a group of
  // its own), so that category is what carries the personal classification.
  it('git identity stays personal -- distinct from git operation policy', () => {
    expect(classifySettingsGroup('environments')).toBe('personal')
    expect(classifySettingsGroup('git')).toBe('environment')
    // A legacy tab id is not a group: it classifies as neither, which is not
    // the same as classifying as personal.
    expect(classifySettingsGroup('git-identity')).toBeUndefined()
  })
})
