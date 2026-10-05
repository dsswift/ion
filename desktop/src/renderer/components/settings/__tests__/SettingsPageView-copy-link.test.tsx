// @vitest-environment jsdom
/**
 * SettingsPageView — Copy link. The header button copies the page's
 * `ion://settings` link from the shared builder the server's parser accepts.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settingsLink } from '@ion/shared/deeplink-url'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const copyDeepLink = vi.hoisted(() => vi.fn(async (_url: string) => undefined))
vi.mock('../../../deeplink-client', () => ({ copyDeepLink }))
vi.mock('../../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rDebug: vi.fn() }))
vi.mock('../../../studio/state/environment-settings-store', () => ({
  canManageEnvironment: () => true,
  useEnvironmentSettingsStore: (selector: (s: { byEnvironment: Record<string, unknown> }) => unknown) => selector({ byEnvironment: {} }),
}))

const { SettingsPageView } = await import('../SettingsPageView')

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  copyDeepLink.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('SettingsPageView — Copy link', () => {
  it('copies the page link from the shared builder', () => {
    const page = { id: 'git-access', label: 'Git access', description: '', sections: [] } as unknown as Parameters<typeof SettingsPageView>[0]['page']
    act(() => root.render(<SettingsPageView page={page} sections={[]} anchor={null} />))
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Copy link to this page"]')
    expect(button).not.toBeNull()
    act(() => { button!.click() })
    expect(copyDeepLink).toHaveBeenCalledWith(settingsLink('git-access'))
  })
})
