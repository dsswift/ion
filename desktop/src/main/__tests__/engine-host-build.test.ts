import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The two places ion-engine-host.exe is built: the local Windows build and
// the release workflow. Both are shell/YAML, so nothing else type-checks or
// parses them.
const ROOT = join(__dirname, '..', '..', '..', '..')
const LOCAL_BUILD = join(ROOT, 'scripts', 'windows', 'IonDesktop.ps1')
const CI_BUILD = join(ROOT, '.github', 'workflows', 'build.yml')

describe('ion-engine-host build flags', () => {
  // -H windowsgui is the entire mechanism. Linked without it the host is a
  // console-subsystem image, Task Scheduler allocates it a console, and the
  // terminal window this binary exists to prevent is back on the user's
  // screen -- with every other test still green, because nothing else
  // observes the PE subsystem. A dropped flag has to fail here or it fails
  // silently on a user's machine.
  it.each([
    ['the local Windows build', LOCAL_BUILD],
    ['the release workflow', CI_BUILD],
  ])('links the host for the GUI subsystem in %s', (_label, path) => {
    const text = readFileSync(path, 'utf-8')
    const hostBuild = text
      .split('\n')
      .find((line) => line.includes('./cmd/ion-engine-host'))
    expect(hostBuild, 'no ion-engine-host build step found').toBeDefined()

    // The flag sits on the ldflags line, which is the line above the one
    // naming the package in both files, so the assertion has to look at the
    // whole invocation. Comment lines are stripped first: both files explain
    // in prose why -H windowsgui matters, and matching that prose would let
    // the test pass on a build that no longer passes the flag.
    const invocation = text
      .slice(Math.max(0, text.indexOf('./cmd/ion-engine-host') - 400), text.indexOf('./cmd/ion-engine-host'))
      .split('\n')
      .filter((line) => !/^\s*(#|\/\/)/.test(line))
      .join('\n')
    expect(invocation).toContain('-H windowsgui')
  })

  // The engine itself must stay a console program: it is the CLI, and a
  // GUI-subsystem ion.exe prints nothing when a user runs `ion prompt`.
  it('does not link the engine binary for the GUI subsystem', () => {
    for (const path of [LOCAL_BUILD, CI_BUILD]) {
      const text = readFileSync(path, 'utf-8')
      for (const line of text.split('\n')) {
        if (line.includes('./cmd/ion/') || line.includes("'./cmd/ion'")) {
          expect(line).not.toContain('-H windowsgui')
        }
      }
    }
  })
})
