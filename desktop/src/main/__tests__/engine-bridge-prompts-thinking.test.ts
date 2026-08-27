import { describe, it, expect } from 'vitest'
import { buildSendCommandMessage, buildSendPromptMessage } from '../engine-bridge-prompts'

/**
 * Wire-serialization tests for the per-prompt thinking effort.
 *
 * The thinking control has THREE meaningful wire states, and the distinction
 * between the last two is what makes a configured default safe:
 *
 *   - "low"/"medium"/"high" → set thinking for this run
 *   - "off"                 → CLEAR thinking, overriding any engine.json or
 *                             session default (the engine's `eff == "off"` arm
 *                             sets RunOptions.Thinking = nil)
 *   - absent                → no opinion; inherit the configured default
 *
 * Before the sentinel fix the desktop dropped "off" on the floor, collapsing
 * the last two states. That made the engine's clear arm unreachable from the
 * desktop, so once engine.json could carry a default every conversation with
 * thinking switched OFF would silently inherit it — the off switch would stop
 * working. These tests pin the three-state serialization at the wire seam,
 * which is where the behavior actually lands.
 */
describe('buildSendPromptMessage — thinking effort wire states', () => {
  const base = { key: 'tab-1', text: 'hello' }

  it.each(['low', 'medium', 'high'])('forwards the %s level verbatim', (level) => {
    const msg = buildSendPromptMessage({ ...base, thinkingEffort: level })
    expect(msg.thinkingEffort).toBe(level)
  })

  it("forwards the explicit 'off' sentinel rather than dropping it", () => {
    const msg = buildSendPromptMessage({ ...base, thinkingEffort: 'off' })
    expect(msg.thinkingEffort).toBe('off')
  })

  it('omits the field entirely when no effort is supplied', () => {
    const msg = buildSendPromptMessage({ ...base })
    expect('thinkingEffort' in msg).toBe(false)
  })

  it("distinguishes 'off' from absent — they are not the same wire message", () => {
    const off = buildSendPromptMessage({ ...base, thinkingEffort: 'off' })
    const absent = buildSendPromptMessage({ ...base })
    expect(off.thinkingEffort).toBe('off')
    expect(absent.thinkingEffort).toBeUndefined()
    expect(off).not.toEqual(absent)
  })
})

describe('buildSendPromptMessage — display text', () => {
  const base = { key: 'tab-1', text: 'model prompt with control text' }

  it('forwards separate transcript text without changing the model prompt', () => {
    const msg = buildSendPromptMessage({ ...base, displayText: '**Question?**\n- Answer' })
    expect(msg.text).toBe(base.text)
    expect(msg.displayText).toBe('**Question?**\n- Answer')
  })

  it('omits displayText for ordinary prompts', () => {
    const msg = buildSendPromptMessage(base)
    expect('displayText' in msg).toBe(false)
  })
})

describe('buildSendCommandMessage — one-pass command options', () => {
  it('carries run options on the first command request and omits duplicate text', () => {
    const msg = buildSendCommandMessage({
      key: 'tab-1', text: '/refresh-plan', model: 'standard', thinkingEffort: 'low',
      planFilePath: '/plans/active.md', temporaryAutoFromPlan: true,
    }, 'refresh-plan', '')
    expect(msg).toMatchObject({
      cmd: 'command', key: 'tab-1', command: 'refresh-plan', args: '',
      model: 'standard', thinkingEffort: 'low', planFilePath: '/plans/active.md',
      temporaryAutoFromPlan: true,
    })
    expect(msg.text).toBeUndefined()
  })
})
