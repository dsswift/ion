import { beforeEach, describe, expect, it, vi } from 'vitest'

const broadcast = vi.hoisted(() => vi.fn())
vi.mock('../broadcast', () => ({ broadcast }))
vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { _resetStartupSequenceForTest, reportStartup, startupReportForAttach } from './startup-progress'

describe('server startup progress', () => {
  beforeEach(() => {
    broadcast.mockClear()
    _resetStartupSequenceForTest()
  })

  it('publishes each report on the startup channel with a forward-only sequence', () => {
    reportStartup('Loading saved tabs…')
    reportStartup('Restoring tab 1 of 12…')
    expect(broadcast.mock.calls).toEqual([
      ['startup:progress', { source: 'server', sequence: 0, status: 'Loading saved tabs…', ready: false }],
      ['startup:progress', { source: 'server', sequence: 1, status: 'Restoring tab 1 of 12…', ready: false }],
    ])
  })

  it('offers the latest report to a late attacher, including the terminal one', () => {
    expect(startupReportForAttach()).toBeNull()
    reportStartup('Restoring tab 4 of 12…')
    expect(startupReportForAttach()).toMatchObject({ sequence: 0, status: 'Restoring tab 4 of 12…' })
    // The desktop's reveal waits on this report; a restore that finishes
    // before the desktop's wire opens must still be able to deliver it.
    reportStartup('Workspace ready', true)
    expect(startupReportForAttach()).toMatchObject({ sequence: 1, status: 'Workspace ready', ready: true })
  })

  it('offers the failure to a late attacher', () => {
    reportStartup('Ion could not start', false, 'tabs.json unreadable')
    expect(startupReportForAttach()).toMatchObject({ sequence: 0, error: 'tabs.json unreadable' })
  })

  it('carries an error when restoration fails', () => {
    expect(reportStartup('Ion could not start', false, 'tabs.json unreadable')).toEqual({
      source: 'server', sequence: 0, status: 'Ion could not start', ready: false, error: 'tabs.json unreadable',
    })
  })
})
