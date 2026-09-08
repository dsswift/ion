/**
 * Structural tests for packaging/windows/installer.nsh.
 *
 * NSIS cannot be run here, so these assert the shape of the branches that
 * decide whether a managed install is safe. That is worth pinning precisely
 * because both branches are ones nobody exercises by hand: the ACL failure
 * path only runs when icacls fails on a real machine, and the uninstall path
 * only runs at the end of a deployment. A regression in either is invisible
 * until a fleet is already wrong.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'

const nshPath = path.resolve(__dirname, '..', '..', '..', '..', 'packaging', 'windows', 'installer.nsh')
const nsh = readFileSync(nshPath, 'utf-8')

/** The body of one !macro <name> ... !macroend block. */
function macroBody(name: string): string {
  const start = nsh.indexOf(`!macro ${name}\n`)
  expect(start, `no !macro ${name} in installer.nsh`).toBeGreaterThan(-1)
  const end = nsh.indexOf('!macroend', start)
  expect(end, `!macro ${name} is not closed`).toBeGreaterThan(start)
  return nsh.slice(start, end)
}

describe('securing the enterprise policy directory', () => {
  const install = macroBody('customInstall')

  it('applies the documented ACL with well-known SIDs', () => {
    // Names are locale-dependent; the SIDs are not. An install on a German or
    // Japanese Windows must secure the same directory the same way.
    expect(install).toContain('/inheritance:r')
    expect(install).toContain('*S-1-5-32-544:(OI)(CI)F') // BUILTIN\Administrators
    expect(install).toContain('*S-1-5-18:(OI)(CI)F')     // NT AUTHORITY\SYSTEM
    expect(install).toContain('*S-1-5-32-545:(OI)(CI)RX') // BUILTIN\Users, read+execute only
  })

  // The regression. This branch used to log a warning and continue, so an
  // install could report success while leaving %ProgramData%\Ion writable by
  // any standard user -- who could then author the machine policy their own
  // engine reads. On a shared host that is the difference between an enforced
  // policy and a suggestion, and a fleet that looks compliant and is not.
  it('fails the install when the ACL cannot be applied', () => {
    const aclBranch = install.slice(install.indexOf('icacls'))
    expect(aclBranch).toContain('Quit')
    expect(aclBranch).toMatch(/SetErrorLevel \d+/)
    expect(aclBranch).toMatch(/MessageBox[^\n]*ICONSTOP/)
    // A warning that lets the install continue is exactly what was removed.
    expect(aclBranch).not.toMatch(/Warning: could not secure/)
  })

  it('fails the install when the policy directory cannot be created at all', () => {
    const createBranch = install.slice(install.indexOf('CreateDirectory'), install.indexOf('icacls'))
    expect(createBranch).toContain('Quit')
  })

  // Uninstall runs after $INSTDIR has been removed, so the cleanup tool has to
  // live somewhere else by then.
  it('places the cleanup tool where uninstall can still reach it', () => {
    expect(install).toContain('Remove-IonEngineTasks.ps1')
  })
})

describe('uninstall removes the supervisor tasks', () => {
  const uninstall = macroBody('customUnInstall')

  // Every Ion Engine task runs an executable inside $INSTDIR. An uninstall
  // that leaves them registered leaves a task firing at every sign-in against
  // a binary that no longer exists -- one orphan per account on a
  // multi-session host.
  it('invokes the cleanup script', () => {
    expect(uninstall).toContain('Remove-IonEngineTasks.ps1')
    expect(uninstall).toContain('powershell.exe')
    expect(uninstall).toContain('-ExecutionPolicy Bypass')
  })

  it('logs both outcomes and the remediation command', () => {
    expect(uninstall).toMatch(/exit code \$0/)
    expect(uninstall).toMatch(/\$0 != 0/)
    expect(uninstall).toMatch(/administrator/i)
  })

  // The uninstall must never take user data with it, and must never remove
  // administrator-owned machine policy.
  it('touches neither the user profile nor the policy files', () => {
    expect(uninstall).not.toMatch(/RMDir[^\n]*\.ion/)
    expect(uninstall).not.toMatch(/Delete[^\n]*\.ion/)
    expect(uninstall).not.toMatch(/RMDir[^\n]*ProgramData/)
  })

  // A missing tool is a degraded uninstall, not a blocked one: the
  // application still has to come off the machine, and the operator has to be
  // told the tasks were not swept.
  it('reports rather than blocks when the cleanup tool is missing', () => {
    expect(uninstall).toMatch(/FileExists/)
    expect(uninstall).toMatch(/WARNING/)
    expect(uninstall).not.toContain('Quit')
  })
})

