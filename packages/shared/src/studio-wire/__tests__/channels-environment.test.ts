/**
 * A channel the server broadcasts but this contract does not list is dropped
 * before it reaches any client, silently. `ion:discovery` shipped that way.
 * Pin the environment-admin channels by the constants their producers use.
 */
import { describe, expect, it } from 'vitest'
import { EVENT_CHANNEL_NAMES, channelDeliveredToView, eventChannelScope } from '../channels'
import { IPC } from '../../types-ipc'
import { CLIENTS_CHANGED_CHANNEL, DISCOVERY_CHANNEL, PROJECT_JOB_CHANNEL, PROJECTS_CHANGED_CHANNEL } from '../../types-environment-admin'

describe('environment admin channels', () => {
  it.each([DISCOVERY_CHANNEL, CLIENTS_CHANGED_CHANNEL, PROJECT_JOB_CHANNEL, PROJECTS_CHANGED_CHANNEL])('%s is on the wire, environment-scoped', (channel) => {
    expect(EVENT_CHANNEL_NAMES.has(channel)).toBe(true)
    expect(eventChannelScope(channel)).toBe('environment')
  })
})

describe('channels a phone administering its server needs', () => {
  it.each([
    'ion:mcp-servers-changed', CLIENTS_CHANGED_CHANNEL, DISCOVERY_CHANNEL, IPC.PROVIDER_LOGIN_EVENT,
    PROJECTS_CHANGED_CHANNEL, PROJECT_JOB_CHANNEL, IPC.REMOTE_RELAYS_CHANGED,
  ])('%s reaches thin and mirror connections', (channel) => {
    expect(channelDeliveredToView(channel, 'thin')).toBe(true)
    expect(channelDeliveredToView(channel, 'mirror')).toBe(true)
  })

  it('keeps the sign-in page broadcast off thin connections, which get the URL in their action result', () => {
    expect(channelDeliveredToView(IPC.OPEN_AUTH_URL, 'thin')).toBe(false)
  })
})
