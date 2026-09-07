/**
 * telemetry-frame-parity.test.ts — pins this decoder against the Go one.
 *
 * The desktop and the engine each carry a frame decoder, because the desktop is
 * a TypeScript process reading the same file and cannot call into Go. Two
 * implementations of one format drift silently: the version rule diverged once
 * already, and only one side emitted the correlation keys.
 *
 * assets/telemetry-frame-parity.json is generated from the Go decoder
 * (`cd engine && go test ./internal/telemetryformat/ -run TestFrameParityFixture -update`)
 * and asserted by both. A change to either implementation that is not mirrored
 * in the other fails one of these suites.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import type { EgressRecord } from '../log-egress'
import { TELEMETRY_FRAME_VERSION, decodeTelemetryLine } from '../telemetry-frame'

interface ParityCase {
  name: string
  line: string
  expect?: Record<string, unknown>[]
}

interface ParityFixture {
  frame_version: number
  expand: ParityCase[]
  reject: ParityCase[]
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, '../../../../assets/telemetry-frame-parity.json'), 'utf8'),
) as ParityFixture

describe('telemetry frame cross-language parity', () => {
  it('is generated against the same frame version this decoder implements', () => {
    expect(fixture.frame_version).toBe(TELEMETRY_FRAME_VERSION)
  })

  for (const testCase of fixture.expand) {
    it(`expands identically to the Go decoder: ${testCase.name}`, () => {
      const records = decodeTelemetryLine(testCase.line) as unknown as Record<string, unknown>[]
      expect(records).toEqual(testCase.expect)
    })
  }

  for (const testCase of fixture.reject) {
    it(`rejects what the Go decoder rejects: ${testCase.name}`, () => {
      expect(() => decodeTelemetryLine(testCase.line)).toThrow()
    })
  }
})

describe('telemetry frame egress shape', () => {
  it('produces records the OTLP exporter recognizes as telemetry', () => {
    // The exporter branches on name and payload both being set. A frame that
    // expanded into records missing either would be mapped through the
    // operational path and lose every cost and attribution attribute.
    const records = decodeTelemetryLine(fixture.expand[0].line) as EgressRecord[]

    expect(records.length).toBeGreaterThan(0)
    for (const record of records) {
      expect(record.name).toBeTruthy()
      expect(record.payload).toBeDefined()
      expect(record.msg).toBeUndefined()
    }
  })
})
