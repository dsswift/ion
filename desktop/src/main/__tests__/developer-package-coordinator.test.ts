import { describe, expect, it } from 'vitest'
import { readFileSync, statSync, constants, accessSync } from 'node:fs'
import { join } from 'node:path'

const commandsDir = join(__dirname, '..', '..', '..', 'commands')
const finderEntryPath = join(commandsDir, 'install-app.command')
const coordinatorPath = join(commandsDir, 'install-post-build.command')
const developerBuildPath = join(commandsDir, 'install-bg.command')

describe('developer package coordinator', () => {
  it('is executable and accepts the built package as its only install input', () => {
    expect(statSync(coordinatorPath).isFile()).toBe(true)
    expect(() => accessSync(coordinatorPath, constants.X_OK)).not.toThrow()
    const body = readFileSync(coordinatorPath, 'utf8')
    expect(body).toContain('PACKAGE_PATH="${1:?package path is required}"')
    expect(body).toContain('open "$PACKAGE_PATH"')
    expect(body).not.toContain('cp -R')
    expect(body).not.toContain('rm -rf "$DEST"')
  })

  it('drains the running desktop without a coordinator timeout before opening Installer', () => {
    const body = readFileSync(coordinatorPath, 'utf8')
    expect(body).toContain('kill -USR1 "$APP_PID"')
    expect(body).toContain('while kill -0 "$APP_PID"')
    expect(body).not.toContain('TIMEOUT=')
    expect(body).not.toContain('kill -9')
  })

  it('routes the Finder install entry point through the same package pipeline', () => {
    const body = readFileSync(finderEntryPath, 'utf8')
    expect(body).toContain('exec bash ./commands/install-bg.command')
    expect(body).not.toContain('cp -R')
  })

  it('builds the local package and dispatches the coordinator with that package', () => {
    const body = readFileSync(developerBuildPath, 'utf8')
    expect(body).toContain('npm run pkg')
    expect(body).toContain('PACKAGE_PATH="release/Ion-${VERSION}.pkg"')
    expect(body).toContain('commands/install-post-build.command "$PACKAGE_PATH"')
  })
})
