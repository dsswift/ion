/**
 * `transcribe.audio`: voice input's audio-to-text pass, run on the server
 * host (`transcribe.ts`). The recording arrives as base64 WAV; the reply is
 * `{ error, transcript }` and never a thrown error, so a missing whisper
 * install reads as install guidance in the input bar rather than a failed
 * action.
 *
 * `conversations:operate`: the transcript becomes operator input.
 */
import { transcribeAudio } from '../transcribe'
import { warn as _warn } from '../logger'
import type { MiscActionSpec } from './misc-actions'

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('transcribe-actions', msg, fields)
}

/** A one-minute recording at 16 kHz mono is under 2 MB; 32 MB of base64 is a generous ceiling against a hostile payload. */
export const MAX_AUDIO_BASE64_LENGTH = 32 * 1024 * 1024

export const TRANSCRIBE_ACTIONS: Record<string, MiscActionSpec> = {
  'transcribe.audio': {
    requiredScope: 'conversations:operate',
    handler: async (conn, args) => {
      const audio = args[0]
      if (typeof audio !== 'string' || audio.length === 0) {
        warn('refused: audio is not a base64 string', { connection_id: conn.id })
        return { ok: false, error: { code: 'invalid_args', message: 'audio must be a non-empty base64 string' } }
      }
      if (audio.length > MAX_AUDIO_BASE64_LENGTH) {
        warn('refused: audio payload too large', { connection_id: conn.id, length: audio.length })
        return { ok: false, error: { code: 'invalid_args', message: 'audio payload too large' } }
      }
      return { ok: true, value: await transcribeAudio(audio) }
    },
  },
}
