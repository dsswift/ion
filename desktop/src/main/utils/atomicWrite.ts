import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'fs'
import { dirname } from 'path'

// atomicWriteFileSync writes data to path atomically: write to a sibling
// temp file, fsync the temp fd, rename over the destination, then fsync the
// parent directory so the rename is durable across crashes. Mirrors the
// engine's writeFileSynced helper at engine/internal/conversation/conversation.go.
//
// Mode defaults to 0o600 because most callers persist secrets (settings.json
// includes relayApiKey and pairedDevices[].sharedSecret). Callers writing
// non-sensitive data may pass 0o644.
export function atomicWriteFileSync(
  path: string,
  data: string | Uint8Array,
  mode: number = 0o600,
): void {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
  const fd = openSync(tmp, 'w', mode)
  try {
    const buf =
      typeof data === 'string'
        ? Buffer.from(data, 'utf-8')
        : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    writeSync(fd, buf, 0, buf.length, 0)
    fsyncSync(fd)
  } catch (err) {
    try { closeSync(fd) } catch {}
    try { unlinkSync(tmp) } catch {}
    throw err
  }
  closeSync(fd)
  try {
    renameSync(tmp, path)
  } catch (err) {
    try { unlinkSync(tmp) } catch {}
    throw err
  }
  // Best-effort fsync the directory so the rename survives a crash. Some
  // filesystems (notably on macOS) reject directory fsync; treat that as
  // non-fatal since the rename itself is already on disk.
  try {
    const dirFd = openSync(dirname(path), 'r')
    try { fsyncSync(dirFd) } catch {}
    closeSync(dirFd)
  } catch {}
}
