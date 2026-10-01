/**
 * How a project row splits its two machine questions: the second line's
 * colour says where it opens, the control on the right offers where else it
 * could.
 */
import { describe, expect, it } from 'vitest'
import type { MergedProjectRow, ProjectHolder } from '../../studio/connection/environment-projects'
import { actingHolder, isLocalEnvironment, machineControlFor } from '../new-conversation-machine-control'

function holder(environmentId: string, label: string): ProjectHolder {
  return {
    environmentId,
    label,
    entry: { dir: `/src/${environmentId}`, displayName: 'proj', entry: { addedManually: true, lastUsedAt: 0 }, managed: false, profileAction: 'ask' },
    usageCount: 0,
  }
}
const local = holder('local', 'This Mac')
const devbox = holder('devbox', 'devbox')
const work = holder('work', 'macbook')

function row(holders: ProjectHolder[]): MergedProjectRow {
  return { key: 'remote:proj', displayName: 'proj', dir: holders[0]?.entry.dir ?? '/src', repoRemote: 'github.com/o/proj', holders }
}

describe('machineControlFor — the offer on the right', () => {
  // Most projects live on one machine, so most rows carry nothing.
  it('says nothing when no other machine has it', () => {
    expect(machineControlFor(row([local]), 'local')).toEqual({ kind: 'none' })
    expect(machineControlFor(row([devbox]), 'devbox')).toEqual({ kind: 'none' })
  })

  it('offers the one other machine as a single chip', () => {
    expect(machineControlFor(row([local, devbox]), 'local')).toEqual({ kind: 'alternative', holder: devbox })
  })

  it('offers several other machines as one counted control', () => {
    expect(machineControlFor(row([local, devbox, work]), 'local')).toEqual({ kind: 'alternatives', alternatives: [devbox, work] })
  })

  // Where the row opens is the second line's job, so the offer never repeats it.
  it('never offers the machine the row already opens on', () => {
    const control = machineControlFor(row([local, devbox, work]), 'work')
    expect(control).toEqual({ kind: 'alternatives', alternatives: [local, devbox] })
  })

  it('offers the other remote machine when none of them are local', () => {
    expect(machineControlFor(row([devbox, work]), 'devbox')).toEqual({ kind: 'alternative', holder: work })
  })

  // The sections there ARE the machine picker.
  it('says nothing inside a per-machine section', () => {
    expect(machineControlFor(row([local, devbox, work]), 'devbox', { inMachineSection: true })).toEqual({ kind: 'none' })
  })

  it('says nothing for a row with no checkouts left after a policy filter', () => {
    expect(machineControlFor(row([]), 'local')).toEqual({ kind: 'none' })
  })
})

describe('actingHolder — the machine the row names and opens on', () => {
  it('is the requested machine when the row has it', () => {
    expect(actingHolder(row([local, devbox]), 'devbox')).toBe(devbox)
  })

  // A row must always name something real, even if a filter removed the
  // machine the caller asked for.
  it('falls back to the first holder otherwise', () => {
    expect(actingHolder(row([devbox, work]), 'local')).toBe(devbox)
    expect(actingHolder(row([]), 'local')).toBeUndefined()
  })
})

describe('isLocalEnvironment — which colour the second line uses', () => {
  it('separates this machine from every other', () => {
    expect(isLocalEnvironment('local')).toBe(true)
    expect(isLocalEnvironment('devbox')).toBe(false)
    expect(isLocalEnvironment('work')).toBe(false)
  })
})
