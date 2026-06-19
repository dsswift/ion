import { ipcMain } from 'electron'
import { existsSync, readdirSync, readFileSync, statSync, createReadStream } from 'fs'
import { createInterface } from 'readline'
import { homedir } from 'os'
import { basename, join } from 'path'
import { IPC } from '../../shared/types'
import { log as _log } from '../logger'
import { sessionPlane, engineBridge } from '../state'
import { isValidProjectPath, isValidSessionId, resolveDiscoveryWorkingDir } from '../ipc-validation'
import {
  cleanCliTags,
  collapseSessionChains,
  decodeProjectPath,
  extractBashEntries,
  extractTag,
  loadClaudeSessionMessages,
  loadEngineConversationMessages,
  parseSessionMeta,
} from '../session-meta'
import {
  currentBackend,
  loadSessionLabels,
  readClaudeCompat,
} from '../settings-store'

function log(msg: string): void {
  _log('main', msg)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function registerSessionsListIpc(): void {
  ipcMain.handle(IPC.DISCOVER_COMMANDS, async (_e, projectPath: string) => {
    log(`IPC DISCOVER_COMMANDS (path=${projectPath})`)
    try {
      // '~' / empty → user-only discovery (walk ~/.ion, ~/.claude); a present,
      // non-'~' value must be an absolute project root. resolveDiscoveryWorkingDir
      // returns null for a malformed present path.
      const workingDir = resolveDiscoveryWorkingDir(projectPath)
      if (workingDir === null) {
        log(`DISCOVER_COMMANDS: rejected invalid projectPath: ${projectPath}`)
        return []
      }
      // The engine OWNS slash resolution + expansion, so it is the authority
      // on which filesystem `.md`/skill templates exist across .ion/commands,
      // .claude/commands, skills, and project roots. Ask it via
      // discover_slash_commands instead of walking the filesystem in TS. The
      // enableClaudeCompat setting gates whether the engine honors the .claude /
      // ~/.claude roots (commands AND skills); the desktop reads the setting and
      // hands it to the engine (which holds no opinion on it). Extension commands
      // (engine_command_registry) are unioned by the renderer's autocomplete UI,
      // not here.
      const claudeCompat = readClaudeCompat()
      const commands = await engineBridge.discoverSlashCommands(workingDir, claudeCompat)
      log(`DISCOVER_COMMANDS: engine returned ${commands.length} entries (workingDir=${workingDir || '(user-only)'}, claudeCompat=${claudeCompat})`)
      return commands
    } catch (err) {
      log(`DISCOVER_COMMANDS error: ${err}`)
      return []
    }
  })

  ipcMain.handle(IPC.LIST_SESSIONS, async (_e, projectPath?: string) => {
    log(`IPC LIST_SESSIONS ${projectPath ? `(path=${projectPath})` : ''}`)
    try {
      const cwd = projectPath || process.cwd()
      if (!isValidProjectPath(cwd)) {
        log(`LIST_SESSIONS: rejected invalid projectPath: ${cwd}`)
        return []
      }
      const encodedPath = cwd.replace(/[/.]/g, '-')
      const sessionsDir = join(homedir(), '.claude', 'projects', encodedPath)
      if (!existsSync(sessionsDir)) {
        log(`LIST_SESSIONS: directory not found: ${sessionsDir}`)
        return []
      }
      const files = readdirSync(sessionsDir).filter((f: string) => f.endsWith('.jsonl'))

      const sessions: Array<{ sessionId: string; slug: string | null; firstMessage: string | null; lastResponse: string | null; firstTimestamp: string; lastTimestamp: string; size: number }> = []

      for (const file of files) {
        const fileSessionId = file.replace(/\.jsonl$/, '')
        if (!UUID_RE.test(fileSessionId)) continue

        const filePath = join(sessionsDir, file)
        const stat = statSync(filePath)
        if (stat.size < 100) continue

        const meta: { validated: boolean; slug: string | null; firstMessage: string | null; lastResponse: string | null; firstTimestamp: string | null; lastTimestamp: string | null } = {
          validated: false, slug: null, firstMessage: null, lastResponse: null, firstTimestamp: null, lastTimestamp: null,
        }

        await new Promise<void>((resolve) => {
          const rl = createInterface({ input: createReadStream(filePath) })
          rl.on('line', (line: string) => {
            try {
              const obj = JSON.parse(line)
              if (!meta.validated && obj.type && obj.uuid && obj.timestamp) {
                meta.validated = true
              }
              if (obj.slug && !meta.slug) meta.slug = obj.slug
              if (obj.timestamp) {
                if (!meta.firstTimestamp) meta.firstTimestamp = obj.timestamp
                meta.lastTimestamp = obj.timestamp
              }
              if (obj.type === 'user' && !meta.firstMessage) {
                const content = obj.message?.content
                let raw = ''
                if (typeof content === 'string') {
                  raw = content
                } else if (Array.isArray(content)) {
                  raw = (content.find((p: any) => p.type === 'text')?.text) || ''
                }
                if (!raw || raw.includes('<local-command-caveat') || raw.includes('<bash-stdout') || raw.includes('<bash-stderr') || raw.includes('<system-reminder') || raw.includes('<command-name')) {
                  // skip
                } else if (raw.includes('<bash-input')) {
                  const cmd = extractTag(raw, 'bash-input')
                  if (cmd) meta.firstMessage = `! ${cmd.trim()}`.substring(0, 100)
                } else {
                  const cleaned = cleanCliTags(raw)
                  const { bashEntries } = extractBashEntries(cleaned)
                  if (bashEntries.length > 0) {
                    meta.firstMessage = `! ${bashEntries[0].command}`.substring(0, 100)
                  } else {
                    meta.firstMessage = cleaned.substring(0, 100) || null
                  }
                }
              }
              if (obj.type === 'assistant') {
                const content = obj.message?.content
                let raw = ''
                if (typeof content === 'string') {
                  raw = content
                } else if (Array.isArray(content)) {
                  raw = (content.find((p: any) => p.type === 'text')?.text) || ''
                }
                if (raw) {
                  const cleaned = cleanCliTags(raw).substring(0, 100)
                  if (cleaned) meta.lastResponse = cleaned
                }
              }
            } catch {}
          })
          rl.on('close', () => resolve())
        })

        if (meta.validated) {
          sessions.push({
            sessionId: fileSessionId,
            slug: meta.slug,
            firstMessage: meta.firstMessage,
            lastResponse: meta.lastResponse,
            firstTimestamp: meta.firstTimestamp || stat.mtime.toISOString(),
            lastTimestamp: meta.lastTimestamp || stat.mtime.toISOString(),
            size: stat.size,
          })
        }
      }

      sessions.sort((a, b) => new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime())
      const top = sessions.slice(0, 20)

      const labels = loadSessionLabels()
      for (const s of top) {
        (s as any).customTitle = labels[s.sessionId] || null
        ;(s as any).projectPath = null
        ;(s as any).projectLabel = null
        ;(s as any).encodedDir = null
      }

      return collapseSessionChains(top as any)
    } catch (err) {
      log(`LIST_SESSIONS error: ${err}`)
      return []
    }
  })

  ipcMain.handle(IPC.LIST_ALL_SESSIONS, async () => {
    log('IPC LIST_ALL_SESSIONS')
    try {
      const projectsRoot = join(homedir(), '.claude', 'projects')
      if (!existsSync(projectsRoot)) return []

      const candidates: Array<{ encodedDir: string; sessionId: string; mtime: number; size: number; filePath: string }> = []
      const dirs = readdirSync(projectsRoot)

      for (const encodedDir of dirs) {
        const dirPath = join(projectsRoot, encodedDir)
        try {
          if (!statSync(dirPath).isDirectory()) continue
        } catch { continue }

        const files = readdirSync(dirPath).filter((f: string) => f.endsWith('.jsonl'))
        for (const file of files) {
          const sessionId = file.replace(/\.jsonl$/, '')
          if (!UUID_RE.test(sessionId)) continue
          const fp = join(dirPath, file)
          try {
            const st = statSync(fp)
            if (st.size < 100) continue
            candidates.push({ encodedDir, sessionId, mtime: st.mtime.getTime(), size: st.size, filePath: fp })
          } catch { continue }
        }
      }

      candidates.sort((a, b) => b.mtime - a.mtime)
      const top = candidates.slice(0, 50)

      const labels = loadSessionLabels()
      const pathCache = new Map<string, string | null>()
      const sessions: Array<{ sessionId: string; slug: string | null; firstMessage: string | null; lastResponse: string | null; lastTimestamp: string; size: number; customTitle: string | null; projectPath: string | null; projectLabel: string | null; encodedDir: string }> = []

      for (const c of top) {
        const parsed = await parseSessionMeta(c.filePath, c.sessionId, c.size, new Date(c.mtime))
        if (!parsed) continue

        let projectPath: string | null
        if (pathCache.has(c.encodedDir)) {
          projectPath = pathCache.get(c.encodedDir)!
        } else {
          projectPath = decodeProjectPath(c.encodedDir)
          pathCache.set(c.encodedDir, projectPath)
        }

        const projectLabel = projectPath
          ? basename(projectPath)
          : c.encodedDir.split('-').filter(Boolean).pop() || c.encodedDir

        sessions.push({
          ...parsed,
          customTitle: labels[parsed.sessionId] || null,
          projectPath,
          projectLabel,
          encodedDir: c.encodedDir,
        })
      }

      const collapsed = collapseSessionChains(sessions)
      log(`LIST_ALL_SESSIONS: found ${sessions.length} sessions (${collapsed.length} after chain grouping) across ${pathCache.size} directories`)
      return collapsed
    } catch (err) {
      log(`LIST_ALL_SESSIONS error: ${err}`)
      return []
    }
  })

  ipcMain.handle(IPC.LOAD_SESSION, async (_e, arg: { sessionId: string; projectPath?: string; encodedDir?: string } | string) => {
    const sessionId = typeof arg === 'string' ? arg : arg.sessionId
    const projectPath = typeof arg === 'object' ? arg.projectPath : undefined
    const encodedDir = typeof arg === 'object' ? arg.encodedDir : undefined
    log(`IPC LOAD_SESSION ${sessionId}`)
    try {
      if (!isValidSessionId(sessionId)) {
        log(`LOAD_SESSION: rejected invalid sessionId: ${sessionId}`)
        return []
      }

      if (currentBackend === 'cli') {
        const msgs = loadClaudeSessionMessages(sessionId, projectPath, encodedDir)
        if (msgs.length > 0) return msgs
      }

      const msgs = await sessionPlane.loadSessionHistory(sessionId)
      if (msgs && msgs.length > 0) return msgs

      const directMsgs = loadEngineConversationMessages(sessionId)
      return directMsgs
    } catch (err) {
      log(`LOAD_SESSION error: ${err}`)
      try {
        return loadEngineConversationMessages(sessionId)
      } catch {
        return []
      }
    }
  })

  ipcMain.handle(IPC.READ_PLAN, async (_e, filePath: string) => {
    try {
      log(`READ_PLAN: path=${filePath} exists=${filePath ? existsSync(filePath) : false}`)
      if (!filePath || !existsSync(filePath)) return { content: null, fileName: null }
      const content = readFileSync(filePath, 'utf-8')
      const fileName = filePath.split('/').pop() || filePath
      log(`READ_PLAN: success, ${content.length} chars`)
      return { content, fileName }
    } catch (err) {
      log(`READ_PLAN error: ${err}`)
      return { content: null, fileName: null }
    }
  })

  ipcMain.handle(IPC.READ_IMAGE_DATA_URL, async (_e, filePath: string) => {
    try {
      if (!filePath || !existsSync(filePath)) return { dataUrl: null }
      const ext = filePath.toLowerCase()
      const mime =
        ext.endsWith('.png') ? 'image/png' :
        ext.endsWith('.webp') ? 'image/webp' :
        ext.endsWith('.gif') ? 'image/gif' :
        (ext.endsWith('.jpg') || ext.endsWith('.jpeg')) ? 'image/jpeg' :
        null
      if (!mime) return { dataUrl: null }
      const buf = readFileSync(filePath)
      // 30 MB cap on what we'll embed in a data URL — anything larger is a
      // bug somewhere upstream and would freeze the renderer if shipped.
      if (buf.length > 30 * 1024 * 1024) return { dataUrl: null }
      return { dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
    } catch (err) {
      log(`READ_IMAGE_DATA_URL error: ${err}`)
      return { dataUrl: null }
    }
  })

  ipcMain.handle(IPC.GET_CONVERSATION, async (_e, { conversationId, offset, limit }: { conversationId: string; offset: number; limit: number }) => {
    try {
      return await sessionPlane.getConversation(conversationId, offset, limit)
    } catch (err) {
      log(`GET_CONVERSATION error: ${err}`)
      return { messages: [], total: 0, hasMore: false }
    }
  })

  ipcMain.handle(IPC.LOAD_CHAIN_HISTORY, async (_e, sessionIds: string[]) => {
    log(`IPC LOAD_CHAIN_HISTORY count=${Array.isArray(sessionIds) ? sessionIds.length : 'invalid'}`)
    try {
      if (!Array.isArray(sessionIds) || sessionIds.some((id) => !isValidSessionId(id))) {
        log('LOAD_CHAIN_HISTORY: rejected invalid sessionIds')
        return []
      }
      const result = await sessionPlane.loadChainHistory(sessionIds)
      log(`LOAD_CHAIN_HISTORY: returned ${result.length} messages for ${sessionIds.length} sessions`)
      return result
    } catch (err) {
      log(`LOAD_CHAIN_HISTORY error: ${err}`)
      return []
    }
  })
}
