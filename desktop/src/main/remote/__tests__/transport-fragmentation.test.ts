import { describe, expect, it } from 'vitest'
import {
  fragmentPayload,
  PAYLOAD_CHUNK_BYTES,
  reassemblePayload,
  shouldFragmentPayload,
} from '../transport-fragmentation'
import { MAX_PLAINTEXT_BYTES } from '../transport-send'

describe('lossless remote payload fragmentation', () => {
  it('fragments only authoritative Questions-bearing event types', () => {
    expect(shouldFragmentPayload('desktop_questions_state', MAX_PLAINTEXT_BYTES + 1, MAX_PLAINTEXT_BYTES)).toBe(true)
    expect(shouldFragmentPayload('desktop_snapshot', MAX_PLAINTEXT_BYTES + 1, MAX_PLAINTEXT_BYTES)).toBe(true)
    expect(shouldFragmentPayload('desktop_status', MAX_PLAINTEXT_BYTES + 1, MAX_PLAINTEXT_BYTES)).toBe(false)
  })

  it('reconstructs the original UTF-8 JSON bytes and order exactly', () => {
    const questions = Array.from({ length: 50 }, (_, index) => ({
      id: `q-${index}`,
      prompt: `Question ${index} — 漢字 — ${'p'.repeat(140_000)}`,
      mode: 'text',
    }))
    const event = {
      type: 'desktop_questions_state',
      tabId: 'tab-1',
      state: { workflows: [{ workflowId: 'wf', request: { title: 'Large 🚀', questions } }] },
    }
    const plaintext = JSON.stringify(event)
    const fragmented = fragmentPayload(event.type, plaintext)
    expect(fragmented.chunks.length).toBeGreaterThan(1)
    expect(fragmented.chunks.every((chunk) => Buffer.byteLength(JSON.stringify(chunk), 'utf8') < MAX_PLAINTEXT_BYTES)).toBe(true)
    expect(fragmented.chunks.every((chunk) => Buffer.from(chunk.data, 'base64').length <= PAYLOAD_CHUNK_BYTES)).toBe(true)
    expect(reassemblePayload(fragmented.chunks).toString('utf8')).toBe(plaintext)
    expect(JSON.parse(reassemblePayload(fragmented.chunks).toString('utf8')).state.workflows[0].request.questions).toEqual(questions)
  })

  it('rejects incomplete or changed chunks', () => {
    const fragmented = fragmentPayload('desktop_snapshot', JSON.stringify({ type: 'desktop_snapshot', pad: 'x'.repeat(7_000_000) }))
    expect(() => reassemblePayload(fragmented.chunks.slice(1))).toThrow(/incomplete|metadata/)
    const changed = fragmented.chunks.map((chunk) => ({ ...chunk }))
    changed[0].data = Buffer.from('changed').toString('base64')
    expect(() => reassemblePayload(changed)).toThrow(/byte count|digest/)
  })
})
