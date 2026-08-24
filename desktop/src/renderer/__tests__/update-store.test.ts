/** Update Store — State Machine Tests */
import { describe, it, expect, beforeEach } from 'vitest'
import { useUpdateStore } from '../stores/update-store'

beforeEach(() => {
  useUpdateStore.setState({ version: null, dialogOpen: false, progress: null, staged: false, error: null })
})

describe('update-store', () => {
  it('starts with no update and dialog closed', () => {
    const { version, dialogOpen, progress, staged, error } = useUpdateStore.getState()
    expect({ version, dialogOpen, progress, staged, error }).toEqual({ version: null, dialogOpen: false, progress: null, staged: false, error: null })
  })

  it('setAvailable opens the ready-to-install dialog', () => {
    useUpdateStore.getState().setAvailable('2.0.0')
    expect(useUpdateStore.getState().version).toBe('2.0.0')
    expect(useUpdateStore.getState().dialogOpen).toBe(true)
  })

  it('tracks download progress until the update becomes ready', () => {
    useUpdateStore.getState().setProgress(42.4, 'downloading')
    expect(useUpdateStore.getState().progress).toBe(42.4)
    useUpdateStore.getState().setAvailable('2.0.0')
    expect(useUpdateStore.getState().progress).toBeNull()
  })

  it('marks the update staged so the dialog can offer Restart', () => {
    useUpdateStore.getState().setAvailable('2.0.0')
    useUpdateStore.getState().setStaged()
    expect(useUpdateStore.getState().staged).toBe(true)
    expect(useUpdateStore.getState().dialogOpen).toBe(true)
  })

  it('makes an update failure visible', () => {
    useUpdateStore.getState().setError('Ion could not download the update')
    expect(useUpdateStore.getState().error).toBe('Ion could not download the update')
    expect(useUpdateStore.getState().dialogOpen).toBe(true)
  })

  it('hideDialog closes dialog but keeps the available version', () => {
    useUpdateStore.getState().setAvailable('2.0.0')
    useUpdateStore.getState().hideDialog()
    expect(useUpdateStore.getState().version).toBe('2.0.0')
    expect(useUpdateStore.getState().dialogOpen).toBe(false)
  })
})
