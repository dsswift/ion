// @vitest-environment jsdom
/**
 * Which machine a new conversation opens on, and how the row offers the
 * others.
 *
 * The window is showing a conversation on another machine throughout, because
 * that is the state the picker once read its default from: a worktree on this
 * machine got its new conversation created on the other one.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const created: Array<{ directory: string; environmentId: string | null }> = []
const close = vi.fn()
const preferenceState = {
  projects: {} as Record<string, { addedManually: boolean; lastUsedAt: number; profileOverride?: { kind: 'plain' } }>,
  engineProfiles: [] as Array<{ id: string; name: string; extensions: string[] }>,
  enterpriseNewConversationDefaults: null,
  enterprisePolicy: null,
  directoryUsageCounts: {} as Record<string, number>,
}
const remoteProject = (dir: string, repoRemote: string) => ({ dir, entry: { addedManually: true, lastUsedAt: 0, repoRemote }, displayName: dir.split('/').pop()!, exists: true, isGitRepo: true })
// One project per case the row has to render: `ion` on three machines,
// `apex` on this one and grover, `solo` only here, `billing` only elsewhere.
const projectsByEnvironment: Record<string, ReturnType<typeof remoteProject>[]> = {
  local: [remoteProject('/Users/me/src/ion', 'github.com/o/ion'), remoteProject('/Users/me/src/apex', 'github.com/o/apex'), remoteProject('/Users/me/src/solo', 'github.com/o/solo')],
  grover: [remoteProject('/home/g/src/ion', 'github.com/o/ion'), remoteProject('/home/g/src/apex', 'github.com/o/apex')],
  work: [remoteProject('/Users/w/src/billing', 'github.com/o/billing'), remoteProject('/Users/w/src/ion', 'github.com/o/ion')],
}

vi.mock('../../theme', () => ({ useColors: () => ({ scrim: '#000', popoverBg: '#111', popoverBorder: '#222', popoverShadow: 'none', textPrimary: '#fff', textSecondary: '#ccc', textTertiary: '#999', tabActive: '#333', accent: 'rgb(1, 1, 1)', iconPurple: 'rgb(2, 2, 2)', accentLight: '#024', containerBorder: '#444', statusError: '#f00', surfaceHover: 'rgb(3, 3, 3)', surfacePressed: 'rgb(4, 4, 4)', surfaceSelected: '#036', accentBorderMedium: '#048' }) }))
vi.mock('../../components/PopoverLayer', () => ({ usePopoverLayer: () => document.body }))
vi.mock('../../preferences', () => ({ usePreferencesStore: (selector: (state: typeof preferenceState) => unknown) => selector(preferenceState) }))
vi.mock('../../rendererLogger', () => ({ rInfo: vi.fn(), rError: vi.fn(), rWarn: vi.fn(), rDebug: vi.fn() }))
vi.mock('../../studio/connection/catalog', () => ({ readCatalog: async () => [{ id: 'local', label: 'This Mac' }, { id: 'grover', label: 'grover' }, { id: 'work', label: 'dcitag8331' }] }))
vi.mock('../../studio/connection/select-when-present', () => ({ selectTabWhenPresent: vi.fn() }))
vi.mock('../settings/environment/environment-client', () => ({
  environmentClient: { listProjects: async (env: string) => projectsByEnvironment[env] ?? [] },
  onEnvironmentEvent: () => () => {},
}))
// The forwarded action reads its target Environment synchronously at the top
// of the call; the probe reads the same value at the same moment.
const probe = vi.hoisted(() => ({ target: (): string | null => null, refuseWith: null as string | null }))
vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      // The operator is looking at a conversation on grover.
      tabs: [{ id: 'grover-tab', environmentId: 'grover' }],
      settledHistory: [],
      activeTabId: 'grover-tab',
      createConversationTab: (directory: string) => { if (probe.refuseWith) return Promise.reject(new Error(probe.refuseWith)); created.push({ directory, environmentId: probe.target() }); return Promise.resolve('tab-created') },
    }),
  },
}))

import { NewConversationPicker } from '../NewConversationPicker'
import { installFakeWire } from '../../host/__tests__/fake-wire'
import { explicitTargetEnvironment } from '../../studio/connection/tab-environment'

probe.target = explicitTargetEnvironment

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

async function render(props: Partial<React.ComponentProps<typeof NewConversationPicker>> = {}): Promise<void> {
  root = createRoot(container)
  await act(async () => { root.render(<NewConversationPicker onClose={close} {...props} />); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
}
const titleOf = (button: Element): string => button.querySelector('span > span')?.textContent ?? ''
const rows = (name: string): HTMLButtonElement[] => [...document.querySelectorAll('button')].filter((button) => titleOf(button) === name)
const row = (name: string): HTMLButtonElement => rows(name)[0]
/** The row's trailing machine control: its text, or [] when the row carries none. */
const trailingOf = (name: string): string[] => {
  const trailing = row(name).lastElementChild?.querySelector('span[aria-label]')
  return trailing ? [trailing.textContent ?? ''] : []
}
const trailingButton = (name: string): HTMLElement => row(name).querySelector('[role="button"]') as HTMLElement
/** The colour the row's second line paints its machine name. */
const machineColor = (name: string): string | undefined =>
  [...row(name).querySelectorAll('span')].find((span) => span.style.color && span.textContent && !span.textContent.includes('/'))?.style.color
