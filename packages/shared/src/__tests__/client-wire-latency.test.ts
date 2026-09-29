/**
 * What a client can measure that the server cannot: how long an action takes
 * from leaving this process to its result arriving back. That span is what a
 * person waits through, and it includes the client's own work.
 */
import { describe, it, expect, vi } from 'vitest'
import { ClientWireLatency, CLIENT_WINDOW_FIELDS } from '../client-wire-latency'

/** A meter writing into an array instead of a log. */
function meter() {
  const lines: Array<{ tag: string; msg: string; fields: Record<string, unknown> }> = []
  return { lines, latency: new ClientWireLatency((tag, msg, fields) => lines.push({ tag, msg, fields })) }
}

describe('ClientWireLatency', () => {
  it('times an action from send to result', () => {
    const { lines, latency } = meter()
    latency.noteActionSent('local', 'a1', 'local', 1_000)
    latency.noteActionResult('local', 'a1', 1_120)
    latency.flush()

    expect(lines).toHaveLength(1)
    expect(lines[0].tag).toBe('wire-latency')
    expect(lines[0].msg).toBe('client window')
    expect(lines[0].fields).toMatchObject({
      environment_id: 'local',
      transport: 'local',
      action_p50_ms: 120,
      action_max_ms: 120,
      actions: 1,
      action_timeouts: 0,
    })
  })

  it('carries every field the dashboard queries', () => {
    const { lines, latency } = meter()
    latency.noteActionSent('local', 'a1', 'relay', 0)
    latency.noteActionResult('local', 'a1', 5)
    latency.flush()

    for (const field of CLIENT_WINDOW_FIELDS) {
      expect(lines[0].fields, `client window is missing ${field}`).toHaveProperty(field)
    }
  })

  it('counts a timeout rather than averaging it in', () => {
    // A 30s timeout folded into the percentiles would make the wire look
    // merely sluggish instead of broken.
    const { lines, latency } = meter()
    latency.noteActionSent('local', 'slow', 'tcp', 0)
    latency.noteActionTimeout('local', 'slow')
    latency.noteActionSent('local', 'fast', 'tcp', 0)
    latency.noteActionResult('local', 'fast', 10)
    latency.flush()

    expect(lines[0].fields).toMatchObject({ actions: 1, action_p95_ms: 10, action_timeouts: 1 })
  })

  it('keeps each environment separate', () => {
    const { lines, latency } = meter()
    latency.noteActionSent('local', 'a', 'local', 0)
    latency.noteActionResult('local', 'a', 10)
    latency.noteActionSent('remote', 'b', 'relay', 0)
    latency.noteActionResult('remote', 'b', 400)
    latency.flush()

    const byEnvironment = Object.fromEntries(lines.map((l) => [l.fields.environment_id, l.fields]))
    expect(byEnvironment.local).toMatchObject({ action_max_ms: 10, transport: 'local' })
    expect(byEnvironment.remote).toMatchObject({ action_max_ms: 400, transport: 'relay' })
  })

  it('ignores a result for an action it has no record of', () => {
    // A result arriving for an action sent on a previous connection.
    const { lines, latency } = meter()
    latency.noteActionResult('local', 'from-a-past-life', 10)
    latency.flush()
    expect(lines).toEqual([])
  })

  it('says nothing about a window in which nothing happened', () => {
    const { lines, latency } = meter()
    latency.flush()
    expect(lines).toEqual([])
  })

  it('starts fresh after each window', () => {
    const { lines, latency } = meter()
    latency.noteActionSent('local', 'a', 'local', 0)
    latency.noteActionResult('local', 'a', 10)
    latency.flush()
    latency.flush()
    expect(lines).toHaveLength(1)
  })

  it('writes a final window when it stops', () => {
    const { lines, latency } = meter()
    vi.useFakeTimers()
    latency.start()
    latency.noteActionSent('local', 'a', 'local', 0)
    latency.noteActionResult('local', 'a', 10)
    latency.stop()
    vi.useRealTimers()

    expect(lines).toHaveLength(1)
  })
})
