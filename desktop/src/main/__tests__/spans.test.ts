/**
 * Main-process spans: `app.launch` is a root that begins at the process
 * start and ends when Electron is ready; `window.ready` joins it as a child;
 * the launch traceparent reaches the renderer through a window argument.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const logged = vi.hoisted(() => ({ log: vi.fn(), warn: vi.fn() }))
vi.mock('../logger', () => ({ log: logged.log, warn: logged.warn }))

import { createLaunchTrace, startMainSpan, startMainSpanAt, _resetLaunchTraceForTest } from '../spans'
import { LAUNCH_TRACEPARENT_ARG, launchTraceparentFromArgv } from '../../shared/desktop-ipc'
import { parseTraceparent } from '@ion/shared/trace-context'

type Fields = Record<string, unknown>
const spans = (name: string): Fields[] => logged.log.mock.calls.filter((c) => c[0] === 'span' && c[1] === name).map((c) => c[2] as Fields)

beforeEach(() => { vi.clearAllMocks(); _resetLaunchTraceForTest() })

describe('app.launch', () => {
  it('starts at the process start, is a root, and ends once', () => {
    let t = 10_000
    const launch = createLaunchTrace(9_000, { now: () => t })
    t = 10_400
    expect(launch.endAppLaunch({ app_version: '1.0' })).toMatchObject({ durationMs: 1_400 })
    expect(launch.endAppLaunch()).toBeUndefined()
    const [fields] = spans('app.launch')
    expect(fields).toMatchObject({ duration_ms: 1_400, process: 'main', app_version: '1.0' })
    expect(fields).not.toHaveProperty('parent_span_id')
    expect(parseTraceparent(launch.traceparent)).toEqual({ traceId: fields.trace_id, spanId: fields.span_id })
  })

  it('window.ready joins the launch trace as a child', () => {
    const launch = createLaunchTrace(1_000, { now: () => 2_000 })
    startMainSpan('window.ready', { parent: launch.traceparent, attributes: { window: 'studio' }, now: () => 2_500 }).end({ revealed: true })
    const parent = parseTraceparent(launch.traceparent)!
    expect(spans('window.ready')[0]).toMatchObject({ trace_id: parent.traceId, parent_span_id: parent.spanId, window: 'studio', revealed: true, duration_ms: 0 })
  })

  it('writes a failed span at WARN', () => {
    startMainSpan('connection.connect', { now: () => 1 }).end(undefined, 'refused')
    expect(logged.warn).toHaveBeenCalledWith('span', 'connection.connect', expect.objectContaining({ error: 'refused' }))
  })
})

describe('startMainSpanAt', () => {
  it('begins at the given time and ends at the clock', () => {
    startMainSpanAt('late', 100, { now: () => 160 }).end()
    expect(spans('late')[0]).toMatchObject({ duration_ms: 60 })
  })
})

describe('launchTraceparentFromArgv', () => {
  it('reads the argument main hands the window, and is null without it', () => {
    const tp = '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01'
    expect(launchTraceparentFromArgv(['electron', `${LAUNCH_TRACEPARENT_ARG}${tp}`])).toBe(tp)
    expect(launchTraceparentFromArgv(['electron'])).toBeNull()
    expect(launchTraceparentFromArgv([LAUNCH_TRACEPARENT_ARG])).toBeNull()
  })
})
