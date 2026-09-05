// @vitest-environment jsdom
/**
 * A Project's mounted folders are editable from Settings, not only from the
 * explorer of a tab that happens to be open in that Project.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  addWorkspaceFolder: vi.fn(),
  removeWorkspaceFolder: vi.fn(),
  pickDirectory: vi.fn(async () => '/lib/new' as string | null),
}))
const { addWorkspaceFolder, removeWorkspaceFolder, pickDirectory } = mocks

const state = {
  workspaceFolders: { '/src/ion': ['/lib/shared'] } as Record<string, string[]>,
  addWorkspaceFolder: mocks.addWorkspaceFolder,
  removeWorkspaceFolder: mocks.removeWorkspaceFolder,
}

vi.mock('../../preferences', () => ({
  usePreferencesStore: Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state },
  ),
}))
vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: (_t, key) => `var(--${String(key)})` }),
}))
vi.mock('../../stores/remote-fs-store', () => ({ pickDirectoryForSession: mocks.pickDirectory }))
vi.mock('../../rendererLogger', () => ({ rError: vi.fn() }))

import { ProjectFoldersSection } from './ProjectFoldersSection'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.clearAllMocks()
  pickDirectory.mockResolvedValue('/lib/new')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root.render(<ProjectFoldersSection projectDir="/src/ion" displayName="ion" />)
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('ProjectFoldersSection', () => {
  it("lists the project's mounted folders", () => {
    expect(host.textContent).toContain('/lib/shared')
  })

  it('adds a picked folder under the project key', async () => {
    const button = host.querySelector('[aria-label="Add folder to ion"]')!
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(addWorkspaceFolder).toHaveBeenCalledWith('/src/ion', '/lib/new')
  })

  it('removes a folder from the project key', () => {
    const button = host.querySelector('[aria-label="Remove /lib/shared from ion"]')!
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(removeWorkspaceFolder).toHaveBeenCalledWith('/src/ion', '/lib/shared')
  })
})
