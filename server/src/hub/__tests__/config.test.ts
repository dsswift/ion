/**
 * `hub.json`: the views the hub's page shows are each on unless the file
 * turns one off, and a value that is not true or false leaves it on. A token
 * made on the page lasts as long as the file says, or the default.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { DEFAULT_ENROLLMENT_TOKEN_MINUTES, loadHubConfig } from '../config'

let dir: string
const load = (json: unknown): ReturnType<typeof loadHubConfig> => {
  writeFileSync(join(dir, 'hub.json'), JSON.stringify(json))
  return loadHubConfig(dir)
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ion-hub-config-test-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('loadHubConfig views', () => {
  it('shows Quota when hub.json is missing or says nothing of it', () => {
    expect(loadHubConfig(dir).views).toEqual({ quota: true })
    expect(load({ label: 'Work fleet' }).views).toEqual({ quota: true })
  })

  it('leaves Quota off when hub.json turns it off', () => {
    expect(load({ views: { quota: false } }).views).toEqual({ quota: false })
  })

  it('keeps Quota on when the value is not true or false', () => {
    expect(load({ views: { quota: 'no' } }).views).toEqual({ quota: true })
  })
})

describe('loadHubConfig enrollment', () => {
  it('gives a token made on the page the default life unless hub.json sets one', () => {
    expect(loadHubConfig(dir).enrollmentTokenMinutes).toBe(DEFAULT_ENROLLMENT_TOKEN_MINUTES)
    expect(load({ enrollment: { tokenMinutes: 5 } }).enrollmentTokenMinutes).toBe(5)
  })

  it('keeps the default when the value is not a number above zero', () => {
    expect(load({ enrollment: { tokenMinutes: 0 } }).enrollmentTokenMinutes).toBe(DEFAULT_ENROLLMENT_TOKEN_MINUTES)
    expect(load({ enrollment: { tokenMinutes: 'soon' } }).enrollmentTokenMinutes).toBe(DEFAULT_ENROLLMENT_TOKEN_MINUTES)
  })
})
