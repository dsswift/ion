/**
 * Profile capture for this desktop: main through the inspector
 * (`@ion/shared/node-profile`), the Studio renderer through `webContents.debugger`
 * (`renderer-profile.ts`), both into `<data dir>/profiles/`. One capture at
 * a time; refused outright where device policy switches the `profiling`
 * developer surface off (`profiling-policy.ts`). Every outcome is logged.
 */
import type { EnterprisePolicy } from '@ion/shared/types-enterprise'
import type { ProfileCaptureRequest, ProfileCaptureResult } from '../../shared/desktop-ipc'
import { log as _log, warn as _warn } from '../logger'
import { profilingSurfaceEnabled } from './profiling-policy'
import { captureNodeProfile, clampProfileSeconds, profilesDir } from '@ion/shared/node-profile'
import { captureRendererProfile, type DebuggerLike } from './renderer-profile'

const TAG = 'profiling'
/** Names main in a capture's file name: `desktop-main-cpu-<ts>.cpuprofile`. */
const MAIN_PROCESS_NAME = 'desktop-main'

export interface ProfileCaptureDeps {
  /** This desktop's device policy, read at request time. */
  policy(): EnterprisePolicy | null
  /** The data dir profiles are written under. */
  dataDir(): string
  /** The Studio renderer's debugger, or null with no window. */
  rendererDebugger(): DebuggerLike | null
  /** Test seams; the real captures by default. */
  captureNode?: typeof captureNodeProfile
  captureRenderer?: typeof captureRendererProfile
}

export function isProfileCaptureRequest(v: unknown): v is ProfileCaptureRequest {
  if (!v || typeof v !== 'object') return false
  const r = v as Partial<ProfileCaptureRequest>
  const processOk = r.process === 'main' || r.process === 'renderer'
  const kindOk = r.kind === 'cpu' || r.kind === 'heap'
  const secondsOk = r.seconds === undefined || (typeof r.seconds === 'number' && Number.isFinite(r.seconds) && r.seconds > 0)
  return processOk && kindOk && secondsOk
}

export class ProfileCapturer {
  private busy = false

  constructor(private readonly deps: ProfileCaptureDeps) {}

  async capture(request: unknown): Promise<ProfileCaptureResult> {
    if (!isProfileCaptureRequest(request)) {
      _warn(TAG, 'profile capture refused: malformed request', { request_type: typeof request })
      return { ok: false, code: 'invalid', error: 'malformed profile request' }
    }
    if (!profilingSurfaceEnabled(this.deps.policy())) {
      _warn(TAG, 'profile capture refused: profiling developer surface disabled by device policy', { process: request.process, kind: request.kind })
      return { ok: false, code: 'surface_disabled', error: 'Profiling is switched off by this device’s policy.' }
    }
    if (this.busy) {
      _warn(TAG, 'profile capture refused: another capture is running', { process: request.process, kind: request.kind })
      return { ok: false, code: 'busy', error: 'A profile capture is already running.' }
    }
    const seconds = clampProfileSeconds(request.seconds)
    const outDir = profilesDir(this.deps.dataDir())
    this.busy = true
    const startedAt = Date.now()
    _log(TAG, 'profile capture started', { process: request.process, kind: request.kind, seconds: request.kind === 'cpu' ? seconds : 0, out_dir: outDir })
    try {
      let path: string
      if (request.process === 'main') {
        const captured = await (this.deps.captureNode ?? captureNodeProfile)({
          kind: request.kind,
          seconds,
          dir: this.deps.dataDir(),
          processName: MAIN_PROCESS_NAME,
        })
        path = captured.path
      } else {
        const dbg = this.deps.rendererDebugger()
        if (!dbg) {
          _warn(TAG, 'profile capture refused: no Studio window to profile', { kind: request.kind })
          return { ok: false, code: 'no_window', error: 'There is no Studio window to profile.' }
        }
        path = await (this.deps.captureRenderer ?? captureRendererProfile)(dbg, request.kind, seconds, outDir)
      }
      const durationMs = Date.now() - startedAt
      _log(TAG, 'profile capture written', { process: request.process, kind: request.kind, path, duration_ms: durationMs })
      return { ok: true, path, process: request.process, kind: request.kind, durationMs }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      _warn(TAG, 'profile capture failed', { process: request.process, kind: request.kind, error })
      return { ok: false, code: 'failed', error }
    } finally {
      this.busy = false
    }
  }
}
