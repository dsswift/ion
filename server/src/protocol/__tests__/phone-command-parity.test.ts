/**
 * The drift guard between the two client wires.
 *
 * `phone-command-map.json` says, for every `desktop_*` RemoteCommand, which
 * `studio_action` (or Studio frame) a client on the Studio wire uses instead.
 * A client's mapper is written from it, so it has to stay true in three ways:
 *
 *   (a) every command the old wire defines has an entry, so a command added
 *       there cannot be forgotten here;
 *   (b) every action an entry names is one this server really answers;
 *   (c) no entry outlives the command it describes.
 *
 * The command list is parsed out of the protocol source at test time. A
 * hand-copied list would drift in exactly the way this test exists to catch.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn() }))

import { registeredActionNames } from '../actions'

interface MapEntry { action: string | null; alsoActions?: string[]; transport?: string; args: string; result: string }

/** Read as a file, not imported: it is plain data that a Swift test reads the same way. */
const MAP_PATH = join(__dirname, '..', '..', '..', '..', 'packages', 'shared', 'src', 'studio-wire', 'phone-command-map.json')
const entries = (JSON.parse(readFileSync(MAP_PATH, 'utf-8')) as { commands: Record<string, MapEntry> }).commands

const REMOTE_DIR = join(__dirname, '..', '..', 'remote')

/** The files that declare the command unions. `protocol-commands.ts` composes the other two into `RemoteCommand`. */
const COMMAND_SOURCES = ['protocol-commands.ts', 'protocol-worktree.ts', 'protocol-questions.ts']

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** Every `type: "desktop_..."` literal inside an `export type ...Command =` union, which is where a command is declared and an event is not. */
function declaredCommandTypes(): string[] {
  const found: string[] = []
  for (const file of COMMAND_SOURCES) {
    const source = stripComments(readFileSync(join(REMOTE_DIR, file), 'utf-8'))
    for (const match of source.matchAll(/export type \w*Command\s*=/g)) {
      const start = (match.index ?? 0) + match[0].length
      const end = source.indexOf('\nexport ', start)
      const union = source.slice(start, end === -1 ? source.length : end)
      for (const literal of union.matchAll(/type:\s*["'](desktop_[a-z_]+)["']/g)) found.push(literal[1])
    }
  }
  return found
}

/** Shared-package files that declare a RemoteEvent member protocol.ts includes by type. */
const SHARED_EVENT_SOURCES = [join(REMOTE_DIR, '../../../packages/shared/src/transcript/transcript-patch.ts')]

/** Every RemoteEvent type, so a `result` that names an event names a real one. */
function declaredEventTypes(): Set<string> {
  const found = new Set<string>()
  for (const file of ['protocol.ts', 'protocol-worktree.ts', 'protocol-questions.ts', 'protocol-settings.ts', 'protocol-remote-tab.ts']) {
    const source = stripComments(readFileSync(join(REMOTE_DIR, file), 'utf-8'))
    for (const literal of source.matchAll(/type:\s*["'](desktop_[a-z_]+)["']/g)) found.add(literal[1])
  }
  // Events whose shape the shared package owns, and protocol.ts names by type.
  for (const file of SHARED_EVENT_SOURCES) {
    const source = stripComments(readFileSync(file, 'utf-8'))
    for (const literal of source.matchAll(/type:\s*["'](desktop_[a-z_]+)["']/g)) found.add(literal[1])
  }
  return found
}

describe('phone command map', () => {
  const commands = declaredCommandTypes()

  it('finds the command unions it parses', () => {
    // A rename of the unions would make every check below pass on an empty list.
    expect(commands).toContain('desktop_prompt')
    expect(commands).toContain('desktop_worktree_sync')
    expect(commands).toContain('desktop_questions_patch')
    expect(new Set(commands).size).toBe(commands.length)
  })

  it('(a) has an entry for every RemoteCommand', () => {
    expect(commands.filter((type) => !(type in entries))).toEqual([])
  })

  it('(b) names only actions this server answers', () => {
    const registered = registeredActionNames()
    const unknown: string[] = []
    for (const [command, entry] of Object.entries(entries)) {
      for (const action of [entry.action, ...(entry.alsoActions ?? [])]) {
        if (action !== null && !registered.has(action)) unknown.push(`${command} -> ${action}`)
      }
    }
    expect(unknown).toEqual([])
  })

  it('(c) has no entry for a command that no longer exists', () => {
    expect(Object.keys(entries).filter((type) => !commands.includes(type))).toEqual([])
  })

  it('says what replaces a command that has no action, and how every command maps', () => {
    for (const [command, entry] of Object.entries(entries)) {
      if (entry.action === null) expect(entry.transport, `${command} has no action and names no replacement`).toBeTruthy()
      else expect(entry.transport, `${command} has an action, so it is not a transport command`).toBeUndefined()
      expect(entry.args, `${command} args`).toBeTruthy()
      expect(entry.result, `${command} result`).toBeTruthy()
    }
  })

  it('names only RemoteEvents that exist when it says what a client synthesizes', () => {
    const events = declaredEventTypes()
    const commandTypes = new Set(commands)
    const unknown: string[] = []
    for (const [command, entry] of Object.entries(entries)) {
      for (const literal of entry.result.matchAll(/desktop_[a-z_]+/g)) {
        if (!events.has(literal[0]) && !commandTypes.has(literal[0])) unknown.push(`${command} -> ${literal[0]}`)
      }
    }
    expect(unknown).toEqual([])
  })
})
