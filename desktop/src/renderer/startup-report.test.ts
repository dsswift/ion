import { describe, expect, it, beforeEach, vi } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join, relative, resolve } from 'path'
import type { StartupReport } from '../shared/startup-state'
import { reportStartup } from './startup-report'

const sent: StartupReport[] = []

beforeEach(() => {
  sent.length = 0
  vi.stubGlobal('window', {
    ion: { startupReport: (report: StartupReport) => sent.push(report) },
  })
})

describe('startup progress reporting', () => {
  it('advances one sequence per source across every caller', () => {
    reportStartup('owner', 'Loading saved tabs…')
    reportStartup('owner', 'Restoring tab 1 of 2…')
    reportStartup('studio', 'Synchronizing conversations…')
    reportStartup('owner', 'Ion is ready', true)

    expect(sent.map((r) => [r.source, r.sequence])).toEqual([
      ['owner', 1],
      ['owner', 2],
      ['studio', 1],
      ['owner', 3],
    ])
  })

  it('keeps a ready report ahead of the progress that preceded it', () => {
    // The coordinator drops any report whose sequence is not ahead of the last
    // accepted one for that source. A ready report that trails its own
    // source's progress is discarded, which leaves the splash up forever —
    // the shipped wedge this pins.
    for (let i = 0; i < 78; i++) reportStartup('owner', `Restoring tab ${i + 1}…`)
    reportStartup('owner', 'Ion is ready', true)

    const ready = sent.at(-1)!
    expect(ready.ready).toBe(true)
    expect(ready.sequence).toBeGreaterThan(sent.at(-2)!.sequence)
  })

  it('is the only renderer module that sends a startup report', () => {
    // Two senders means two counters means a dropped `ready`. The single
    // counter only holds while this module owns every send.
    const rendererRoot = resolve(__dirname)
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.tsx?$/.test(entry.name)) continue
        const rel = relative(rendererRoot, full)
        if (rel === 'startup-report.ts' || rel === 'startup-report.test.ts') continue
        if (readFileSync(full, 'utf8').includes('startupReport(')) offenders.push(rel)
      }
    }
    walk(rendererRoot)
    expect(offenders).toEqual([])
  })
})
