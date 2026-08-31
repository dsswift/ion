import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  send: vi.fn(),
  log: vi.fn(),
}))
vi.mock('../../../conversation-transcript', () => ({ loadConversationTranscript: mocks.load }))
vi.mock('../../../logger', () => ({ log: mocks.log }))
vi.mock('../../../state', () => ({ state: { remoteTransport: { sendToDevice: mocks.send } } }))

import { handleRequestTranscript } from '../conversation-transcript'

beforeEach(() => vi.clearAllMocks())

describe('handleRequestTranscript', () => {
  it('targets and correlates a successful response', async () => {
    mocks.load.mockResolvedValue('[user]: hello')
    await handleRequestTranscript({ type: 'desktop_request_transcript', tabId: 'tab-1', requestId: 'req-1' }, 'device-1')
    expect(mocks.send).toHaveBeenCalledWith('device-1', {
      type: 'desktop_transcript', tabId: 'tab-1', requestId: 'req-1', transcript: '[user]: hello',
    })
  })

  it('echoes correlation on an empty transcript', async () => {
    mocks.load.mockResolvedValue('')
    await handleRequestTranscript({ type: 'desktop_request_transcript', tabId: 'tab-1', requestId: 'req-empty' }, 'device-1')
    expect(mocks.send).toHaveBeenCalledWith('device-1', expect.objectContaining({ requestId: 'req-empty', transcript: '' }))
  })

  it('returns a correlated error response', async () => {
    mocks.load.mockRejectedValue(new Error('missing'))
    await handleRequestTranscript({ type: 'desktop_request_transcript', tabId: 'tab-1', requestId: 'req-error' }, 'device-1')
    expect(mocks.send).toHaveBeenCalledWith('device-1', expect.objectContaining({ requestId: 'req-error', transcript: '', error: 'missing' }))
  })
})