const ACCENT = 'rgb(1, 1, 1)'
const REMOTE = 'rgb(2, 2, 2)'
const click = async (element: Element): Promise<void> => { await act(async () => { (element as HTMLElement).click(); await Promise.resolve(); await Promise.resolve() }) }
const menuItems = (): HTMLElement[] => [...document.querySelectorAll('[role="menuitem"]')] as HTMLElement[]
/** React derives onMouseEnter/Leave from mouseover/mouseout, so that is what a hover is here. */
const hover = async (element: Element): Promise<void> => { await act(async () => { element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); await Promise.resolve() }) }
const unhover = async (element: Element): Promise<void> => { await act(async () => { element.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })); await Promise.resolve() }) }
const HOVER_BG = 'rgb(3, 3, 3)'

beforeEach(() => {
  vi.clearAllMocks()
  created.length = 0
  probe.refuseWith = null
  // Every project resolves to a plain conversation, so choosing one creates it.
  preferenceState.projects = {
    '/Users/me/src/ion': { addedManually: true, lastUsedAt: 0, profileOverride: { kind: 'plain' } },
    '/Users/me/src/apex': { addedManually: true, lastUsedAt: 0, profileOverride: { kind: 'plain' } },
    '/Users/me/src/solo': { addedManually: true, lastUsedAt: 0, profileOverride: { kind: 'plain' } },
  }
  // `apex` sorts first by name and last by use, so the two orders are never
  // the same list and a passing assertion cannot be an accident.
  preferenceState.directoryUsageCounts = { '/Users/me/src/ion': 1383, '/Users/me/src/apex': 2 }
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  Object.assign(window, { ion: installFakeWire({ resolveNewConversationDefaults: vi.fn().mockResolvedValue(null) }) })
})

afterEach(() => { act(() => root.unmount()); container.remove() })

describe('NewConversationPicker — the machine a row opens on', () => {
  it('names the machine in the detail line rather than in a pill', async () => {
    await render()
    expect(row('ion').textContent).toContain('This Mac · /Users/me/src/ion')
    expect(row('billing').textContent).toContain('dcitag8331 · /Users/w/src/billing')
  })

  // Colour is what separates a remote row from a local one now, and it has to
  // do it on its own: nothing else on the row differs.
  it('paints this machine in the accent and every other in the remote colour', async () => {
    await render()
    expect(machineColor('ion')).toBe(ACCENT)
    expect(machineColor('solo')).toBe(ACCENT)
    expect(machineColor('billing')).toBe(REMOTE)
  })

  it('a click on the row opens on this machine, whatever conversation the window is showing', async () => {
    await render()
    await click(row('ion'))
    expect(created).toEqual([{ directory: '/Users/me/src/ion', environmentId: 'local' }])
  })

  it('a click on the row of a project this machine lacks opens on the machine that has it', async () => {
    await render()
    await click(row('billing'))
    expect(created).toEqual([{ directory: '/Users/w/src/billing', environmentId: 'work' }])
  })

  // The right-hand side is only ever the offer, so a project no other
  // machine has carries nothing there -- local or remote alike.
  it('puts nothing on the right when no other machine has the project', async () => {
    await render()
    expect(trailingOf('solo')).toEqual([])
    expect(trailingOf('billing')).toEqual([])
    await click(row('solo'))
    expect(created).toEqual([{ directory: '/Users/me/src/solo', environmentId: 'local' }])
  })

  it('offers one chip when exactly one other machine has it, and opens there in one click', async () => {
    await render()
    expect(trailingOf('apex')).toEqual(['grover'])
    await click(trailingButton('apex'))
    expect(created).toEqual([{ directory: '/home/g/src/apex', environmentId: 'grover' }])
    expect(close).toHaveBeenCalled()
  })

  it('offers a counted button when several others have it, listing them on click', async () => {
    await render()
    expect(trailingOf('ion')).toEqual(['+2'])

    await click(trailingButton('ion'))
    expect(menuItems().map((item) => item.textContent)).toEqual([
      expect.stringContaining('grover'),
      expect.stringContaining('dcitag8331'),
    ])

    await click(menuItems()[1])
    expect(created).toEqual([{ directory: '/Users/w/src/ion', environmentId: 'work' }])
  })

  it('never offers the machine the row already opens on', async () => {
    await render()
    expect(trailingOf('ion')).not.toContain('This Mac')
    expect(trailingOf('apex')).not.toContain('This Mac')
  })

  it('stays open and says why when the machine refuses the conversation', async () => {
    probe.refuseWith = 'This machine does not have /home/g/src/apex.'
    await render()
    await click(trailingButton('apex'))
    expect(close).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('This machine does not have /home/g/src/apex.')
  })

  // The reported failure: a local worktree's "New conversation", with a
  // conversation on grover in view, was created on grover. With no
  // conversation profiles there is one conversation type, so a picker that
  // already has its directory creates at once.
  it('a picker opened with a directory opens on this machine, never the active tab\'s', async () => {
    await render({ initialDirectory: '/Users/me/.ion/worktrees/ion-abc' })
    expect(created).toEqual([{ directory: '/Users/me/.ion/worktrees/ion-abc', environmentId: 'local' }])
  })

  it('a picker opened with a directory on another machine opens on the machine the caller names', async () => {
    await render({ initialDirectory: '/Users/w/.ion/worktrees/billing-abc', initialEnvironmentId: 'work' })
    expect(created).toEqual([{ directory: '/Users/w/.ion/worktrees/billing-abc', environmentId: 'work' }])
  })
})

