/**
 * Every channel the server broadcasts must be in the Studio wire contract.
 *
 * `broadcast()` hands each channel to `publishStudioEvent`, which drops any
 * channel outside `EVENT_CHANNELS`. The server has no window, so a dropped
 * channel reaches nobody: the call site looks like it delivered something
 * and the feature behind it silently does nothing. Guided Questions answers,
 * every paired-device tab command, intercept banners, and MCP settings
 * convergence were all lost this way.
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import { describe, expect, it } from 'vitest'
import { IPC } from '@ion/shared/types'
import { EVENT_CHANNEL_NAMES } from '@ion/shared/studio-wire/channels'

const SRC = join(__dirname, '..', '..')

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) sourceFiles(full, out)
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

describe('server broadcasts', () => {
  it('only use channels the Studio wire carries', () => {
    const offWire: string[] = []
    const unknownConstants: string[] = []
    for (const file of sourceFiles(SRC)) {
      const source = readFileSync(file, 'utf8')
      for (const m of source.matchAll(/\bbroadcast\(\s*(?:IPC\.([A-Z0-9_]+)|'([^']+)'|"([^"]+)")/g)) {
        const where = `${relative(SRC, file)}`
        if (m[1]) {
          const channel = (IPC as Record<string, string>)[m[1]]
          if (!channel) unknownConstants.push(`${where}: IPC.${m[1]}`)
          else if (!EVENT_CHANNEL_NAMES.has(channel)) offWire.push(`${where}: IPC.${m[1]} (${channel})`)
        } else {
          const channel = m[2] ?? m[3]
          if (!EVENT_CHANNEL_NAMES.has(channel)) offWire.push(`${where}: '${channel}'`)
        }
      }
    }
    expect(unknownConstants).toEqual([])
    expect(offWire).toEqual([])
  })
})
