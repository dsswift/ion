/**
 * A client's `!` command: the row the store adds carries the id the client
 * sent it under, which is how the client's pending bubble finds the row that
 * replaces it.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../host-api', () => ({
  executeBash: vi.fn(() => new Promise(() => {})),
  sendRemote: vi.fn(),
}))
vi.mock('../../session-store-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session-store-helpers')>()),
  playNotificationIfHidden: vi.fn(async () => {}),
}))

import { createSendBashSlice } from '../send-slice-bash'
import type { State } from '../../session-store-types'

function store() {
  let state = {
    tabs: [{ id: 'tab-1', title: 'T', customTitle: true, workingDirectory: '/p', bashExecuting: false }],
    conversationPanes: new Map([['tab-1', { activeInstanceId: 'main', instances: [{ id: 'main', messages: [] }] }]]),
    scrollToBottomCounter: 0,
  } as unknown as State
  const set = (fn: (s: State) => Partial<State>) => { state = { ...state, ...fn(state) } }
  const get = () => state
  const slice = createSendBashSlice(set as never, get)
  return { slice, rows: () => state.conversationPanes.get('tab-1')!.instances[0].messages }
}

describe('submitRemoteBash', () => {
  it('stamps the client message id on the user row', () => {
    const { slice, rows } = store()
    slice.submitRemoteBash!('tab-1', 'ls', 'client-msg-1')
    const [user, tool] = rows()
    expect(user).toMatchObject({ role: 'user', content: '! ls', clientMsgId: 'client-msg-1' })
    expect(tool).not.toHaveProperty('clientMsgId')
  })

  it('adds no client message id when none was sent', () => {
    const { slice, rows } = store()
    slice.submitRemoteBash!('tab-1', 'ls')
    expect(rows()[0]).not.toHaveProperty('clientMsgId')
  })
})