describe('NewConversationPicker — ordering and grouping', () => {
  const names = (): string[] => [...document.querySelectorAll('button')]
    .map(titleOf)
    .filter((name) => ['ion', 'apex', 'billing', 'solo'].includes(name))
  const openMenu = async (label: string): Promise<void> => {
    await click([...document.querySelectorAll('button')].find((button) => button.textContent?.includes(label))!)
  }
  const chooseOption = async (label: string): Promise<void> => {
    await click([...document.querySelectorAll('[role="menuitemradio"]')].find((item) => item.textContent?.includes(label))!)
  }

  it('orders by recorded use by default, not by name', async () => {
    await render()
    expect(names()).toEqual(['ion', 'apex', 'solo', 'billing'])
  })

  it('orders by name when asked, and remembers the choice', async () => {
    await render()
    await openMenu('Most used')
    await chooseOption('A to Z')
    expect(names()).toEqual(['apex', 'ion', 'solo', 'billing'])

    act(() => root.unmount())
    await render()
    expect(names()).toEqual(['apex', 'ion', 'solo', 'billing'])
  })

  // The mode exists to show what each machine has, so a project on three
  // machines is listed under all three, and opens on the section it was
  // clicked in. The section names the machine, so the rows inside it do not
  // repeat it in their detail line or offer it again as an alternative.
  it('groups by machine, opens a row on its section\'s machine, and drops the per-row controls', async () => {
    await render()
    await openMenu('This Mac first')
    await chooseOption('By machine')

    const ionRows = rows('ion')
    expect(ionRows).toHaveLength(3)
    expect(ionRows[1].textContent).toContain('/home/g/src/ion')
    expect(ionRows[1].textContent).not.toContain('grover ·')
    // The heading names the machine for every row under it, so the rows
    // neither colour it nor offer one.
    expect(machineColor('ion')).toBeUndefined()
    expect(ionRows[1].querySelectorAll('[role="button"]')).toHaveLength(0)

    await click(ionRows[1])
    expect(created).toEqual([{ directory: '/home/g/src/ion', environmentId: 'grover' }])
  })

  it('collapses a machine section and stops the keyboard entering it', async () => {
    await render()
    await openMenu('This Mac first')
    await chooseOption('By machine')
    const groverHeader = [...document.querySelectorAll('button[aria-expanded]')].find((header) => header.textContent?.includes('grover'))!
    await click(groverHeader)

    expect(groverHeader.getAttribute('aria-expanded')).toBe('false')
    expect(rows('ion')).toHaveLength(2)
  })
})

describe('NewConversationPicker — the controls answer the pointer', () => {
  // Without this the chip is indistinguishable from a label, and the only way
  // to learn it is clickable is to click it.
  it('lights the machine chip on hover and clears it on leave', async () => {
    await render()
    const chip = trailingButton('apex')
    expect(chip.style.background).not.toBe(HOVER_BG)

    await hover(chip)
    expect(chip.style.background).toBe(HOVER_BG)

    await unhover(chip)
    expect(chip.style.background).not.toBe(HOVER_BG)
  })

  it('lights the counted dropdown on hover', async () => {
    await render()
    const dropdown = trailingButton('ion')
    expect(dropdown.textContent).toContain('+2')
    await hover(dropdown)
    expect(dropdown.style.background).toBe(HOVER_BG)
  })

  it('lights a sort or grouping button on hover', async () => {
    await render()
    const sort = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Most used'))!
    await hover(sort)
    expect(sort.style.background).toBe(HOVER_BG)
  })

  // A button whose menu is open stays lit, so the open menu is attributable
  // to the control that opened it.
  it('keeps a control lit while its menu is open, and says so', async () => {
    await render()
    const sort = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Most used'))!
    expect(sort.getAttribute('aria-expanded')).toBe('false')

    await click(sort)
    expect(sort.getAttribute('aria-expanded')).toBe('true')
    expect(sort.style.background).not.toBe('transparent')
  })

  it('lights a menu row on hover without losing the tick on the chosen one', async () => {
    await render()
    const sort = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Most used'))!
    await click(sort)
    const options = [...document.querySelectorAll('[role="menuitemradio"]')] as HTMLElement[]
    const chosen = options.find((option) => option.getAttribute('aria-checked') === 'true')!

    await hover(chosen)
    expect(chosen.style.background).toBe(HOVER_BG)
    expect(chosen.getAttribute('aria-checked')).toBe('true')
  })
})
