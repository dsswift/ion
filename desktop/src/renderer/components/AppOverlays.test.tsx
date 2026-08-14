// @vitest-environment jsdom
/**
 * Global overlays exclude worktree-conflict popups. Conflict state belongs in
 * Git panel and row controls, which retain their resolver entry points without
 * covering another application on the operator's monitor.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('./UpdateDialog', () => ({
  UpdateDialog: () => <div data-testid="update-dialog" />,
}))
vi.mock('./RemoteDirectoryPicker', () => ({
  RemoteDirectoryPicker: () => <div data-testid="remote-directory-picker" />,
}))
vi.mock('./DeepLinkConfirmDialog', () => ({
  DeepLinkConfirmDialog: () => <div data-testid="deep-link-confirm-dialog" />,
}))

const conflictAlerts = new Map([['/repo/worktree', { operationState: 'rebasing' }]])
vi.mock('../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    <T,>(selector: (state: { gitConflictAlerts: typeof conflictAlerts }) => T): T =>
      selector({ gitConflictAlerts: conflictAlerts }),
    { getState: () => ({ gitConflictAlerts: conflictAlerts }) },
  ),
}))

import { AppOverlays } from './AppOverlays'

const OVERLAYS = resolve(__dirname, 'AppOverlays.tsx')
const CONFLICT_TOASTS = resolve(__dirname, 'ConflictToasts.tsx')

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('AppOverlays', () => {
  it('never mounts a floating conflict popup, even when conflict state exists', () => {
    // Conflict state exists, but global overlays intentionally have no surface
    // that consumes it. Git panel and worktree rows remain its UI owners.
    expect(conflictAlerts.size).toBe(1)

    act(() => root.render(<AppOverlays />))

    expect(host.querySelector('[data-testid^="conflict-toast-"]')).toBeNull()
    expect(existsSync(CONFLICT_TOASTS)).toBe(false)
    expect(readFileSync(OVERLAYS, 'utf8')).not.toContain('ConflictToasts')
  })

  it('keeps remaining application-level overlays mounted', () => {
    act(() => root.render(<AppOverlays />))

    expect(host.querySelector('[data-testid="deep-link-confirm-dialog"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="update-dialog"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="remote-directory-picker"]')).not.toBeNull()
  })
})
