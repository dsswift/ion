import { describe, expect, it } from 'vitest'
import { parseReconcileRequest } from './chart-reconcile-ipc'

/**
 * Payload validation for the chart-reconcile channel.
 *
 * `ipcMain.on` is an untrusted-input boundary. A malformed row reaching
 * `rebuildFromHistory` is not merely a bad render: the rebuild DELETES records
 * the supplied rows cannot account for, so a partially-parsed list would erase
 * real charts. Every case below therefore refuses the whole request rather
 * than reconciling from a subset.
 */

const ROW = {
  toolMessageId: 'toolu_01AbCdEfGhIjKlMnOpQr01',
  toolInput: '{"schemaVersion":1}',
  resultText: 'Chart rendered. id: tool-gate-1-1 · title: "x" · line · 1 series · 2 points.',
  index: 0,
}

function request(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { tabId: 'tab-7', conversationId: 'conv-abc', rows: [ROW], ...over }
}

describe('parseReconcileRequest', () => {
  it('accepts a well-formed request', () => {
    const parsed = parseReconcileRequest(request())
    expect(parsed).not.toBeNull()
    expect(parsed?.tabId).toBe('tab-7')
    expect(parsed?.conversationId).toBe('conv-abc')
    expect(parsed?.rows).toEqual([ROW])
  })

  it('accepts an empty row list', () => {
    // A branch that rewound past every chart legitimately sends none, and that
    // is exactly the request that removes the stale records.
    expect(parseReconcileRequest(request({ rows: [] }))?.rows).toEqual([])
  })

  it('refuses a request with no conversation id', () => {
    expect(parseReconcileRequest(request({ conversationId: '' }))).toBeNull()
  })

  it('refuses a request with no tab id', () => {
    expect(parseReconcileRequest(request({ tabId: '' }))).toBeNull()
  })

  it('refuses a non-object payload', () => {
    expect(parseReconcileRequest(null)).toBeNull()
    expect(parseReconcileRequest('rows')).toBeNull()
  })

  it('refuses rows that are not an array', () => {
    expect(parseReconcileRequest(request({ rows: { toolMessageId: 'x' } }))).toBeNull()
  })

  it('refuses the WHOLE request when one row is malformed', () => {
    // Dropping the bad row instead would hand the rebuild a short list, which
    // is indistinguishable from "the branch lost these charts".
    expect(parseReconcileRequest(request({ rows: [ROW, { toolMessageId: 'x' }] }))).toBeNull()
  })

  it('refuses a row with a missing result text', () => {
    // Identity lives in the result; a row without it cannot be reconciled.
    const { resultText: _dropped, ...withoutResult } = ROW
    expect(parseReconcileRequest(request({ rows: [withoutResult] }))).toBeNull()
  })

  it('refuses a row with a non-numeric index', () => {
    expect(parseReconcileRequest(request({ rows: [{ ...ROW, index: 'first' }] }))).toBeNull()
  })

  it('refuses an oversized row list', () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({ ...ROW, index }))
    expect(parseReconcileRequest(request({ rows }))).toBeNull()
  })

  it('refuses an oversized row field', () => {
    expect(parseReconcileRequest(request({
      rows: [{ ...ROW, toolInput: 'x'.repeat(200_001) }],
    }))).toBeNull()
  })
})
