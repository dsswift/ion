/**
 * Cross-client tab-status cascade parity, desktop side.
 *
 * The shared fixture pins precedence names and iOS reachability, never rank
 * integers. This test rejects both fixture entries the desktop forgot to
 * declare and desktop entries absent from the fixture.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { STATUS_CASCADE } from '../TabStripStatusPriority'

interface CascadeStatus {
  name: string
  semantics: string
  iosReachable: boolean
}

interface CascadeFixture {
  statuses: CascadeStatus[]
}

const fixturePath = join(__dirname, '../../../../../assets/design-system/status-cascade.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as CascadeFixture

const fixtureEntries = fixture.statuses.map(({ name, iosReachable }) => ({ name, iosReachable }))

describe('status cascade parity fixture (desktop side)', () => {
  it('contains a semantic definition for every status', () => {
    for (const status of fixture.statuses) {
      expect(status.semantics, status.name).not.toBe('')
    }
  })

  it('matches the desktop declaration exactly in fixture order', () => {
    expect(STATUS_CASCADE).toEqual(fixtureEntries)
  })
})
