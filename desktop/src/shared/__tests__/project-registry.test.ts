import { describe, expect, it } from 'vitest'
import {
  defaultProject,
  effectiveProjects,
  isManagedWorkspacePath,
  migrateProjectRegistry,
  normalizeProjectDir,
  orderedProjects,
  sanitizeProjectRegistry,
  type ProjectRegistry,
} from '../project-registry'

describe('controlled Project registry', () => {
  it('sanitizes profile overrides and retains one default Project', () => {
    expect(sanitizeProjectRegistry({
      '/alpha': { addedManually: true, lastUsedAt: 2, isDefault: true, profileOverride: { kind: 'profile', profileId: 'dev' } },
      '/beta': { addedManually: true, lastUsedAt: 1, isDefault: true, profileOverride: { kind: 'plain' } },
      '/bad': { addedManually: true, lastUsedAt: 0, profileOverride: { kind: 'profile' } },
    })).toEqual({
      '/alpha': { addedManually: true, lastUsedAt: 2, isDefault: true, profileOverride: { kind: 'profile', profileId: 'dev' } },
      '/beta': { addedManually: true, lastUsedAt: 1, isDefault: false, profileOverride: { kind: 'plain' } },
      '/bad': { addedManually: true, lastUsedAt: 0 },
    })
  })

  it('orders alphabetically and disambiguates duplicate names', () => {
    const registry: ProjectRegistry = {
      '/zeta/api': { addedManually: true, lastUsedAt: 100 },
      '/alpha/api': { addedManually: true, lastUsedAt: 1 },
      '/beta/web': { addedManually: true, lastUsedAt: 2 },
    }
    expect(orderedProjects(registry).map((item) => item.displayName)).toEqual(['api (alpha)', 'api (zeta)', 'web'])
  })

  it('migrates the legacy default directory, resets profile defaults, and excludes managed paths', () => {
    expect(migrateProjectRegistry({
      '/repo': { addedManually: false, lastUsedAt: 3, profileOverride: { kind: 'profile', profileId: 'old' } },
      '/Users/dev/.ion/worktrees/task': { addedManually: true, lastUsedAt: 2 },
    }, '/default')).toEqual({
      '/repo': { addedManually: false, lastUsedAt: 3, isDefault: false },
      '/default': { addedManually: true, lastUsedAt: 0, isDefault: true },
    })
  })

  it('merges immutable managed Projects and lets their default win', () => {
    const projects = effectiveProjects({ '/user': { addedManually: true, lastUsedAt: 0, isDefault: true } }, [{ directory: '/managed', name: 'Managed', isDefault: true, profileAction: 'profile', profileId: 'corp', profileSource: 'enterprise' }])
    expect(projects.map((item) => item.displayName)).toEqual(['Managed', 'user'])
    expect(defaultProject({ '/user': { addedManually: true, lastUsedAt: 0, isDefault: true } }, [{ directory: '/managed', isDefault: true }])?.dir).toBe('/managed')
  })

  it('normalizes paths and refuses generated workspace paths', () => {
    expect(normalizeProjectDir('/a/b//')).toBe('/a/b')
    expect(isManagedWorkspacePath('/Users/dev/.ion/integration/test')).toBe(true)
  })
})
