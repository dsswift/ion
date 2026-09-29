/**
 * `aiAssist.workflows` hands a client that does not bundle `@ion/shared` the
 * workflows whose prompts `aiAssistPromptOverrides` replaces, with the
 * built-in prompt of each, so it can show and reset them.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { AI_ASSIST_WORKFLOWS } from '@ion/shared/ai-assist-workflows'
import { SETTINGS_ACTIONS } from '../settings-actions'
import type { Connection } from '../connection'

const reader = { id: 'r', transport: 'tcp', scopes: ['conversations:read'], principal: { subject: 'oidc:reader' } } as unknown as Connection

describe('aiAssist.workflows', () => {
  it('needs only read access', () => {
    expect(SETTINGS_ACTIONS['aiAssist.workflows'].requiredScope).toBe('conversations:read')
  })

  it('answers every workflow with its label, placeholders, and built-in prompt', async () => {
    const outcome = await SETTINGS_ACTIONS['aiAssist.workflows'].handler(reader, [])
    expect(outcome).toEqual({ ok: true, value: AI_ASSIST_WORKFLOWS })
    const rebase = (outcome as { value: typeof AI_ASSIST_WORKFLOWS }).value.find((w) => w.id === 'rebase-resolution')
    expect(rebase?.placeholders).toEqual(['directory'])
    expect(rebase?.defaultTemplate).toContain('{{directory}}')
  })
})
