import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(import.meta.dirname, 'TabStrip.tsx'), 'utf8')

describe('TabStrip presentation contract', () => {
  it('keeps Studio tabs-only and retains Overlay chrome', () => {
    expect(source).toContain("presentation === 'overlay' && <WorkspaceStatusIndicator />")
    expect(source).toContain("presentation === 'overlay' && (")
    expect(source).toContain('<NotificationsBell />')
    expect(source).toContain('<OpenSettingsButton />')
    expect(source).not.toContain('SettingsPopover')
    expect(source).not.toContain('StudioLauncherButton')
  })
})
