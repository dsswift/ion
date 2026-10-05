// @vitest-environment jsdom
/**
 * BuildNoticeDialog — shows the running build, the build it replaced, and
 * the release's What's new notes when it has any; Dismiss closes it and
 * acknowledges the build. Nothing
 * shows without a notice or on a host with no desktop build.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BuildNotice } from '@ion/shared/build-notice'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const shell = vi.hoisted(() => ({ getBuildNotice: vi.fn(), acknowledgeBuildNotice: vi.fn() }))
const caps = vi.hoisted(() => ({ list: ['updates'] as string[] }))

vi.mock('../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rDebug: vi.fn(), rTrace: vi.fn() }))
vi.mock('../../theme', () => ({ useColors: () => ({}) }))
vi.mock('../../components/PopoverLayer', () => ({ usePopoverLayer: () => document.body }))
vi.mock('../../host/host-instance', () => ({ host: { capabilities: () => caps.list, shell } }))

const { BuildNoticeDialog } = await import('../BuildNoticeDialog')

const notice: BuildNotice = {
  current: { version: '2.10.0-dev.abc', builtAt: '2026-10-05T15:00:00.000Z' },
  previous: { version: '2.9.1', builtAt: '2026-10-04T09:00:00.000Z' },
  highlights: [],
}

let container: HTMLDivElement
let root: Root
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const dialog = (): HTMLElement | null => document.body.querySelector('[role="dialog"]')

async function mount(): Promise<void> {
  await act(async () => { root.render(<BuildNoticeDialog />); await flush(); await flush() })
}

beforeEach(() => {
  vi.clearAllMocks()
  caps.list = ['updates']
  shell.acknowledgeBuildNotice.mockResolvedValue(undefined)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('BuildNoticeDialog', () => {
  it('shows the new build and the previous build', async () => {
    shell.getBuildNotice.mockResolvedValue(notice)
    await mount()
    const text = dialog()?.textContent ?? ''
    expect(text).toContain('Ion Studio was updated')
    expect(text).toContain("You're running the latest build.")
    expect(text).toContain('2.10.0-dev.abc')
    expect(text).toContain('Previous')
    expect(text).toContain('2.9.1')
  })

  it("lists the release's What's new notes", async () => {
    shell.getBuildNotice.mockResolvedValue({ ...notice, highlights: ['Studio says when it was updated.', 'Lists show their markers again.'] })
    await mount()
    const items = [...document.body.querySelectorAll('[aria-label="What\'s new"] li')].map((li) => li.textContent)
    expect(items).toEqual(['Studio says when it was updated.', 'Lists show their markers again.'])
  })

  it('shows no What\'s new section for a build with no notes', async () => {
    shell.getBuildNotice.mockResolvedValue(notice)
    await mount()
    expect(dialog()?.textContent).not.toContain("What's new")
  })

  it('closes on Dismiss and acknowledges the build', async () => {
    shell.getBuildNotice.mockResolvedValue(notice)
    await mount()
    const dismiss = [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Dismiss')
    await act(async () => { dismiss?.click(); await flush() })
    expect(dialog()).toBeNull()
    expect(shell.acknowledgeBuildNotice).toHaveBeenCalledTimes(1)
  })

  it('says installed, with no previous build, on the first launch', async () => {
    shell.getBuildNotice.mockResolvedValue({ ...notice, previous: null })
    await mount()
    expect(dialog()?.textContent).toContain('Ion Studio was installed')
    expect(dialog()?.textContent).not.toContain('Previous')
  })

  it('shows nothing when the build is already acknowledged', async () => {
    shell.getBuildNotice.mockResolvedValue(null)
    await mount()
    expect(dialog()).toBeNull()
  })

  it('never asks a host without a desktop build', async () => {
    caps.list = []
    await mount()
    expect(shell.getBuildNotice).not.toHaveBeenCalled()
    expect(dialog()).toBeNull()
  })
})
