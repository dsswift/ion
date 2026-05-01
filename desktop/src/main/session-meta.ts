import { createInterface } from 'readline'
import { createReadStream, existsSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { log as _log } from './logger'
import { loadSessionChains } from './settings-store'

function log(msg: string): void {
  _log('main', msg)
}

const PLAN_SLUG_RE = /^\[Attached plan: .*\/([^/]+)\.md\]/

export interface ParsedSessionMeta {
  sessionId: string
  slug: string | null
  firstMessage: string | null
  lastResponse: string | null
  firstTimestamp: string
  lastTimestamp: string
  size: number
}

export function cleanCliTags(text: string): string {
  let result = text.replace(/<(?:local-command-caveat|system-reminder|command-name|command-message|command-args|task-notification)[^>]*>[\s\S]*?<\/(?:local-command-caveat|system-reminder|command-name|command-message|command-args|task-notification)>\s*(?:Read the output file to retrieve the result:[^\n]*)?\n?/g, '')
  result = result.replace(/<\/?(?:bash-input|bash-stdout|bash-stderr)[^>]*>/g, '')
  return result.trim()
}

export function extractTag(text: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`)
  const m = text.match(re)
  return m ? m[1] : null
}

export function extractBashEntries(text: string): { bashEntries: Array<{ command: string; output: string }>; remainder: string } {
  const entries: Array<{ command: string; output: string }> = []
  let rest = text

  const pattern = /^\$ (.+)\n```\n([\s\S]*?)\n```(?:\nstderr:\n```\n[\s\S]*?\n```)?\s*/
  let match = rest.match(pattern)
  while (match) {
    entries.push({ command: match[1], output: match[2] })
    rest = rest.slice(match[0].length)
    match = rest.match(pattern)
  }

  return { bashEntries: entries, remainder: rest }
}

export function discoverImplicitChains(
  sessions: any[],
  chainIndex: { chains: Record<string, string[]>; reverse: Record<string, string> },
): void {
  const slugMap = new Map<string, any>()
  for (const s of sessions) {
    if (s.slug) slugMap.set(s.slug, s)
  }

  for (const s of sessions) {
    if (chainIndex.reverse[s.sessionId] || chainIndex.chains[s.sessionId]) continue
    if (!s.firstMessage) continue

    const match = PLAN_SLUG_RE.exec(s.firstMessage)
    if (!match) continue

    const planSlug = match[1]
    const planningSession = slugMap.get(planSlug)
    if (!planningSession || planningSession.sessionId === s.sessionId) continue
    if (chainIndex.reverse[planningSession.sessionId]) continue

    if (chainIndex.chains[planningSession.sessionId]) {
      chainIndex.chains[planningSession.sessionId].push(s.sessionId)
    } else {
      chainIndex.chains[planningSession.sessionId] = [s.sessionId]
    }
    chainIndex.reverse[s.sessionId] = planningSession.sessionId
  }
}

export function collapseSessionChains(sessions: any[]): any[] {
  const chainIndex = loadSessionChains()
  discoverImplicitChains(sessions, chainIndex)

  if (Object.keys(chainIndex.chains).length === 0) {
    return sessions.map((s) => ({ ...s, chainSessionIds: [s.sessionId], chainLength: 1 }))
  }

  const sessionMap = new Map<string, any>()
  for (const s of sessions) sessionMap.set(s.sessionId, s)

  const consumed = new Set<string>()
  const result: any[] = []

  for (const s of sessions) {
    if (consumed.has(s.sessionId)) continue

    const rootId = chainIndex.reverse[s.sessionId]
    if (rootId && rootId !== s.sessionId) {
      if (sessionMap.has(rootId)) continue
      const rootChain = chainIndex.chains[rootId]
      if (rootChain) {
        const allIds = [rootId, ...rootChain]
        const presentSessions = allIds.map((id) => sessionMap.get(id)).filter(Boolean)
        if (presentSessions.length > 1) {
          const latest = presentSessions.reduce((a, b) =>
            new Date(b.lastTimestamp).getTime() > new Date(a.lastTimestamp).getTime() ? b : a,
          )
          const totalSize = presentSessions.reduce((sum, p) => sum + p.size, 0)
          const earliest = presentSessions.reduce((a, b) =>
            new Date(a.lastTimestamp).getTime() < new Date(b.lastTimestamp).getTime() ? a : b,
          )
          result.push({
            ...earliest,
            lastTimestamp: latest.lastTimestamp,
            lastResponse: latest.lastResponse,
            size: totalSize,
            chainSessionIds: allIds,
            chainLength: allIds.length,
          })
          for (const id of allIds) consumed.add(id)
          continue
        }
      }
    }

    const chainMembers = chainIndex.chains[s.sessionId]
    if (chainMembers && chainMembers.length > 0) {
      const allIds = [s.sessionId, ...chainMembers]
      const presentSessions = allIds.map((id) => sessionMap.get(id)).filter(Boolean)

      if (presentSessions.length <= 1) {
        result.push({ ...s, chainSessionIds: [s.sessionId], chainLength: 1 })
        consumed.add(s.sessionId)
        continue
      }

      const root = sessionMap.get(s.sessionId) || presentSessions[0]
      const latest = presentSessions.reduce((a, b) =>
        new Date(b.lastTimestamp).getTime() > new Date(a.lastTimestamp).getTime() ? b : a,
      )
      const totalSize = presentSessions.reduce((sum, p) => sum + p.size, 0)

      result.push({
        ...root,
        lastTimestamp: latest.lastTimestamp,
        lastResponse: latest.lastResponse,
        size: totalSize,
        chainSessionIds: allIds,
        chainLength: allIds.length,
      })
      for (const id of allIds) consumed.add(id)
    } else {
      result.push({ ...s, chainSessionIds: [s.sessionId], chainLength: 1 })
      consumed.add(s.sessionId)
    }
  }

  return result
}

export async function parseSessionMeta(
  filePath: string,
  fileSessionId: string,
  fileSize: number,
  fileMtime: Date,
): Promise<ParsedSessionMeta | null> {
  const meta = {
    validated: false,
    slug: null as string | null,
    firstMessage: null as string | null,
    lastResponse: null as string | null,
    firstTimestamp: null as string | null,
    lastTimestamp: null as string | null,
  }

  await new Promise<void>((resolve) => {
    const rl = createInterface({ input: createReadStream(filePath) })
    rl.on('line', (line: string) => {
      try {
        const obj = JSON.parse(line)
        if (!meta.validated && obj.type && obj.uuid && obj.timestamp) meta.validated = true
        if (obj.slug && !meta.slug) meta.slug = obj.slug
        if (obj.timestamp) {
          if (!meta.firstTimestamp) meta.firstTimestamp = obj.timestamp
          meta.lastTimestamp = obj.timestamp
        }
        if (obj.type === 'user' && !meta.firstMessage) {
          const content = obj.message?.content
          let raw = ''
          if (typeof content === 'string') raw = content
          else if (Array.isArray(content)) raw = (content.find((p: any) => p.type === 'text')?.text) || ''
          if (!raw || raw.includes('<local-command-caveat') || raw.includes('<bash-stdout') || raw.includes('<bash-stderr') || raw.includes('<system-reminder') || raw.includes('<command-name')) {
            // skip
          } else if (raw.includes('<bash-input')) {
            const cmd = extractTag(raw, 'bash-input')
            if (cmd) meta.firstMessage = `! ${cmd.trim()}`.substring(0, 100)
          } else {
            const cleaned = cleanCliTags(raw)
            const { bashEntries } = extractBashEntries(cleaned)
            if (bashEntries.length > 0) meta.firstMessage = `! ${bashEntries[0].command}`.substring(0, 100)
            else meta.firstMessage = cleaned.substring(0, 100) || null
          }
        }
        if (obj.type === 'assistant') {
          const content = obj.message?.content
          let raw = ''
          if (typeof content === 'string') raw = content
          else if (Array.isArray(content)) raw = (content.find((p: any) => p.type === 'text')?.text) || ''
          if (raw) {
            const cleaned = cleanCliTags(raw).substring(0, 100)
            if (cleaned) meta.lastResponse = cleaned
          }
        }
      } catch {}
    })
    rl.on('close', () => resolve())
  })

  if (!meta.validated) return null
  return {
    sessionId: fileSessionId,
    slug: meta.slug,
    firstMessage: meta.firstMessage,
    lastResponse: meta.lastResponse,
    firstTimestamp: meta.firstTimestamp || fileMtime.toISOString(),
    lastTimestamp: meta.lastTimestamp || fileMtime.toISOString(),
    size: fileSize,
  }
}

export function decodeProjectPath(encoded: string): string | null {
  if (!encoded.startsWith('-')) return null
  const segments = encoded.slice(1).split('-')
  if (segments.length === 0) return null

  let current = '/'
  let i = 0
  while (i < segments.length) {
    let matched = false
    for (let end = segments.length; end > i; end--) {
      const candidate = segments.slice(i, end).join('-')
      const testPath = join(current, candidate)
      try {
        if (existsSync(testPath) && statSync(testPath).isDirectory()) {
          current = testPath
          i = end
          matched = true
          break
        }
      } catch {}
    }
    if (!matched) return null
  }
  return current
}

export function loadEngineConversationMessages(sessionId: string): any[] {
  const convDir = join(homedir(), '.ion', 'conversations')
  const filePath = join(convDir, `${sessionId}.jsonl`)
  if (!existsSync(filePath)) {
    log(`loadEngineConversation: file not found: ${filePath}`)
    return []
  }

  const data = readFileSync(filePath, 'utf-8')
  const lines = data.split('\n').filter(Boolean)
  const result: any[] = []
  const toolCallIndex: Record<string, number> = {}

  for (const line of lines) {
    let obj: any
    try { obj = JSON.parse(line) } catch { continue }

    if (obj.meta || obj.type !== 'message') continue

    const msg = obj.data
    if (!msg || !msg.role) continue
    const timestamp = obj.timestamp || 0

    if (msg.role === 'user') {
      const content = msg.content
      if (typeof content === 'string') {
        if (content.trim()) result.push({ role: 'user', content: cleanCliTags(content), timestamp })
      } else if (Array.isArray(content)) {
        const textParts: string[] = []
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            const cleaned = cleanCliTags(block.text)
            if (cleaned) textParts.push(cleaned)
          } else if (block.type === 'tool_result' && block.tool_use_id) {
            const idx = toolCallIndex[block.tool_use_id]
            if (idx !== undefined) {
              let resultContent = ''
              if (typeof block.content === 'string') {
                resultContent = block.content
              } else if (Array.isArray(block.content)) {
                resultContent = block.content
                  .filter((p: any) => p.type === 'text')
                  .map((p: any) => p.text)
                  .join('\n')
              }
              result[idx].content = resultContent
            }
          }
        }
        if (textParts.length > 0) {
          result.push({ role: 'user', content: textParts.join('\n'), timestamp })
        }
      }
    } else if (msg.role === 'assistant') {
      const content = msg.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          const cleaned = cleanCliTags(block.text)
          if (cleaned) result.push({ role: 'assistant', content: cleaned, timestamp })
        } else if (block.type === 'tool_use') {
          let inputJSON = ''
          if (block.input) {
            try { inputJSON = JSON.stringify(block.input) } catch {}
          }
          toolCallIndex[block.id] = result.length
          result.push({
            role: 'tool',
            content: '',
            toolName: block.name,
            toolId: block.id,
            toolInput: inputJSON,
            timestamp,
          })
        }
      }
    }
  }

  log(`loadEngineConversation: loaded ${result.length} messages from ${filePath}`)
  return result
}

export function loadClaudeSessionMessages(sessionId: string, projectPath?: string, encodedDir?: string): any[] {
  const projectsRoot = join(homedir(), '.claude', 'projects')
  let dir: string | null = null

  if (encodedDir) {
    dir = join(projectsRoot, encodedDir)
  } else if (projectPath) {
    const encoded = projectPath.replace(/\//g, '-')
    dir = join(projectsRoot, encoded)
  }

  if (!dir) return []

  const filePath = join(dir, `${sessionId}.jsonl`)
  if (!existsSync(filePath)) {
    log(`loadClaudeSessionMessages: file not found: ${filePath}`)
    return []
  }

  const data = readFileSync(filePath, 'utf-8')
  const lines = data.split('\n').filter(Boolean)
  const result: any[] = []
  const toolCallIndex: Record<string, number> = {}

  for (const line of lines) {
    let obj: any
    try { obj = JSON.parse(line) } catch { continue }

    const type = obj.type
    if (type !== 'user' && type !== 'assistant') continue

    const content = obj.message?.content
    const timestamp = obj.timestamp ? new Date(obj.timestamp).getTime() : 0

    if (type === 'user') {
      if (typeof content === 'string') {
        if (content.trim()) {
          result.push({ role: 'user', content: cleanCliTags(content), timestamp })
        }
      } else if (Array.isArray(content)) {
        const textParts: string[] = []
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            const cleaned = cleanCliTags(block.text)
            if (cleaned) textParts.push(cleaned)
          } else if (block.type === 'tool_result' && block.tool_use_id) {
            const idx = toolCallIndex[block.tool_use_id]
            if (idx !== undefined) {
              let resultContent = ''
              if (typeof block.content === 'string') {
                resultContent = block.content
              } else if (Array.isArray(block.content)) {
                resultContent = block.content
                  .filter((p: any) => p.type === 'text')
                  .map((p: any) => p.text)
                  .join('\n')
              }
              result[idx].content = resultContent
            }
          }
        }
        if (textParts.length > 0) {
          result.push({ role: 'user', content: textParts.join('\n'), timestamp })
        }
      }
    } else if (type === 'assistant') {
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          const cleaned = cleanCliTags(block.text)
          if (cleaned) {
            result.push({ role: 'assistant', content: cleaned, timestamp })
          }
        } else if (block.type === 'tool_use') {
          let inputJSON = ''
          if (block.input) {
            try { inputJSON = JSON.stringify(block.input) } catch {}
          }
          toolCallIndex[block.id] = result.length
          result.push({
            role: 'tool',
            content: '',
            toolName: block.name,
            toolId: block.id,
            toolInput: inputJSON,
            timestamp,
          })
        }
      }
    }
  }

  return result
}
