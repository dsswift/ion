/**
 * ProfilerSection — capture a CPU profile or heap snapshot of this desktop's
 * main process or its Studio renderer (`main/profiling/`), into
 * `<data dir>/profiles/`. Shown only where the host can profile itself
 * (Electron) and the `profiling` developer surface is on for this device;
 * each capture ends in a toast naming the file.
 */
import React, { useState } from 'react'
import type { DeveloperSurfaceState } from '@ion/shared/developer-surfaces'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import type { ProfileCaptureRequest, ProfileCaptureResult, ProfileKind, ProfileProcess } from '../../../../shared/desktop-ipc'
import { host } from '../../../host/host-instance'
import { rInfo, rWarn } from '../../../rendererLogger'
import { useEnvironmentDeveloperSurfaces } from '../../../studio/connection/developer-surfaces'
import { EngineNotificationToasts, type EngineNotification } from '../../EngineNotificationToasts'
import { Button, FormGroup, FormRow } from '../kit'

/** CPU sample length the buttons ask for. */
export const PROFILE_CPU_SECONDS = 10

/** Whether this device's policy leaves the `profiling` developer surface on. */
export function profilingSurfaceOn(surfaces: DeveloperSurfaceState): boolean {
  return surfaces.profiling
}

export function ProfilerSection(): React.JSX.Element | null {
  const surfaces = useEnvironmentDeveloperSurfaces(LOCAL_ENVIRONMENT_ID)
  const [running, setRunning] = useState<string | null>(null)
  const [toasts, setToasts] = useState<EngineNotification[]>([])
  const canProfile = typeof host.profileCapture === 'function' && host.capabilities().includes('nativeShell')
  if (!canProfile || !profilingSurfaceOn(surfaces)) return null

  const push = (level: 'info' | 'error', message: string): void => {
    setToasts((cur) => [...cur, { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, message, level, timestamp: Date.now() }])
  }
  const capture = async (process: ProfileProcess, kind: ProfileKind): Promise<void> => {
    const key = `${process}:${kind}`
    const request: ProfileCaptureRequest = { process, kind, ...(kind === 'cpu' ? { seconds: PROFILE_CPU_SECONDS } : {}) }
    setRunning(key)
    rInfo('profiler-section', 'profile capture requested', { process, kind })
    let result: ProfileCaptureResult
    try {
      result = await host.profileCapture!(request)
    } catch (err) {
      result = { ok: false, code: 'failed', error: err instanceof Error ? err.message : String(err) }
    } finally {
      setRunning(null)
    }
    if (result.ok) push('info', `${kind === 'cpu' ? 'CPU profile' : 'Heap snapshot'} of ${process} saved to ${result.path}`)
    else {
      rWarn('profiler-section', 'profile capture failed', { process, kind, code: result.code, error: result.error })
      push('error', `Profile capture failed: ${result.error}`)
    }
  }
  const row = (process: ProfileProcess, label: string, description: string): React.JSX.Element => (
    <FormRow label={label} description={description}>
      <Button disabled={running !== null} onClick={() => { void capture(process, 'heap') }}>{running === `${process}:heap` ? 'Capturing…' : 'Capture heap snapshot'}</Button>
      <Button disabled={running !== null} onClick={() => { void capture(process, 'cpu') }}>{running === `${process}:cpu` ? `Sampling ${PROFILE_CPU_SECONDS}s…` : 'Capture CPU profile'}</Button>
    </FormRow>
  )
  return (
    <>
      <FormGroup title="Profiler" description="Profiles are written under this device's Ion data directory, in profiles/. Open one in Chrome DevTools." anchor="profiler">
        {row('renderer', 'Studio window', 'The renderer process drawing this window.')}
        {row('main', 'Desktop process', 'The Electron main process: connections, windows, the updater.')}
      </FormGroup>
      <EngineNotificationToasts notifications={toasts} onDismiss={(id) => setToasts((cur) => cur.filter((t) => t.id !== id))} />
    </>
  )
}
