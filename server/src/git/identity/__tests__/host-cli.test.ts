/** host-cli — which hosts gh, glab and az are signed in to, read from each CLI's own config file. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { listHostCliSignIns } from '../host-cli'

let home: string
const saved = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, GH_CONFIG_DIR: process.env.GH_CONFIG_DIR, GLAB_CONFIG_DIR: process.env.GLAB_CONFIG_DIR, AZURE_CONFIG_DIR: process.env.AZURE_CONFIG_DIR }
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ion-host-cli-'))
  for (const key of Object.keys(saved)) delete process.env[key]
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
})

describe('listHostCliSignIns', () => {
  it('finds nothing on a host with no CLI config', () => {
    expect(listHostCliSignIns(home)).toEqual([])
  })

  it('reads each gh host with its account', () => {
    mkdirSync(join(home, '.config', 'gh'), { recursive: true })
    writeFileSync(join(home, '.config', 'gh', 'hosts.yml'), [
      'github.com:',
      '    git_protocol: ssh',
      '    users:',
      '        example-user:',
      '    user: example-user',
      'github.example.org:',
      '    user: other-user',
    ].join('\n'))
    expect(listHostCliSignIns(home)).toEqual([
      { tool: 'gh', host: 'github.com', account: 'example-user' },
      { tool: 'gh', host: 'github.example.org', account: 'other-user' },
    ])
  })

  it('reads glab hosts that have a user, and skips the seeded host that was never signed in to', () => {
    mkdirSync(join(home, '.config', 'glab-cli'), { recursive: true })
    writeFileSync(join(home, '.config', 'glab-cli', 'config.yml'), [
      'git_protocol: ssh',
      'hosts:',
      '    gitlab.com:',
      '        api_protocol: https',
      '    gitlab.example.org:',
      '        api_host: gitlab.example.org',
      '        user: example-user',
      'last_update_check_timestamp: 2026-01-01T00:00:00Z',
    ].join('\n'))
    expect(listHostCliSignIns(home)).toEqual([{ tool: 'glab', host: 'gitlab.example.org', account: 'example-user' }])
  })

  it('reads the az default subscription account, past a byte-order mark', () => {
    mkdirSync(join(home, '.azure'))
    writeFileSync(join(home, '.azure', 'azureProfile.json'), '﻿' + JSON.stringify({ subscriptions: [
      { isDefault: false, user: { name: 'other@example.org' } },
      { isDefault: true, user: { name: 'user@example.org' } },
    ] }))
    expect(listHostCliSignIns(home)).toEqual([{ tool: 'az', host: 'dev.azure.com', account: 'user@example.org' }])
  })
})
