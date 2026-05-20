/**
 * Update Store — State Machine Tests
 *
 * Verifies the Zustand store that drives the auto-update icon and dialog.
 * Pure store tests — no React rendering or DOM required.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { useUpdateStore } from '../stores/update-store'

beforeEach(() => {
  useUpdateStore.setState({ version: null, dialogOpen: false })
})

describe('update-store', () => {
  it('starts with no update and dialog closed', () => {
    const { version, dialogOpen } = useUpdateStore.getState()
    expect(version).toBe(null)
    expect(dialogOpen).toBe(false)
  })

  it('setAvailable sets version and opens dialog', () => {
    useUpdateStore.getState().setAvailable('2.0.0')
    const { version, dialogOpen } = useUpdateStore.getState()
    expect(version).toBe('2.0.0')
    expect(dialogOpen).toBe(true)
  })

  it('hideDialog closes dialog but keeps version', () => {
    useUpdateStore.getState().setAvailable('2.0.0')
    useUpdateStore.getState().hideDialog()
    const { version, dialogOpen } = useUpdateStore.getState()
    expect(version).toBe('2.0.0')
    expect(dialogOpen).toBe(false)
  })

  it('showDialog re-opens dialog', () => {
    useUpdateStore.getState().setAvailable('2.0.0')
    useUpdateStore.getState().hideDialog()
    useUpdateStore.getState().showDialog()
    const { version, dialogOpen } = useUpdateStore.getState()
    expect(version).toBe('2.0.0')
    expect(dialogOpen).toBe(true)
  })

  it('setAvailable with new version overwrites and re-opens', () => {
    useUpdateStore.getState().setAvailable('2.0.0')
    useUpdateStore.getState().hideDialog()
    useUpdateStore.getState().setAvailable('3.0.0')
    const { version, dialogOpen } = useUpdateStore.getState()
    expect(version).toBe('3.0.0')
    expect(dialogOpen).toBe(true)
  })
})