/**
 * NSIS argument parsing.
 *
 * A backslash is an ordinary character to the NSIS parser; only `$\"` escapes
 * a quote inside a quoted string. So a `\"` written as if C or PowerShell owned
 * the string does not escape anything -- it closes the argument early, and the
 * rest of the text becomes further arguments. `!insertmacro ionLog "...\"...\""`
 * therefore passed three arguments to a macro that declares one, which NSIS
 * rejects at compile time and which fails the entire installer build rather
 * than misbehaving at runtime.
 */

/** Every line with its `;` comment stripped, respecting quoted strings. */
function codeLines(): { n: number; text: string }[] {
  return nsh.split('\n').map((line, i) => {
    let inQuote: string | null = null
    for (let c = 0; c < line.length; c++) {
      const ch = line[c]
      // `$\` escapes the next character, quote included.
      if (ch === '$' && line[c + 1] === '\\') { c += 2; continue }
      if (inQuote) { if (ch === inQuote) inQuote = null; continue }
      if (ch === '"' || ch === "'" || ch === '`') { inQuote = ch; continue }
      if (ch === ';' || (ch === '#' && c === 0)) return { n: i + 1, text: line.slice(0, c) }
    }
    return { n: i + 1, text: line }
  })
}

/** Split an NSIS statement into arguments exactly as NSIS's parser does. */
function nsisArgs(text: string): string[] {
  const args: string[] = []
  let cur = ''
  let started = false
  let inQuote: string | null = null
  for (let c = 0; c < text.length; c++) {
    const ch = text[c]
    if (ch === '$' && text[c + 1] === '\\') { cur += text[c + 2] ?? ''; started = true; c += 2; continue }
    if (inQuote) {
      if (ch === inQuote) { inQuote = null; continue }
      cur += ch
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { inQuote = ch; started = true; continue }
    if (/\s/.test(ch)) {
      if (started) { args.push(cur); cur = ''; started = false }
      continue
    }
    cur += ch
    started = true
  }
  if (started) args.push(cur)
  return args
}

describe('NSIS macro arguments', () => {
  // The regression. Written as a scan rather than a check of the one line that
  // broke, because the next author reaching for a nested quote will reach for
  // the same wrong escape somewhere else in the file.
  it('never escapes a nested quote with a backslash', () => {
    const offenders = codeLines()
      .filter(({ text }) => /(^|[^$])\\"/.test(text))
      .map(({ n, text }) => `${n}: ${text.trim()}`)
    expect(offenders, 'use $\\" -- a backslash escapes nothing in NSIS').toEqual([])
  })

  // Argument COUNT is what NSIS actually rejected, so it is what gets pinned:
  // a wrong escape shows up here as an ionLog call carrying two or three
  // arguments instead of one.
  it('passes exactly one argument to every ionLog insertion', () => {
    const calls = codeLines().filter(({ text }) => /^\s*!insertmacro\s+ionLog\b/.test(text))
    expect(calls.length, 'no ionLog insertions found; the scan is not reaching the file')
      .toBeGreaterThan(5)
    for (const { n, text } of calls) {
      // ['!insertmacro', 'ionLog', <Text>]
      expect(nsisArgs(text), `line ${n} expands to the wrong argument count: ${text.trim()}`)
        .toHaveLength(3)
    }
  })

  // The remediation line is the one that broke, and it has to keep the quotes
  // it needs: an administrator copies this command, and a path with a space in
  // it is unrunnable unquoted.
  it('keeps the remediation command quoted, the NSIS way', () => {
    const line = codeLines().find(({ text }) => text.includes('at least one Ion Engine task remains'))
    expect(line, 'the remediation log line is gone').toBeDefined()
    expect(nsisArgs(line!.text)).toHaveLength(3)
    expect(nsisArgs(line!.text)[2]).toContain('-File "$1\\Ion\\Remove-IonEngineTasks.ps1"')
  })
})
