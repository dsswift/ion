/**
 * The git-host CLIs the host user is signed in to (`gh`, `glab`, `az`), and
 * the token each will hand over. Which hosts a CLI is signed in to is read
 * from the CLI's own config file, so a host without a sign-in costs no
 * subprocess; the token itself always comes from the CLI, which owns where
 * it is kept (a keyring, usually).
 */
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { GitIdentityTool } from '@ion/shared/types-git-identity'
import { gitExec } from '../git-exec'
import { log as _log, warn as _warn } from '../../logger'

const TAG = 'git-identity-host-cli'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** Azure DevOps's fixed resource id for an Entra access token. */
const ADO_RESOURCE_APP_ID = '499b84ac-1321-427f-aa17-267ca6975798'
export const ADO_CLI_HOST = 'dev.azure.com'

/** One host a CLI on this machine is signed in to. */
export interface HostCliSignIn {
  tool: GitIdentityTool
  host: string
  /** The account name the CLI recorded; empty when it recorded none. */
  account: string
}

function readText(path: string): string | null {
  try { return readFileSync(path, 'utf-8').replace(/^﻿/, '') } catch { return null } // silent-ok: an absent CLI config means that CLI is not signed in
}

function configHome(home: string): string {
  return process.env.XDG_CONFIG_HOME || join(home, '.config')
}

/** The top-level keys of a two-level YAML map, each with its nested `user:` value. Enough for the `gh` and `glab` host files; neither nests a host deeper. */
function hostsWithUser(lines: string[], hostIndent: number): Array<{ host: string; user: string }> {
  const found: Array<{ host: string; user: string }> = []
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const host = /^([\w.:-]+):\s*$/.exec(line.trim())
    if (indent === hostIndent && host) { found.push({ host: host[1], user: '' }); continue }
    if (indent < hostIndent) continue
    const user = /^user:\s*(\S+)\s*$/.exec(line.trim())
    const last = found[found.length - 1]
    if (user && last && !last.user) last.user = user[1].replace(/^["']|["']$/g, '')
  }
  return found
}

function ghSignIns(home: string): HostCliSignIn[] {
  const dir = process.env.GH_CONFIG_DIR || (process.platform === 'win32' && process.env.APPDATA ? join(process.env.APPDATA, 'GitHub CLI') : join(configHome(home), 'gh'))
  const text = readText(join(dir, 'hosts.yml'))
  if (!text) return []
  return hostsWithUser(text.split('\n'), 0).map(({ host, user }) => ({ tool: 'gh', host, account: user }))
}

function glabSignIns(home: string): HostCliSignIn[] {
  const dir = process.env.GLAB_CONFIG_DIR || join(configHome(home), 'glab-cli')
  const text = readText(join(dir, 'config.yml'))
  if (!text) return []
  const lines = text.split('\n')
  const start = lines.findIndex((l) => /^hosts:\s*$/.test(l))
  if (start < 0) return []
  const block: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !/^\s/.test(line)) break
    block.push(line)
  }
  const indent = block.find((l) => l.trim())?.match(/^\s*/)?.[0].length ?? 0
  // A host listed with no user has never been signed in to: glab seeds gitlab.com that way.
  return hostsWithUser(block, indent).filter(({ user }) => user).map(({ host, user }) => ({ tool: 'glab', host, account: user }))
}

function azSignIns(home: string): HostCliSignIn[] {
  const text = readText(join(process.env.AZURE_CONFIG_DIR || join(home, '.azure'), 'azureProfile.json'))
  if (!text) return []
  try {
    const profile = JSON.parse(text) as { subscriptions?: Array<{ isDefault?: boolean; user?: { name?: string } }> }
    const subscriptions = profile.subscriptions ?? []
    const active = subscriptions.find((s) => s.isDefault) ?? subscriptions[0]
    return active ? [{ tool: 'az', host: ADO_CLI_HOST, account: active.user?.name ?? '' }] : []
  } catch (err) {
    warn('azure profile unreadable', { error: String(err) })
    return []
  }
}

/** Every host a git-host CLI on this machine is signed in to. */
export function listHostCliSignIns(home: string = homedir()): HostCliSignIn[] {
  return [...ghSignIns(home), ...glabSignIns(home), ...azSignIns(home)]
}

function tokenCommand(signIn: HostCliSignIn): string[] {
  switch (signIn.tool) {
    case 'gh': return ['auth', 'token', '--hostname', signIn.host]
    case 'glab': return ['config', 'get', 'token', '--host', signIn.host]
    case 'az': return ['account', 'get-access-token', '--resource', ADO_RESOURCE_APP_ID, '--query', 'accessToken', '--output', 'tsv']
  }
}

/** Asks the CLI for its token. Null when the CLI is missing, signed out, or fails; the reason is logged. */
export type HostCliTokenReader = (signIn: HostCliSignIn) => Promise<string | null>

export const readHostCliToken: HostCliTokenReader = async (signIn) => {
  const started = Date.now()
  try {
    const { stdout } = await gitExec(signIn.tool, tokenCommand(signIn), { timeout: 15_000 })
    const token = stdout.trim()
    log('host cli token read', { tool: signIn.tool, git_host: signIn.host, found: token !== '', duration_ms: Date.now() - started })
    return token || null
  } catch (err) {
    warn('host cli token read failed', { tool: signIn.tool, git_host: signIn.host, error: String(err), duration_ms: Date.now() - started })
    return null
  }
}
