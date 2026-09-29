/**
 * The engine command carries the server span's traceparent: `send_prompt` and
 * `send_command` both, and the control plane's send adapter forwards it from
 * RunOptions, so the engine's run.execute span is the server span's child.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../identity/request-principal', () => ({ currentPrincipal: () => undefined, currentClaims: () => undefined }))
vi.mock('../../protocol/tabs-index', () => ({ principalSubjectForTab: () => undefined }))

import { buildSendCommandMessage, buildSendPromptMessage } from '../engine-bridge-prompts'
import { bridgeSendAdapter } from '../engine-control-plane-send'
import type { EngineBridge } from '../engine-bridge'
import type { RunOptions } from '@ion/shared/types'

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-1111222233334444-01'

describe('traceparent on the engine command', () => {
  it('send_prompt carries it when present and omits it otherwise', () => {
    expect(buildSendPromptMessage({ key: 't1', text: 'hi', traceparent: TRACEPARENT }).traceparent).toBe(TRACEPARENT)
    expect(buildSendPromptMessage({ key: 't1', text: 'hi' })).not.toHaveProperty('traceparent')
  })

  it('send_command carries it too', () => {
    const msg = buildSendCommandMessage({ key: 't1', text: '/review', traceparent: TRACEPARENT }, 'review', '')
    expect(msg).toMatchObject({ cmd: 'command', command: 'review', traceparent: TRACEPARENT })
  })

  it('the send adapter forwards RunOptions.traceparent to the bridge', async () => {
    const sendPrompt = vi.fn(async () => ({ ok: true }))
    const send = bridgeSendAdapter({ sendPrompt } as unknown as EngineBridge)
    await send('t1', { prompt: 'hi', projectPath: '/p', traceparent: TRACEPARENT } as RunOptions, true)
    expect(sendPrompt).toHaveBeenCalledWith('t1', 'hi', expect.objectContaining({ traceparent: TRACEPARENT }))
  })
})
