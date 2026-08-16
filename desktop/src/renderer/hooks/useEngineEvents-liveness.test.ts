import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(__dirname, './useEngineEvents.ts'), 'utf8')

describe('useEngineEvents arrival liveness', () => {
  it('stamps event, status, and error arrivals before queueing each callback', () => {
    const callbacks = [
      ['onEvent', 'received += 1'],
      ['onTabStatusChange', 'enqueueStatus(queueRef.current, tabId, newStatus, oldStatus)'],
      ['onError', 'enqueueError(queueRef.current, tabId, error)'],
    ] as const

    for (const [callback, queueWork] of callbacks) {
      const start = source.indexOf(`window.ion.${callback}((tabId`)
      expect(start).toBeGreaterThanOrEqual(0)
      const body = source.slice(start, source.indexOf('\n    })', start))
      expect(body.indexOf('markEventArrival(tabId)')).toBeGreaterThanOrEqual(0)
      expect(body.indexOf('markEventArrival(tabId)')).toBeLessThan(body.indexOf(queueWork))
    }
  })
})
