/**
 * `copyConversationTranscript` calls `host.shell.loadConversationTranscript`
 * on every host: the verb is wire-served (browser-shell-bridge.ts
 * SHELL_INVOKE), so a browser Studio client reporting only the bridged
 * capabilities must reach it, not skip it.
 */
import { describe, expect, it, vi } from 'vitest'

const loadConversationTranscript = vi.hoisted(() => vi.fn(async () => 'the transcript'))

vi.mock('../host/host-instance', () => ({
  host: { shell: { loadConversationTranscript }, capabilities: () => ['terminal', 'git', 'files', 'questions', 'graph'] },
}))

Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } })

import { copyConversationTranscript } from '../copy-conversation'

describe('copyConversationTranscript', () => {
  it('loads the transcript and copies it on a browser host', async () => {
    const result = await copyConversationTranscript('tab-1')
    expect(result).toBe(true)
    expect(loadConversationTranscript).toHaveBeenCalledWith('tab-1')
  })
})
