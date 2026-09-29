// @vitest-environment jsdom
/**
 * AutomationSection — the source-aware list, the editor in a side panel, and
 * the activity trace. Only your own automations are editable or deletable,
 * a template opens a filled-in draft, changing the event drops actions the
 * event cannot target, a project rule toggles through its own verb, delete
 * asks first, and a run's stored path opens from the activity list.
 */
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationDefinition, AutomationHistoryEntry, AutomationSourceEntry } from '@ion/shared/types-automation'
import { installFakeWire } from '../../../../host/__tests__/fake-wire'
import { createHarness, flush, type Harness } from './page-harness'

vi.mock('../../../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rDebug: vi.fn(), rTrace: vi.fn() }))
vi.mock('../../../PopoverLayer', () => ({ usePopoverLayer: () => document.body }))
vi.mock('../../../SlashCommandMenu', () => ({ SLASH_COMMANDS: [{ command: '/align' }] }))

const { AutomationSection } = await import('../integrations/AutomationSection')

const ion = {
  automationListing: vi.fn(),
  automationHistory: vi.fn(),
  automationUpsert: vi.fn(),
  automationDelete: vi.fn(),
  automationDuplicate: vi.fn(),
  getEnterprisePolicyFull: vi.fn(),
  setProjectAutomationEnabled: vi.fn(),
}

function def(id: string, name: string, event = 'worktree:pin-advanced'): AutomationDefinition {
  return { id, name, enabled: true, trigger: { kind: 'event', event }, steps: [{ kind: 'worktree:set-stage', payload: { stage: 'test', onlyIfStage: 'bug' } }], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
}
function entry(definition: AutomationDefinition, source: AutomationSourceEntry['source'], extra: Partial<AutomationSourceEntry> = {}): AutomationSourceEntry {
  return { definition, source, effective: true, ...extra }
}
function listing(entries: AutomationSourceEntry[], locked = false): void { ion.automationListing.mockResolvedValue({ entries, locked }) }

let h: Harness
beforeEach(() => {
  vi.clearAllMocks()
  listing([entry(def('u1', 'My rule'), 'user')])
  ion.automationHistory.mockResolvedValue([])
  ion.automationUpsert.mockResolvedValue({ ok: true, definition: def('u1', 'My rule') })
  ion.automationDelete.mockResolvedValue({ ok: true })
  ion.automationDuplicate.mockResolvedValue({ ok: true, definition: def('copy', 'My rule (copy)') })
  ion.getEnterprisePolicyFull.mockResolvedValue(null)
  ion.setProjectAutomationEnabled.mockResolvedValue({ ok: true })
  ;(window as unknown as { ion: unknown }).ion = installFakeWire(ion)
  h = createHarness()
})
afterEach(() => {
  h.unmount()
  document.querySelectorAll('[role="menu"]').forEach((m) => m.remove())
})

const text = (): string => h.container.textContent ?? ''
const field = <T extends HTMLElement>(label: string): T => h.container.querySelector(`[aria-label="${label}"]`) as T
function row(name: string): HTMLElement {
  const el = [...h.container.querySelectorAll<HTMLElement>('[aria-label="Automations"] [role="listitem"]')].find((r) => r.textContent?.includes(name))
  if (!el) throw new Error(`no row ${name}`)
  return el
}
async function menu(name: string): Promise<string[]> {
  await act(async () => { (row(name).querySelector('[aria-label="More actions"]') as HTMLElement).click(); await flush() })
  const items = [...document.querySelectorAll('[role="menu"] button')].map((b) => b.textContent?.trim() ?? '')
  return items
}
async function pickMenu(item: string): Promise<void> {
  const button = [...document.querySelectorAll<HTMLElement>('[role="menu"] button')].find((b) => b.textContent?.trim() === item)
  await act(async () => { button?.click(); await flush(); await flush() })
}
async function choose(label: string, value: string): Promise<void> {
  const select = field<HTMLSelectElement>(label)
  await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); await flush() })
}
async function clickRow(name: string): Promise<void> { await act(async () => { row(name).click(); await flush() }) }

