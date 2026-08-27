// @vitest-environment jsdom
import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  addProject: vi.fn(),
  removeProject: vi.fn(),
  setDefaultProject: vi.fn(),
  setProjectName: vi.fn(),
  setProjectProfileOverride: vi.fn(),
  pickDirectoryForSession: vi.fn(),
}))
const { addProject, removeProject, setDefaultProject, setProjectName, setProjectProfileOverride, pickDirectoryForSession } = mocks

vi.mock('../../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000000' }) }))
vi.mock('../../../rendererLogger', () => ({ rError: vi.fn() }))
vi.mock('../../../stores/remote-fs-store', () => ({ pickDirectoryForSession: mocks.pickDirectoryForSession }))
vi.mock('../../../preferences', () => ({
  usePreferencesStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    projects: {
      '/work/alpha': { addedManually: true, lastUsedAt: 0, isDefault: true },
      '/work/beta': { addedManually: true, lastUsedAt: 0, name: 'Beta' },
    },
    engineProfiles: [{ id: 'dev', name: 'Development', extensions: [] }],
    addProject: mocks.addProject,
    removeProject: mocks.removeProject,
    setDefaultProject: mocks.setDefaultProject,
    setProjectName: mocks.setProjectName,
    setProjectProfileOverride: mocks.setProjectProfileOverride,
  }),
}))

import { ProjectsCategory } from '../ProjectsCategory'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  pickDirectoryForSession.mockResolvedValue('/work/new-project')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('ProjectsCategory', () => {
  it('manages project defaults, names, profiles, removal, and directory addition', async () => {
    await act(async () => { root.render(<ProjectsCategory />) })

    expect(container.textContent).toContain('/work/alpha')
    expect(container.textContent).toContain('/work/beta')

    await act(async () => {
      (container.querySelector('[aria-label="Set Beta as default project"]') as HTMLButtonElement).click()
      const name = container.querySelector('[aria-label="Beta project name"]') as HTMLInputElement
      setInputValue(name, 'Beta renamed')
      const profile = container.querySelector('[aria-label="Beta profile"]') as HTMLSelectElement
      profile.value = 'profile:dev'
      profile.dispatchEvent(new Event('change', { bubbles: true }))
      ;(container.querySelector('[aria-label="Remove Beta project"]') as HTMLButtonElement).click()
      ;(container.querySelector('[aria-label="Add project"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })

    expect(setDefaultProject).toHaveBeenCalledWith('/work/beta')
    await act(async () => {
      (container.querySelector('[aria-label="Clear alpha as default project"]') as HTMLButtonElement).click()
    })
    expect(setDefaultProject).toHaveBeenLastCalledWith(null)
    expect(setProjectName).toHaveBeenCalledWith('/work/beta', 'Beta renamed')
    expect(setProjectProfileOverride).toHaveBeenCalledWith('/work/beta', { kind: 'profile', profileId: 'dev' })
    expect(removeProject).toHaveBeenCalledWith('/work/beta')
    expect(pickDirectoryForSession).toHaveBeenCalledWith({ currentPath: '/work/alpha' })
    expect(addProject).toHaveBeenCalledWith('/work/new-project')
  })
})
