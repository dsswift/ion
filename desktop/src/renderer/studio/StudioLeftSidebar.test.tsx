import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(import.meta.dirname, 'StudioLeftSidebar.tsx'), 'utf8')

describe('StudioLeftSidebar chrome', () => {
  it('puts workspace status before dock tabs and replaces close with Settings', () => {
    expect(source.indexOf('<WorkspaceStatusIndicator />')).toBeLessThan(source.indexOf('{VIEWS.map'))
    expect(source).toContain('<OpenSettingsButton />')
    expect(source).not.toContain('aria-label="Close sidebar"')
  })
})
