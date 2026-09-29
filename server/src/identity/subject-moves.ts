/**
 * subject-moves — carries a person from an old subject to a new one, as
 * `server.json.tenancy.subjectMoves` declares.
 *
 * A sign-in subject can change without the person doing anything. Entra's
 * `sub` is pairwise per application, so moving a server onto another app
 * registration gives every person on it a new subject, and everything keyed
 * by the old one (their conversations under `principals/<dir>/`, git keys,
 * settings, tab stamps, pairings) would otherwise be invisible to them.
 *
 * Runs on every boot. A pass that finds nothing under `from` changes
 * nothing, so a move can stay in `server.json` after it has run.
 */
import { existsSync, rmSync } from 'fs'
import type { SubjectMove } from '../config/tenancy-config'
import { foldSubjects, type HostIdentityMigrationResult } from './host-identity-migration'
import { lookupPrincipal } from './principal-registry'
import { principalDir } from '../conversation/principal-dir'
import { listOverlays, overlayFilePath, replaceOverlay } from '../persistence/user-settings-store'
import { log as _log, error as _error } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('subject-moves', msg, fields)
}
function error(msg: string, fields?: Record<string, unknown>): void {
  _error('subject-moves', msg, fields)
}

export interface SubjectMoveResult extends HostIdentityMigrationResult {
  from: string
  to: string
  /** Whether the old subject's settings overlay was merged into the new one. */
  settings: boolean
}

/** Merges `from`'s settings overlay under `to`'s (a key `to` already has stays `to`'s), then removes `from`'s. */
function moveSettingsOverlay(from: string, to: string): boolean {
  const overlays = listOverlays()
  const old = overlays.find((o) => o.subject === from)
  if (!old) return false
  const current = overlays.find((o) => o.subject === to)
  replaceOverlay(to, { ...old.settings, ...(current?.settings ?? {}) })
  const oldPath = overlayFilePath(from)
  if (existsSync(oldPath)) rmSync(oldPath)
  return true
}

/** Applies each move against `dir`. Every step logs; a failed move is logged and the rest still run. */
export function applySubjectMoves(dir: string, moves: SubjectMove[]): SubjectMoveResult[] {
  const results: SubjectMoveResult[] = []
  for (const { from, to } of moves) {
    try {
      const known = lookupPrincipal(to) ?? lookupPrincipal(from)
      const moved = foldSubjects(dir, {
        matches: (subject) => subject === from,
        movesDir: (name) => name === principalDir(from),
        principal: { ...(known ?? { displayName: to }), subject: to },
        backupSuffix: '.pre-subject-move.bak',
      })
      const settings = moveSettingsOverlay(from, to)
      const result = { from, to, settings, ...moved }
      log('subject move applied', {
        from, to, pairings: moved.pairings.length, git_hosts: moved.gitHosts, principals: moved.principals,
        principal_dirs: moved.principalDirs, tabs: moved.tabs, terminals: moved.terminals, settings,
      })
      results.push(result)
    } catch (err) {
      error('subject move failed; left in place', { from, to, error: String(err) })
    }
  }
  return results
}
