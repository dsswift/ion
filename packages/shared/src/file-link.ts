/**
 * The answer to `fs.resolveLink`: a path the operator clicked, resolved on the
 * Environment that owns the conversation it was clicked in.
 */
export interface FileLinkTarget {
  /** The absolute, normalized path on that Environment. Empty when the input could not be resolved. */
  path: string
  exists: boolean
  isDirectory: boolean
  /** Bytes; 0 for a directory or a missing path. */
  size: number
}

/**
 * Upper bound on one file carried over the wire as bytes: an attachment a
 * client stores on the server, or a copy of a server file a client opens or
 * saves. A wire frame this large is already unusual.
 */
export const MAX_FILE_DATA_BYTES = 25 * 1024 * 1024
