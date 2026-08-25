// @vitest-environment jsdom
import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const automationList = vi.fn()
const automationHistory = vi.fn()
const automationSave = vi.fn()
const getEnterprisePolicyFull = vi.fn()
const automationProjectIds = vi.fn()
const setProjectAutomationEnabled = vi.fn()
;(globalThis as unknown as { window: Window }).window = {
  ion: {
    automationList,
    automationHistory,
    automationSave,
    getEnterprisePolicyFull,
    automationProjectIds,
    setProjectAutomationEnabled,
  },
} as unknown as Window
vi.mock('../../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000000' }) }))
vi.mock('../../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn() }))
vi.mock('../../git/HoverCard', () => ({ HoverCard: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
import { AutomationCategory } from '../AutomationCategory'

let container: HTMLDivElement
let root: Root
const automation = {
  id: 'notify-on-pin',
  name: 'Notify on pin advance',
  enabled: true,
  trigger: { kind: 'event' as const, event: 'worktree:pin-advanced' },
  steps: [{ kind: 'desktop:notification', payload: { title: 'Pinned' } }],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  automationList.mockResolvedValue([automation])
  automationHistory.mockResolvedValue([])
  automationSave.mockResolvedValue({ ok: true })
  getEnterprisePolicyFull.mockResolvedValue(null)
  automationProjectIds.mockResolvedValue([])
  setProjectAutomationEnabled.mockResolvedValue({ ok: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(<AutomationCategory />)
    await settle()
  })
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.includes(text),
  )
  if (!button) throw new Error(`missing button ${text}`)
  return button as HTMLButtonElement
}

describe('AutomationCategory', () => {
  it('labels saved definitions as workflows and opens a workflow card for editing', async () => {
    await render()

    expect(automationList).toHaveBeenCalledOnce()
    expect(automationHistory).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Your workflows')
    expect(container.textContent).toContain('When: Worktree update reaches the integration bench')
    expect(container.textContent).toContain('Then: Show desktop notification')

    const card = container.querySelector('[aria-label="Edit workflow Notify on pin advance"]') as HTMLElement
    await act(async () => {
      card.click()
      await Promise.resolve()
    })
    expect(container.querySelector('[aria-label="Automation editor"]')).toBeTruthy()
    expect((container.querySelector('[aria-label="Automation trigger"]') as HTMLSelectElement).value).toBe('worktree:pin-advanced')
  })

  it('persists a toggled workflow definition', async () => {
    await render()
    const checkbox = container.querySelector('[aria-label="Enable Notify on pin advance"]') as HTMLInputElement
    await act(async () => {
      checkbox.click()
      await Promise.resolve()
    })
    expect(automationSave).toHaveBeenCalledWith([
      expect.objectContaining({ id: automation.id, enabled: false }),
    ])
  })

  it('persists the alignment template with the executable slash action', async () => {
    await render()
    await act(async () => {
      buttonWithText('Use Verified runs alignment').click()
      await Promise.resolve()
    })
    await act(async () => {
      buttonWithText('Save automation').click()
      await Promise.resolve()
    })
    const saved = automationSave.mock.calls[0][0] as typeof automation[]
    expect(saved.find((item) => item.name === 'Verified runs alignment')).toMatchObject({
      steps: [{ kind: 'conversation:slash', payload: { command: 'align' } }],
    })
  })

  it('keeps resolved slash commands in the trigger picker, not the action picker', async () => {
    await render()
    await act(async () => {
      buttonWithText('Create workflow').click()
      await Promise.resolve()
    })
    await act(async () => {
      buttonWithText('Add action').click()
      await Promise.resolve()
    })
    expect((container.querySelector('[aria-label="Action kind"]') as HTMLSelectElement).textContent).toContain('Run a slash command')
    expect((container.querySelector('[aria-label="Action kind"]') as HTMLSelectElement).innerHTML).not.toContain('conversation:slash-resolved')
  })

  it('creates the clearer pin-advance template through the editor', async () => {
    await render()
    const label = 'Use When an issue fix reaches the bench, move it to Needs testing'
    await act(async () => {
      buttonWithText(label).click()
      await Promise.resolve()
    })
    expect(container.querySelector('[aria-label="Automation editor"]')).toBeTruthy()
    expect((container.querySelector('[aria-label="Automation trigger"]') as HTMLSelectElement).value).toBe('worktree:pin-advanced')
    await act(async () => {
      buttonWithText('Save automation').click()
      await Promise.resolve()
    })
    const saved = automationSave.mock.calls[0][0] as typeof automation[]
    expect(saved.find((item) => item.name.includes('Needs testing'))).toMatchObject({
      trigger: { event: 'worktree:pin-advanced' },
      steps: [{ kind: 'worktree:set-stage', payload: { stage: 'test', onlyIfStage: 'bug' } }],
    })
  })

  it('explains conditions and branches in the editor', async () => {
    await render()
    await act(async () => {
      buttonWithText('Create workflow').click()
      await Promise.resolve()
    })
    expect(container.textContent).toContain('Run only when all conditions match')
    expect(container.textContent).toContain('Actions to run, in order')
    await act(async () => {
      buttonWithText('Add branch').click()
      await Promise.resolve()
    })
    expect(container.textContent).toContain('If this condition matches')
  })

  it('expands a succeeded activity row into its stored trigger, branch, and action trace', async () => {
    automationHistory.mockResolvedValue([
      {
        id: 'success-1',
        automationId: 'notify-on-pin',
        eventType: 'worktree:pin-advanced',
        causation: { rootId: 'root', chain: ['notify-on-pin'], depth: 1 },
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:01.000Z',
        outcome: 'succeeded',
        trace: {
          trigger: { eventType: 'worktree:pin-advanced' },
          condition: { type: 'none', matched: true },
          causation: { decision: 'continued', input: { rootId: 'root', chain: [], depth: 0 } },
          steps: [{
            type: 'branch',
            condition: { type: 'group', all: [], any: [], matched: true },
            selected: 'then',
            steps: [{ type: 'action', kind: 'worktree:set-stage', outcome: 'succeeded' }],
          }],
        },
      },
    ])
    await render()
    await settle()
    expect(container.textContent).toContain('Show succeeded')
    await act(async () => {
      buttonWithText('Show succeeded').click()
      await Promise.resolve()
    })
    expect(container.textContent).toContain('Trigger received: Worktree update reaches the integration bench')
    expect(container.textContent).toContain('Branch selected: Then actions')
    expect(container.textContent).toContain('Action succeeded: worktree:set-stage')
  })

  it('expands a skipped activity row into its recorded failed condition', async () => {
    automationHistory.mockResolvedValue([
      {
        id: 'skip-1',
        automationId: 'notify-on-pin',
        eventType: 'worktree:pin-advanced',
        causation: { rootId: 'root', chain: [], depth: 0 },
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:00.000Z',
        outcome: 'skipped',
        trace: {
          trigger: { eventType: 'worktree:pin-advanced' },
          condition: {
            type: 'group',
            all: [{ type: 'condition', path: 'payload.stage', operator: 'equals', expected: 'bug', actual: 'test', matched: false }],
            any: [],
            matched: false,
          },
          causation: { decision: 'not-evaluated', input: { rootId: 'root', chain: [], depth: 0 } },
          steps: [],
        },
      },
    ])
    await render()
    await settle()
    expect(container.textContent).toContain('Show skipped')
    await act(async () => {
      buttonWithText('Show skipped').click()
      await Promise.resolve()
    })
    expect(container.textContent).toContain('Conditions: Did not match: payload.stage equals bug (was test)')
    expect(container.textContent).toContain('Causation: Not evaluated after the condition did not match.')
  })
})
