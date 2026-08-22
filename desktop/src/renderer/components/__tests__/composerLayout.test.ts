import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OVERLAY_COMPOSER_LAYER, OVERLAY_CONVERSATION_LAYER } from '../composerLayout'

const COMPONENTS = join(__dirname, '..')
const inputBarSource = readFileSync(join(COMPONENTS, 'InputBar.tsx'), 'utf8')
const controlsSource = readFileSync(join(COMPONENTS, 'ComposerControls.tsx'), 'utf8')
const appSource = readFileSync(join(COMPONENTS, '../App.tsx'), 'utf8')

describe('composer layout', () => {
  it('keeps expanded overlay composer above conversation surface', () => {
    expect(OVERLAY_COMPOSER_LAYER).toBeGreaterThan(OVERLAY_CONVERSATION_LAYER)
    expect(appSource).toContain('OVERLAY_CONVERSATION_LAYER')
    expect(appSource).toContain('OVERLAY_COMPOSER_LAYER')
  })

  it('places attachment previews directly above shared composer controls', () => {
    const previews = inputBarSource.indexOf('<AttachmentChips')
    const controls = inputBarSource.indexOf('<ComposerControls')

    expect(previews).toBeGreaterThan(-1)
    expect(controls).toBeGreaterThan(previews)
    expect(inputBarSource).toContain('data-testid="attachment-composer-divider"')
    expect(inputBarSource).toContain('colors.containerBorder')
    expect(controlsSource).toContain('data-testid="composer-controls"')
  })
})
