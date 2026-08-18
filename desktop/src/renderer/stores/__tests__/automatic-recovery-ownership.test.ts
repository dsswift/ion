import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const storesDir = resolve(__dirname, '..')

/**
 * Automatic restart recovery belongs to the engine's durable run journal.
 * Renderer inactivity can never prove a run died: providers may be thinking,
 * tools may be quiet, and user steering must remain available throughout.
 */
describe('automatic recovery ownership', () => {
  it('never aborts or replays a prompt from the renderer inactivity path', () => {
    const persistence = readFileSync(resolve(storesDir, 'session-store-persistence.ts'), 'utf8')
    const permissions = readFileSync(resolve(storesDir, 'slices/permissions-slice.ts'), 'utf8')

    expect(persistence).not.toContain('scanForStuckTabs')
    expect(persistence).not.toContain('autoRecoverStuckTab')
    expect(permissions).not.toContain('enginePinnedPrompt')
    expect(permissions).not.toContain('queueing prompt after abort')
    expect(permissions).not.toContain('automatically resuming')
  })
})
