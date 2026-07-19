/**
 * Payload compression for the remote transport layer.
 *
 * Outbound payloads are compressed with raw DEFLATE before AES-256-GCM
 * encryption. A 0x01 version prefix distinguishes compressed payloads
 * from legacy uncompressed ones. iOS decompresses with Apple's
 * Compression framework (COMPRESSION_ZLIB = raw DEFLATE).
 */

import { deflateRawSync, inflateRawSync } from 'zlib'

/** Version prefix byte indicating the payload is raw-DEFLATE compressed. */
const COMPRESSED_PREFIX = 0x01

/**
 * Compression floor: payloads below this size ship uncompressed. DEFLATE on a
 * 40-byte text delta produces output LARGER than the input (dictionary + block
 * overhead) while burning CPU at the delta flush rate — the exact hot path.
 * The 0x01-prefix protocol already supports the passthrough: receivers treat a
 * non-0x01 first byte as raw UTF-8 (see decompressPayload here and the iOS
 * branch in TransportManager+Receive.swift), and a JSON payload's first byte
 * is always printable ASCII, never 0x01. Zero wire change.
 */
export const COMPRESSION_FLOOR_BYTES = 512

/**
 * Compress a plaintext JSON string for encrypted transport.
 *
 * Returns a Buffer with a 0x01 version byte followed by raw DEFLATE data —
 * or, below COMPRESSION_FLOOR_BYTES, the raw UTF-8 bytes unprefixed (the
 * legacy-compatible uncompressed form). The receiver checks the first byte
 * after decryption: if 0x01, inflate the remaining bytes; otherwise treat as
 * raw UTF-8.
 */
export function compressPayload(plaintext: string): Buffer {
  const raw = Buffer.from(plaintext, 'utf-8')
  if (raw.length < COMPRESSION_FLOOR_BYTES) return raw
  const compressed = deflateRawSync(raw)
  return Buffer.concat([Buffer.from([COMPRESSED_PREFIX]), compressed])
}

/**
 * Decompress a decrypted payload buffer to a UTF-8 JSON string.
 *
 * Handles both compressed (0x01 prefix) and uncompressed (legacy) payloads.
 * Returns the UTF-8 plaintext string ready for JSON.parse().
 */
export function decompressPayload(raw: Buffer): string {
  if (raw.length > 0 && raw[0] === COMPRESSED_PREFIX) {
    return inflateRawSync(raw.subarray(1)).toString('utf-8')
  }
  return raw.toString('utf-8')
}
