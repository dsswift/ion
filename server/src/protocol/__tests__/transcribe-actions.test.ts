import { beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({ transcribeAudio: vi.fn(async () => ({ error: null, transcript: 'hello' })) }))
vi.mock('../../transcribe', () => ({ transcribeAudio: deps.transcribeAudio }))
vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { MAX_AUDIO_BASE64_LENGTH, TRANSCRIBE_ACTIONS } from '../transcribe-actions'
import type { Connection } from '../connection'

const conn = { id: 'c' } as unknown as Connection
beforeEach(() => deps.transcribeAudio.mockClear())

describe('transcribe.audio', () => {
  it('hands a base64 recording to the transcriber and returns its result verbatim', async () => {
    expect(await TRANSCRIBE_ACTIONS['transcribe.audio'].handler(conn, ['UklGRg=='])).toEqual({ ok: true, value: { error: null, transcript: 'hello' } })
    expect(deps.transcribeAudio).toHaveBeenCalledWith('UklGRg==')
  })

  it('refuses a missing, empty, or oversized payload before spawning anything', async () => {
    expect(await TRANSCRIBE_ACTIONS['transcribe.audio'].handler(conn, [])).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    expect(await TRANSCRIBE_ACTIONS['transcribe.audio'].handler(conn, [''])).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    expect(await TRANSCRIBE_ACTIONS['transcribe.audio'].handler(conn, ['x'.repeat(MAX_AUDIO_BASE64_LENGTH + 1)])).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    expect(deps.transcribeAudio).not.toHaveBeenCalled()
  })

  it('is conversations:operate', () => {
    expect(TRANSCRIBE_ACTIONS['transcribe.audio'].requiredScope).toBe('conversations:operate')
  })
})
