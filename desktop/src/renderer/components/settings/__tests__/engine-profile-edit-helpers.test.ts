/**
 * engine-profile-edit-helpers — round-trip tests
 *
 * Pins the editor helper contract:
 *   - profileToEdit converts an EngineProfile to a ProfileEditState,
 *     preserving defaultMode (including the optional→default 'auto' fallback).
 *   - editToProfile converts a ProfileEditState back to an EngineProfile,
 *     writing defaultMode into the persisted object.
 *   - The round-trip is lossless: profile → edit → profile yields an
 *     equivalent object (same id, name, extensions, defaultMode).
 */

import { describe, it, expect } from 'vitest'
import {
  profileToEdit,
  editToProfile,
  emptyProfileEdit,
} from '../engine-profile-edit-helpers'
import type { EngineProfile } from '../../../../shared/types'

describe('profileToEdit', () => {
  it('maps defaultMode:plan from profile to edit state', () => {
    const profile: EngineProfile = {
      id: 'p1',
      name: 'Plan Profile',
      extensions: ['/ext/a.js'],
      defaultMode: 'plan',
    }
    const edit = profileToEdit(profile)
    expect(edit.defaultMode).toBe('plan')
  })

  it('maps defaultMode:auto from profile to edit state', () => {
    const profile: EngineProfile = {
      id: 'p2',
      name: 'Auto Profile',
      extensions: ['/ext/b.js'],
      defaultMode: 'auto',
    }
    const edit = profileToEdit(profile)
    expect(edit.defaultMode).toBe('auto')
  })

  it('defaults to auto when profile has no defaultMode', () => {
    const profile: EngineProfile = {
      id: 'p3',
      name: 'Legacy Profile',
      extensions: ['/ext/c.js'],
    }
    const edit = profileToEdit(profile)
    expect(edit.defaultMode).toBe('auto')
  })

  it('copies name and extensions faithfully', () => {
    const profile: EngineProfile = {
      id: 'p4',
      name: 'My Profile',
      extensions: ['/ext/x.js', '/ext/y.js'],
      defaultMode: 'plan',
    }
    const edit = profileToEdit(profile)
    expect(edit.name).toBe('My Profile')
    expect(edit.extensions).toEqual(['/ext/x.js', '/ext/y.js'])
    // extensions must be a copy, not the same reference
    expect(edit.extensions).not.toBe(profile.extensions)
  })
})

describe('editToProfile', () => {
  it('saves defaultMode:plan into the resulting EngineProfile', () => {
    const profile = editToProfile('pid-1', {
      name: 'Plan Profile',
      extensions: ['/ext/a.js'],
      defaultMode: 'plan',
    })
    expect(profile.defaultMode).toBe('plan')
    expect(profile.id).toBe('pid-1')
  })

  it('saves defaultMode:auto into the resulting EngineProfile', () => {
    const profile = editToProfile('pid-2', {
      name: 'Auto Profile',
      extensions: ['/ext/b.js'],
      defaultMode: 'auto',
    })
    expect(profile.defaultMode).toBe('auto')
  })

  it('trims whitespace from name', () => {
    const profile = editToProfile('pid-3', {
      name: '  Padded  ',
      extensions: ['/ext/a.js'],
      defaultMode: 'auto',
    })
    expect(profile.name).toBe('Padded')
  })

  it('filters blank extension entries', () => {
    const profile = editToProfile('pid-4', {
      name: 'Test',
      extensions: ['/ext/a.js', '   ', '/ext/b.js'],
      defaultMode: 'auto',
    })
    expect(profile.extensions).toEqual(['/ext/a.js', '/ext/b.js'])
  })
})

describe('editor round-trip (profileToEdit → editToProfile)', () => {
  it('round-trips a plan-mode profile losslessly', () => {
    const original: EngineProfile = {
      id: 'rt-1',
      name: 'Round Trip Plan',
      extensions: ['/ext/plan.js'],
      defaultMode: 'plan',
    }
    const edit = profileToEdit(original)
    const restored = editToProfile(original.id, edit)
    expect(restored.id).toBe(original.id)
    expect(restored.name).toBe(original.name)
    expect(restored.extensions).toEqual(original.extensions)
    expect(restored.defaultMode).toBe(original.defaultMode)
  })

  it('round-trips an auto-mode profile losslessly', () => {
    const original: EngineProfile = {
      id: 'rt-2',
      name: 'Round Trip Auto',
      extensions: ['/ext/auto.js'],
      defaultMode: 'auto',
    }
    const edit = profileToEdit(original)
    const restored = editToProfile(original.id, edit)
    expect(restored.defaultMode).toBe('auto')
  })

  it('round-trips a legacy profile (no defaultMode) and stores auto', () => {
    const original: EngineProfile = {
      id: 'rt-3',
      name: 'Legacy',
      extensions: ['/ext/legacy.js'],
    }
    const edit = profileToEdit(original)
    const restored = editToProfile(original.id, edit)
    // defaultMode absent on input → edit defaults to 'auto' → stored as 'auto'
    expect(restored.defaultMode).toBe('auto')
  })
})

describe('emptyProfileEdit', () => {
  it('has defaultMode:auto as the factory default', () => {
    expect(emptyProfileEdit.defaultMode).toBe('auto')
  })

  it('has empty name and extensions', () => {
    expect(emptyProfileEdit.name).toBe('')
    expect(emptyProfileEdit.extensions).toEqual([])
  })
})