describe('AutomationSection', () => {
  it('lists automations with their source from the source-aware listing', async () => {
    await h.render(<AutomationSection />)
    expect(ion.automationListing).toHaveBeenCalledOnce()
    expect(text()).toContain('My rule')
    expect(row('My rule').textContent).toContain('You')
    expect(text()).toContain('AI automation needs confirmation')
  })

  it('a row opens its editor, and another row swaps the editor content in place', async () => {
    listing([entry(def('u1', 'First'), 'user'), entry(def('u2', 'Second', 'worktree:landed'), 'user')])
    await h.render(<AutomationSection />)
    await clickRow('First')
    expect(field('Automation Editor')).not.toBeNull()
    expect(field<HTMLSelectElement>('Automation trigger').value).toBe('worktree:pin-advanced')
    await clickRow('Second')
    expect(field<HTMLSelectElement>('Automation trigger').value).toBe('worktree:landed')
    expect(text()).toContain('First')
  })

  it('offers stage choices by label while storing test and bug', async () => {
    await h.render(<AutomationSection />)
    await h.click('New automation')
    await choose('Automation trigger', 'conversation:message-submitted')
    await h.click('Add action')
    await choose('Action', 'worktree:set-stage')
    const stage = field<HTMLSelectElement>('New stage')
    expect([...stage.options].map((o) => o.textContent)).toEqual(expect.arrayContaining(['Needs testing', 'Issue found']))
    expect([...stage.options].map((o) => o.value)).toEqual(expect.arrayContaining(['test', 'bug']))
  })

  it('a template opens a filled draft that saves its conditions and steps', async () => {
    await h.render(<AutomationSection />)
    await h.click('From template')
    await h.click('Use Normal message on a tested worktree marks Issue found')
    expect(field<HTMLSelectElement>('Automation trigger').value).toBe('conversation:message-submitted')
    await h.click('Save')
    const saved = ion.automationUpsert.mock.calls[0][0] as AutomationDefinition
    expect(saved.condition?.all).toEqual(expect.arrayContaining([
      { path: 'payload.messageKind', operator: 'equals', value: 'prompt' },
      { path: 'payload.permissionMode', operator: 'equals', value: 'auto' },
    ]))
    expect(saved.steps).toEqual([{ kind: 'worktree:set-stage', payload: { stage: 'bug', onlyIfStage: 'test' } }])
    expect(field('Automation Editor')).toBeNull()
  })

  it('changing the event drops actions it cannot target; a valid rule can save', async () => {
    await h.render(<AutomationSection />)
    await h.click('New automation')
    expect((h.control('Save') as HTMLButtonElement).disabled).toBe(true)
    await choose('Automation trigger', 'worktree:pin-advanced')
    await h.click('Add action')
    await choose('Action', 'worktree:set-stage')
    expect((h.control('Save') as HTMLButtonElement).disabled).toBe(false)
    await choose('Automation trigger', 'engine:status')
    expect(field('Action')).toBeNull()
  })

  it('a built-in rule offers only Duplicate, opens read-only, and its switch is locked', async () => {
    listing([entry(def('b1', 'Built-in rule'), 'built-in')])
    await h.render(<AutomationSection />)
    expect(await menu('Built-in rule')).toEqual(['Duplicate'])
    expect(field('Enable Built-in rule').getAttribute('aria-disabled')).toBe('true')
    await pickMenu('Duplicate')
    expect(ion.automationDuplicate).toHaveBeenCalledWith({ id: 'b1', projectPath: undefined })
    expect(field<HTMLInputElement>('Automation name').value).toBe('My rule (copy)')
  })

  it('a locked listing shows the banner and offers no changes', async () => {
    listing([entry(def('u1', 'My rule'), 'user')], true)
    await h.render(<AutomationSection />)
    expect(text()).toContain('Enterprise policy locks changes to your workflows.')
    expect(h.maybeControl('New automation')).toBeUndefined()
    expect(row('My rule').querySelector('[aria-label="More actions"]')).toBeNull()
  })

  it('toggles a project rule through its own verb', async () => {
    listing([entry(def('p1', 'Project rule'), 'project', { locallyDisabled: false })])
    await h.render(<AutomationSection />)
    await h.click('Enable Project rule')
    expect(ion.setProjectAutomationEnabled).toHaveBeenCalledWith({ projectPath: '', id: 'p1', enabled: false })
    expect(field('Automation Editor')).toBeNull()
  })

  it('delete asks first and deletes on confirmation', async () => {
    await h.render(<AutomationSection />)
    await menu('My rule')
    await pickMenu('Delete')
    expect(ion.automationDelete).not.toHaveBeenCalled()
    expect(text()).toContain('Delete My rule?')
    const confirm = [...h.container.querySelectorAll<HTMLButtonElement>('aside button')].find((b) => b.textContent === 'Delete')
    await act(async () => { confirm?.click(); await flush() })
    expect(ion.automationDelete).toHaveBeenCalledWith('u1')
  })

  it('opens a run’s stored evaluation path from the activity list', async () => {
    const run: AutomationHistoryEntry = {
      id: 'r1', automationId: 'u1', eventType: 'worktree:pin-advanced', outcome: 'failed', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z', error: 'stage refused',
    } as AutomationHistoryEntry
    ion.automationHistory.mockResolvedValue([run])
    await h.render(<AutomationSection />)
    const activity = [...h.container.querySelectorAll<HTMLElement>('[aria-label="Recent activity"] [role="listitem"]')]
    expect(activity).toHaveLength(1)
    expect(activity[0].textContent).toContain('My rule')
    await act(async () => { activity[0].click(); await flush() })
    expect(text()).toContain('This older activity record has no step-by-step trace.')
    expect(text()).toContain('Error: stage refused')
  })
})
