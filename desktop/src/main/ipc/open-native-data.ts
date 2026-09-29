/**
 * Open a copy of a file this machine does not hold.
 *
 * An attachment on a remote Environment has a path only on that machine. To
 * hand it to a native application here (Word, PowerPoint, Preview), the
 * renderer fetches its bytes over the wire and this writes them to a local
 * copy. The copy lives under the OS temp directory, keyed by content, so
 * opening the same file twice reuses one copy and a different file with the
 * same name never overwrites it.
 */
import { createHash } from 'crypto'
import { mkdirSync, writeFileSync } from 'fs'
import { join, posix } from 'path'

/**
 * The part of a client-supplied name that is safe as one path segment. The
 * POSIX basename is used on every OS so a Windows drive prefix ("a:") is just
 * more unsafe characters, not a root that swallows the start of the name.
 */
export function safeCopyName(name: string): string {
  const base = posix.basename(name.replace(/\\/g, '/')).replace(/[\0-\x1f<>:"|?*]/g, '_').trim()
  return base && base !== '.' && base !== '..' ? base.slice(0, 200) : 'attachment'
}

/** Writes `bytes` as `name` under `root` and returns the copy's path. */
export function writeOpenCopy(root: string, name: string, bytes: Buffer): string {
  const dir = join(root, createHash('sha256').update(bytes).digest('hex').slice(0, 16))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, safeCopyName(name))
  writeFileSync(filePath, bytes)
  return filePath
}
