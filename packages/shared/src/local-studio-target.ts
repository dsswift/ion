/**
 * The local Studio wire listener's address: one derivation for every party
 * that has to agree on it. The server binds it, the pairing CLI dials it, and
 * the desktop's main process dials it.
 *
 * - darwin/linux: a Unix domain socket at `<dataDir>/studio.sock`.
 * - win32: a named pipe `\\.\pipe\ion-studio-<sid>`, where `<sid>` is the
 *   current user's Windows SID, the same per-user derivation the engine's
 *   loopback port uses. It is derived, never stored: a dialer needs no file to
 *   find it and a fresh install has it from its first boot. Two users on one
 *   host get two pipes.
 *
 * The server and the desktop once derived the win32 name independently and
 * disagreed, so on Windows the desktop could never reach its own local
 * server. One function is what keeps that from coming back.
 */
import { join } from 'path'

export type LocalStudioTarget = { kind: 'unix'; path: string } | { kind: 'pipe'; path: string }

/** The named pipe a win32 local server listens on for the user with this SID. */
export function localPipeName(sid: string): string {
  return `\\\\.\\pipe\\ion-studio-${sid}`
}

/**
 * Resolves where the local listener for `dir` lives. Throws on win32 when the
 * SID cannot be read: without it there is no per-user name to bind or dial,
 * and guessing a shared one would let two users' servers collide.
 */
export function resolveLocalStudioTarget(
  dir: string,
  platform: NodeJS.Platform,
  sid: () => string | null,
): LocalStudioTarget {
  if (platform === 'win32') {
    const value = sid()
    if (!value) throw new Error('cannot derive the local Studio pipe name: no Windows SID for this user')
    return { kind: 'pipe', path: localPipeName(value) }
  }
  return { kind: 'unix', path: join(dir, 'studio.sock') }
}
