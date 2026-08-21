/**
 * clip — recording state machine for the 10-second office clip export
 * (MediaRecorder over canvas.captureStream). Pure reducer core; the
 * component drives MediaRecorder from the transitions.
 */
export type ClipState =
  | { kind: 'idle' }
  | { kind: 'recording'; startedAtMs: number }
  | { kind: 'saving' }

export type ClipEvent =
  | { type: 'start'; atMs: number }
  | { type: 'stop' }
  | { type: 'saved' }
  | { type: 'failed' }

export const CLIP_SECONDS = 10

export function clipReducer(state: ClipState, event: ClipEvent): ClipState {
  switch (event.type) {
    case 'start':
      return state.kind === 'idle' ? { kind: 'recording', startedAtMs: event.atMs } : state
    case 'stop':
      return state.kind === 'recording' ? { kind: 'saving' } : state
    case 'saved':
    case 'failed':
      return state.kind === 'saving' ? { kind: 'idle' } : state
  }
}

/** Seconds remaining in the countdown chip. */
export function clipRemaining(state: ClipState, nowMs: number): number {
  if (state.kind !== 'recording') return 0
  return Math.max(0, CLIP_SECONDS - (nowMs - state.startedAtMs) / 1000)
}
