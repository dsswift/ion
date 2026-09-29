/**
 * jobs — every transition publishes the job snapshot on `ion:project-job`,
 * cancel only reaches a running cancellable job, and settled jobs stay
 * listable.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const { broadcast } = vi.hoisted(() => ({ broadcast: vi.fn() }))
vi.mock('../../broadcast', () => ({ broadcast }))

import { startJob, progressJob, finishJob, failJob, cancelJob, markJobCancelled, listJobs, getJob, runningJobFor, _resetJobsForTest } from '../jobs'

afterEach(() => { _resetJobsForTest(); broadcast.mockClear() })

describe('jobs', () => {
  it('publishes start, progress, and finish snapshots and lists newest first', () => {
    const a = startJob({ kind: 'clone', dir: '/x/a', stage: 'starting', url: 'git@h:o/a.git' }, null)
    progressJob(a.id, { stage: 'receiving objects', percent: 40, detail: 'Receiving objects: 40%' })
    finishJob(a.id)
    const channels = broadcast.mock.calls.map((c) => c[0])
    expect(channels).toEqual(['ion:project-job', 'ion:project-job', 'ion:project-job'])
    const snapshots = broadcast.mock.calls.map((c) => c[1] as { phase: string; stage: string; percent?: number })
    expect(snapshots.map((s) => s.phase)).toEqual(['running', 'running', 'done'])
    expect(snapshots[1]).toMatchObject({ stage: 'receiving objects', percent: 40 })
    expect(getJob(a.id)?.endedAt).toBeTypeOf('number')
    const b = startJob({ kind: 'setup', dir: '/x/b', stage: 'running setup' }, null)
    expect(listJobs().map((j) => j.id)).toEqual([b.id, a.id])
    expect(runningJobFor('setup', '/x/b')?.id).toBe(b.id)
    expect(runningJobFor('clone', '/x/a')).toBeUndefined()
  })

  it('cancel reaches only a running job with a cancel hook, and progress after settle is ignored', () => {
    const cancel = vi.fn()
    const a = startJob({ kind: 'clone', dir: '/x/a', stage: 's' }, cancel)
    expect(cancelJob(a.id)).toBe(true)
    expect(cancel).toHaveBeenCalledTimes(1)
    markJobCancelled(a.id)
    expect(cancelJob(a.id)).toBe(false)
    progressJob(a.id, { percent: 99 })
    expect(getJob(a.id)).toMatchObject({ phase: 'cancelled' })
    expect(getJob(a.id)?.percent).toBeUndefined()
    const b = startJob({ kind: 'setup', dir: '/x/b', stage: 's' }, null)
    expect(cancelJob(b.id)).toBe(false)
    failJob(b.id, 'boom')
    expect(getJob(b.id)).toMatchObject({ phase: 'failed', error: 'boom' })
    expect(cancelJob('nope')).toBe(false)
  })
})
