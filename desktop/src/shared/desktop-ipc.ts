/**
 * IPC channels that exist only between this desktop's renderer and its own
 * main process: nothing here has a Studio-wire or iOS form, so the names
 * live beside the other desktop-only cross-process types rather than in
 * `@ion/shared/types`'s `IPC` table.
 */
export const DESKTOP_IPC = {
  /**
   * Renderer → main, one-way: how long one `studio_action` took as the
   * renderer saw it (sent → result), so main can subtract its own wire time
   * for the same frame id and report the IPC hop in the client window line.
   */
  STUDIO_ACTION_TIMING: 'studio:action-timing',
  /** Renderer → main, invoke: capture a CPU profile or heap snapshot of one process. */
  PROFILE_CAPTURE: 'profile:capture',
} as const

/** One renderer-side action timing, the payload of `STUDIO_ACTION_TIMING`. */
export interface StudioActionTiming {
  environmentId: string
  id: string
  /** Renderer clock: `studio_action` handed to the host → `studio_action_result` seen. */
  rendererMs: number
}

export type ProfileProcess = 'main' | 'renderer'
export type ProfileKind = 'cpu' | 'heap'

/** The request of `PROFILE_CAPTURE`. */
export interface ProfileCaptureRequest {
  process: ProfileProcess
  kind: ProfileKind
  /** CPU only: how long to sample. Clamped by main. */
  seconds?: number
}

export type ProfileCaptureResult =
  | { ok: true; path: string; process: ProfileProcess; kind: ProfileKind; durationMs: number }
  | { ok: false; error: string; code: 'surface_disabled' | 'busy' | 'no_window' | 'failed' | 'invalid' }

/**
 * The command-line argument main hands the Studio window at creation
 * (`webPreferences.additionalArguments`) carrying its `app.launch`
 * traceparent, so the renderer's boot spans join the launch trace.
 */
export const LAUNCH_TRACEPARENT_ARG = '--ion-launch-traceparent='

/** The launch traceparent in a preload's `process.argv`, or null when main passed none. */
export function launchTraceparentFromArgv(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (arg.startsWith(LAUNCH_TRACEPARENT_ARG)) {
      const value = arg.slice(LAUNCH_TRACEPARENT_ARG.length)
      return value === '' ? null : value
    }
  }
  return null
}
