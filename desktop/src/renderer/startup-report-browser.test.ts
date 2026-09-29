/**
 * The browser-host path for reportStartup. Separate from startup-report.test.ts,
 * which stubs `window.ion` directly (driving real ElectronStudioHost
 * resolution) -- host-instance.ts caches its resolved host class for the
 * module's lifetime by design, so mocking host-instance directly here is
 * what actually exercises the 'startupReport' capability gate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { startupReport, capabilities } = vi.hoisted(() => ({
  startupReport: vi.fn(),
  capabilities: vi.fn<() => string[]>(),
}))

vi.mock('./host/host-instance', () => ({ host: { capabilities, shell: { startupReport } } }))

import { reportStartup } from './startup-report'

beforeEach(() => {
  startupReport.mockClear()
})

describe('reportStartup without the startupReport capability (browser Studio client)', () => {
  it('does not call host.shell.startupReport', () => {
    capabilities.mockReturnValue(['terminal', 'git', 'files', 'questions', 'graph'])
    reportStartup('studio', 'Synchronizing conversations…')
    expect(startupReport).not.toHaveBeenCalled()
  })
})

describe('reportStartup with the startupReport capability (Electron)', () => {
  it('calls host.shell.startupReport', () => {
    capabilities.mockReturnValue(['startupReport'])
    reportStartup('studio', 'Synchronizing conversations…')
    expect(startupReport).toHaveBeenCalledTimes(1)
  })
})
