import { describe, expect, it } from 'vitest'
import { buildNoticeFor, parseDesktopBuild, whatsNewFor, type DesktopBuild } from './build-notice'

const build = (over: Partial<DesktopBuild> = {}): DesktopBuild => ({
  version: '2.10.0-dev.abc',
  builtAt: '2026-10-05T15:00:00.000Z',
  ...over,
})

describe('buildNoticeFor', () => {
  it('shows nothing once this exact build is acknowledged', () => {
    expect(buildNoticeFor(build(), build(), ['note'])).toBeNull()
  })

  it('shows a rebuild with the same version as a new build', () => {
    const previous = build({ builtAt: '2026-10-05T14:00:00.000Z' })
    expect(buildNoticeFor(build(), previous, [])).toEqual({ current: build(), previous, highlights: [] })
  })

  it('shows a new version', () => {
    const previous = build({ version: '2.9.1' })
    expect(buildNoticeFor(build(), previous, [])).toEqual({ current: build(), previous, highlights: [] })
  })

  it('shows a first launch with no previous build', () => {
    expect(buildNoticeFor(build(), null, ['note'])).toEqual({ current: build(), previous: null, highlights: ['note'] })
  })
})

describe('parseDesktopBuild', () => {
  it('reads a stored acknowledgement and rejects other shapes', () => {
    expect(parseDesktopBuild({ version: '1', builtAt: 't' })).toEqual({ version: '1', builtAt: 't' })
    expect(parseDesktopBuild(undefined)).toBeNull()
    expect(parseDesktopBuild({ version: 1, builtAt: 't' })).toBeNull()
  })
})

describe('whatsNewFor', () => {
  const notes = { '2.10.0': ['Studio says when it was updated.'], '2.9.1': ['Lists show their markers again.'] }

  it('reads the entry for the version, and none for a version with no entry', () => {
    expect(whatsNewFor(notes, '2.10.0')).toEqual(['Studio says when it was updated.'])
    expect(whatsNewFor(notes, '2.11.0-dev.abc')).toEqual([])
    expect(whatsNewFor({}, '2.10.0')).toEqual([])
  })

  it('rejects a document that is not an object of string arrays', () => {
    expect(whatsNewFor([], '2.10.0')).toBeNull()
    expect(whatsNewFor({ '2.10.0': 'one note' }, '2.10.0')).toBeNull()
    expect(whatsNewFor({ '2.9.0': [1] }, '2.10.0')).toBeNull()
  })
})
