import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The template that ships in resources/engine and is rendered into what
// `schtasks /Create /XML` is handed. It is data, not code, so nothing else
// type-checks or parses it -- a mistake in here surfaces only as a failed
// engine registration on a user's machine.
//
// What the comment block may contain is not asserted here: the supervisor
// strips every comment before substituting, so a "--" in the documentation
// cannot reach schtasks. That the rendered definition is comment-free is
// pinned in engine-supervisor-schtasks.test.ts, where the rendering happens.
const TEMPLATE = join(__dirname, '..', '..', '..', '..', 'packaging', 'windows', 'ion-engine-task.xml')

describe('ion-engine-task.xml', () => {
  const xml = readFileSync(TEMPLATE, 'utf-8')

  // The declaration is what tells schtasks how to read the file, and the
  // supervisor writes UTF-16LE to match it. If one moves the other must.
  it('declares UTF-16, matching the bytes the supervisor writes', () => {
    expect(xml.split('\n')[0]).toBe('<?xml version="1.0" encoding="UTF-16"?>')
  })

  // Both placeholders have to survive into the shipped file, or the rendered
  // task points at nothing.
  it('carries every substitution placeholder', () => {
    expect(xml).toContain('$ION_BIN')
    expect(xml).toContain('$ION_ARGS')
    expect(xml).toContain('$ION_HOME')
    expect(xml).toContain('$ION_USER')
  })

  // The action's arguments are resolved at registration time, because what
  // the task runs depends on whether the GUI-subsystem host launcher is
  // installed beside the engine. A hardcoded `serve --supervised` here would
  // silently win over that decision and put a console window back on screen.
  it('leaves the action arguments to the supervisor', () => {
    const args = xml.match(/<Arguments>([\s\S]*?)<\/Arguments>/)?.[1] ?? ''
    expect(args).toBe('$ION_ARGS')
  })

  // An unscoped LogonTrigger means "when any user signs in" -- a machine-wide
  // registration a standard user may not make, which schtasks rejects with
  // "Access is denied".
  it('scopes the logon trigger to one account', () => {
    const trigger = xml.match(/<LogonTrigger>[\s\S]*?<\/LogonTrigger>/)?.[0] ?? ''
    expect(trigger).toContain('<UserId>$ION_USER</UserId>')
  })

  it('registers a per-user, least-privilege task', () => {
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>')
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>')
  })
})
