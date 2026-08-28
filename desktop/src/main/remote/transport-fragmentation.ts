import { createHash, randomUUID } from 'crypto'
import type { PayloadChunkEnvelope } from './protocol'

/** Raw bytes per chunk. Base64 + JSON stays below the 6 MiB plaintext gate. */
export const PAYLOAD_CHUNK_BYTES = 3 * 1024 * 1024

const FRAGMENTED_TYPES = new Set(['desktop_questions_state', 'desktop_snapshot', 'desktop_transcript'])

export interface FragmentedPayload {
  chunks: PayloadChunkEnvelope[]
  originalBytes: number
}

export function shouldFragmentPayload(type: string, plaintextBytes: number, thresholdBytes: number): boolean {
  return FRAGMENTED_TYPES.has(type) && plaintextBytes > thresholdBytes
}

/** Split one serialized application event without changing any source byte. */
export function fragmentPayload(type: string, plaintext: string): FragmentedPayload {
  const raw = Buffer.from(plaintext, 'utf8')
  const count = Math.ceil(raw.length / PAYLOAD_CHUNK_BYTES)
  const transferId = randomUUID()
  const sha256 = createHash('sha256').update(raw).digest('hex')
  const chunks: PayloadChunkEnvelope[] = []
  for (let index = 0; index < count; index++) {
    const start = index * PAYLOAD_CHUNK_BYTES
    chunks.push({
      type: 'desktop_payload_chunk',
      transferId,
      index,
      count,
      originalType: type,
      totalBytes: raw.length,
      sha256,
      data: raw.subarray(start, start + PAYLOAD_CHUNK_BYTES).toString('base64'),
    })
  }
  return { chunks, originalBytes: raw.length }
}

/** Test helper and defensive verifier for a complete chunk set. */
export function reassemblePayload(chunks: readonly PayloadChunkEnvelope[]): Buffer {
  if (chunks.length === 0) throw new Error('payload chunk set is empty')
  const first = chunks[0]
  if (chunks.length !== first.count) throw new Error('payload chunk set is incomplete')
  const ordered = [...chunks].sort((a, b) => a.index - b.index)
  for (let index = 0; index < ordered.length; index++) {
    const chunk = ordered[index]
    if (
      chunk.index !== index || chunk.transferId !== first.transferId || chunk.count !== first.count ||
      chunk.originalType !== first.originalType || chunk.totalBytes !== first.totalBytes || chunk.sha256 !== first.sha256
    ) throw new Error('payload chunk metadata mismatch')
  }
  const raw = Buffer.concat(ordered.map((chunk) => Buffer.from(chunk.data, 'base64')))
  if (raw.length !== first.totalBytes) throw new Error('payload chunk byte count mismatch')
  const digest = createHash('sha256').update(raw).digest('hex')
  if (digest !== first.sha256) throw new Error('payload chunk digest mismatch')
  return raw
}
