/**
 * Permission Hook Server
 *
 * A local HTTP server that acts as a Claude Code PreToolUse hook handler.
 * When Claude Code wants to use a tool, it POSTs the tool request here.
 * The server forwards it to the renderer (PermissionCard), waits for the
 * user's decision, and returns the structured hook response.
 *
 * This is a CODA-owned permission broker that approximates Claude Code's
 * practical permission cadence. It does not reproduce native permission
 * semantics exactly — it intercepts the small set of tool classes that
 * map to real, user-meaningful approval moments.
 *
 * Security:
 *   - Per-launch app secret in URL path (prevents local spoofing)
 *   - Per-run token in URL path (prevents cross-run confusion)
 *   - Deny-by-default on every failure path
 *   - Per-run settings files (only CODA-spawned sessions see the hook)
 */

import { createServer, IncomingMessage, ServerResponse } from 'http'
import { EventEmitter } from 'events'
import { writeFileSync, mkdirSync, unlinkSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { log as _log } from '../logger'
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
const DEFAULT_PORT = 19836
const MAX_BODY_SIZE = 1024 * 1024 // 1MB

const DEBUG = process.env.CODA_DEBUG === '1'

// Tools that need explicit user approval via the permission card.
// This is the small set of tool classes that map to real, user-meaningful
// approval moments. Routine internal agent mechanics (Read, Glob, Grep, etc.)
// are auto-approved via --allowedTools to avoid noisy UX.
const PERMISSION_REQUIRED_TOOLS = ['Bash', 'Edit', 'Write', 'MultiEdit']

// Bash commands that are clearly read-only and safe to auto-approve.
// Matches the leading command (before any pipes, semicolons, or &&).
const SAFE_BASH_COMMANDS = new Set([
  // Info / help
  'cat', 'head', 'tail', 'less', 'more', 'wc', 'file', 'stat',
  'ls', 'pwd', 'echo', 'printf', 'date', 'whoami', 'hostname', 'uname',
  'which', 'whence', 'where', 'type', 'command',
  'man', 'help', 'info',
  // Search
  'find', 'grep', 'rg', 'ag', 'ack', 'fd', 'fzf', 'locate',
  // Git read-only
  'git', // further checked: only read-only subcommands
  // Env / config
  'env', 'printenv', 'set',
  // Package info (read-only)
  'npm', 'yarn', 'pnpm', 'bun', 'cargo', 'pip', 'pip3', 'go', 'rustup',
  'node', 'python', 'python3', 'ruby', 'java', 'javac',
  // Claude CLI (read-only subcommands)
  'claude',
  // Disk / system info
  'df', 'du', 'free', 'top', 'htop', 'ps', 'uptime', 'lsof',
  'tree', 'realpath', 'dirname', 'basename',
  // macOS
  'sw_vers', 'system_profiler', 'defaults', 'mdls', 'mdfind',
  // Diff / compare
  'diff', 'cmp', 'comm', 'sort', 'uniq', 'cut', 'awk', 'sed',
  'jq', 'yq', 'xargs', 'tr',
])

// Git subcommands that mutate state (not safe to auto-approve)
const GIT_MUTATING_SUBCOMMANDS = new Set([
  'push', 'commit', 'merge', 'rebase', 'reset', 'checkout', 'switch',
  'branch', 'tag', 'stash', 'cherry-pick', 'revert', 'am', 'apply',
  'clean', 'rm', 'mv', 'restore', 'bisect', 'pull', 'fetch', 'clone',
  'init', 'submodule', 'worktree', 'gc', 'prune', 'filter-branch',
])

// Claude subcommands that mutate state
const CLAUDE_MUTATING_SUBCOMMANDS = new Set([
  'config', 'login', 'logout',
])

/** Check if a Bash command string is safe (read-only) */
function isSafeBashCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false
  const trimmed = command.trim()
  if (!trimmed) return false

  // Extract the first command (before any chaining operators)
  // Split on ;, &&, ||, | and check each segment
  const segments = trimmed.split(/\s*(?:;|&&|\|\||[|])\s*/)
  for (const segment of segments) {
    const parts = segment.trim().split(/\s+/)
    const cmd = parts[0]
    if (!cmd) continue

    // Handle env prefix patterns like: VAR=val command
    const actualCmd = cmd.includes('=') ? parts[1] : cmd
    if (!actualCmd) continue

    // Strip path prefix (e.g., /usr/bin/git → git)
    const base = actualCmd.split('/').pop() || actualCmd

    if (!SAFE_BASH_COMMANDS.has(base)) return false

    // Extra check for git: only allow read-only subcommands
    if (base === 'git') {
      const subIdx = cmd.includes('=') ? 2 : 1
      const sub = parts[subIdx]
      if (sub && GIT_MUTATING_SUBCOMMANDS.has(sub)) return false
    }

    // Extra check for claude: only allow read-only subcommands
    if (base === 'claude') {
      const subIdx = cmd.includes('=') ? 2 : 1
      const sub = parts[subIdx]
      // claude mcp remove, claude config set, etc.
      if (sub && CLAUDE_MUTATING_SUBCOMMANDS.has(sub)) return false
      // claude mcp remove specifically
      if (sub === 'mcp') {
        const mcpSub = parts[subIdx + 1]
        if (mcpSub && mcpSub !== 'list' && mcpSub !== 'get' && mcpSub !== '--help') return false
      }
    }

    // Extra check for npm/yarn/pnpm/bun: block install/publish/run
    if (['npm', 'yarn', 'pnpm', 'bun'].includes(base)) {
      const subIdx = cmd.includes('=') ? 2 : 1
      const sub = parts[subIdx]
      if (sub && ['install', 'i', 'add', 'remove', 'uninstall', 'publish', 'run', 'exec', 'dlx', 'npx', 'create', 'init', 'link', 'unlink', 'pack', 'deprecate'].includes(sub)) return false
    }

    // Block redirections that write to files
    if (segment.includes('>') && !segment.includes('>/dev/null') && !segment.includes('2>/dev/null') && !segment.includes('2>&1')) return false
  }

  return true
}

// Regex matcher for the hook config — intercept dangerous tools + external MCP tools.
const HOOK_MATCHER = `^(${PERMISSION_REQUIRED_TOOLS.join('|')}|mcp__.*)$`

// Fields in tool_input that should be redacted in logs
const SENSITIVE_FIELD_RE = /token|password|secret|key|auth|credential|api.?key/i

// Exhaustive whitelist of valid decision IDs from permission card options.
// Any decision not in this set is denied (fail-closed).
const VALID_ALLOW_DECISIONS = new Set(['allow', 'allow-session', 'allow-domain'])
const VALID_DECISIONS = new Set([...VALID_ALLOW_DECISIONS, 'deny'])

function log(msg: string): void {
  _log('PermissionServer', msg)
}

/** Extract domain from a URL string, returns null on failure */
function extractDomain(url: unknown): string | null {
  if (typeof url !== 'string') return null
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

/** Build a deny hook response */
function denyResponse(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }
}

/** Build an allow hook response */
function allowResponse(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: reason,
    },
  }
}

export interface HookToolRequest {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode: string
  hook_event_name: string
  tool_name: string
  tool_input: Record<string, unknown>
  tool_use_id: string
}

export interface PermissionDecision {
  decision: 'allow' | 'deny'
  reason?: string
}

export interface PermissionOption {
  id: string
  label: string
  kind: 'allow' | 'deny'
}

interface PendingRequest {
  toolRequest: HookToolRequest
  resolve: (decision: PermissionDecision) => void
  timeout: ReturnType<typeof setTimeout>
  questionId: string
  runToken: string
}

interface RunRegistration {
  tabId: string
  requestId: string
  sessionId: string | null
}

/**
 * PermissionServer: HTTP server for Claude Code PreToolUse hooks.
 *
 * Events:
 *  - 'permission-request' (questionId, toolRequest, tabId, options) — forward to renderer
 */
export class PermissionServer extends EventEmitter {
  private server: ReturnType<typeof createServer> | null = null
  private pendingRequests = new Map<string, PendingRequest>()
  private port: number
  private _actualPort: number | null = null

  /** Per-launch secret — validates that requests come from our hooks */
  private appSecret: string

  /** Per-run tokens → run registration (tabId, requestId, sessionId) */
  private runTokens = new Map<string, RunRegistration>()

  /** Scoped "allow always" keys. Format varies by tool type. */
  private scopedAllows = new Set<string>()

  /** Tracked generated settings files: runToken → filePath */
  private settingsFiles = new Map<string, string>()

  constructor(port = DEFAULT_PORT) {
    super()
    this.port = port
    this.appSecret = randomUUID()
  }

  async start(): Promise<number> {
    if (this.server) {
      log('Server already running')
      return this._actualPort || this.port
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this._handleRequest(req, res))

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          log(`Port ${this.port} in use, trying ${this.port + 1}`)
          this.port++
          this.server!.listen(this.port, '127.0.0.1')
        } else {
          log(`Server error: ${err.message}`)
          reject(err)
        }
      })

      this.server.listen(this.port, '127.0.0.1', () => {
        this._actualPort = this.port
        log(`Permission server listening on 127.0.0.1:${this.port}`)
        resolve(this.port)
      })
    })
  }

  stop(): void {
    // Deny all pending requests
    for (const [qid, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout)
      pending.resolve({ decision: 'deny', reason: 'Server shutting down' })
      this.pendingRequests.delete(qid)
    }

    // Clean up all remaining settings files (best-effort)
    for (const [, filePath] of this.settingsFiles) {
      try { unlinkSync(filePath) } catch {}
    }
    this.settingsFiles.clear()

    if (this.server) {
      this.server.close()
      this.server = null
      log('Permission server stopped')
    }
  }

  getPort(): number | null {
    return this._actualPort
  }

  // ─── Run Registration ───

  /**
   * Register a new run. Returns a unique run token.
   * The run token is embedded in the hook URL for per-run routing.
   */
  registerRun(tabId: string, requestId: string, sessionId: string | null): string {
    const runToken = randomUUID()
    this.runTokens.set(runToken, { tabId, requestId, sessionId })
    log(`Registered run: token=${runToken.substring(0, 8)}… tab=${tabId.substring(0, 8)}…`)
    return runToken
  }

  /**
   * Unregister a run. Denies any pending requests for this run and cleans up its settings file.
   */
  unregisterRun(runToken: string): void {
    const reg = this.runTokens.get(runToken)
    if (!reg) return

    // Deny any pending requests associated with this run
    for (const [qid, pending] of this.pendingRequests) {
      if (pending.runToken === runToken) {
        clearTimeout(pending.timeout)
        pending.resolve({ decision: 'deny', reason: 'Run ended' })
        this.pendingRequests.delete(qid)
      }
    }

    // Clean up settings file for this run
    const filePath = this.settingsFiles.get(runToken)
    if (filePath) {
      try { unlinkSync(filePath) } catch {}
      this.settingsFiles.delete(runToken)
    }

    this.runTokens.delete(runToken)
    log(`Unregistered run: token=${runToken.substring(0, 8)}…`)
  }

  // ─── Permission Response ───

  /**
   * Respond to a pending permission request.
   * decision: 'allow' (once), 'allow-session' (for session), 'allow-domain' (WebFetch domain), 'deny'
   */
  respondToPermission(questionId: string, decision: string, reason?: string): boolean {
    const pending = this.pendingRequests.get(questionId)
    if (!pending) {
      log(`respondToPermission: no pending request for ${questionId}`)
      return false
    }

    clearTimeout(pending.timeout)
    this.pendingRequests.delete(questionId)

    // Fail-closed: reject unknown decision IDs immediately
    if (!VALID_DECISIONS.has(decision)) {
      log(`Unknown decision "${decision}" for [${questionId}] — denying (fail-closed)`)
      pending.resolve({ decision: 'deny', reason: `Unknown decision: ${decision}` })
      return true
    }

    const toolName = pending.toolRequest.tool_name
    const sessionId = pending.toolRequest.session_id

    // Handle scoped "allow always" decisions
    if (decision === 'allow-session') {
      const key = `session:${sessionId}:tool:${toolName}`
      this.scopedAllows.add(key)
      log(`Session-allowed ${toolName} for session ${sessionId.substring(0, 8)}…`)
    } else if (decision === 'allow-domain') {
      const domain = extractDomain(pending.toolRequest.tool_input?.url)
      if (domain) {
        const key = `session:${sessionId}:webfetch:${domain}`
        this.scopedAllows.add(key)
        log(`Domain-allowed ${domain} for session ${sessionId.substring(0, 8)}…`)
      }
    }

    const hookDecision: 'allow' | 'deny' = VALID_ALLOW_DECISIONS.has(decision) ? 'allow' : 'deny'
    if (DEBUG) {
      log(`respondToPermission [${questionId}]: ${decision} (tool=${toolName})`)
    } else {
      log(`Permission: ${toolName} → ${hookDecision}`)
    }
    pending.resolve({ decision: hookDecision, reason })
    return true
  }

  // ─── Dynamic Options ───

  /**
   * Get permission card options for a given tool + input.
   * WebFetch gets domain-scoped options; all others get session-scoped.
   */
  getOptionsForTool(toolName: string, toolInput?: Record<string, unknown>): PermissionOption[] {
    // Bash commands are too diverse for session-scoped blanket allow —
    // each command should be individually reviewed.
    if (toolName === 'Bash') {
      return [
        { id: 'allow', label: 'Allow Once', kind: 'allow' },
        { id: 'deny', label: 'Deny', kind: 'deny' },
      ]
    }

    // Edit, Write, MultiEdit, mcp__* — session-scoped allow is safe
    return [
      { id: 'allow', label: 'Allow Once', kind: 'allow' },
      { id: 'allow-session', label: 'Allow for Session', kind: 'allow' },
      { id: 'deny', label: 'Deny', kind: 'deny' },
    ]
  }

  // ─── Settings File Generation ───

  /**
   * Generate a per-run settings file with the PreToolUse HTTP hook.
   * The URL includes both appSecret and runToken for authentication.
   */
  generateSettingsFile(runToken: string): string {
    const port = this._actualPort || this.port
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: HOOK_MATCHER,
            hooks: [
              {
                type: 'http',
                url: `http://127.0.0.1:${port}/hook/pre-tool-use/${this.appSecret}/${runToken}`,
                timeout: 300,
              },
            ],
          },
        ],
      },
    }

    const dir = join(tmpdir(), 'coda-hook-config')
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }) } catch {}

    const filePath = join(dir, `coda-hook-${runToken}.json`)
    writeFileSync(filePath, JSON.stringify(settings, null, 2), { mode: 0o600 })
    this.settingsFiles.set(runToken, filePath)
    if (DEBUG) {
      log(`Generated settings file: ${filePath}`)
    }
    return filePath
  }

  // ─── HTTP Request Handling ───

  private async _handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // POST only — deny everything else
    if (req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(denyResponse('Not found')))
      return
    }

    // Parse URL: /hook/pre-tool-use/<appSecret>/<runToken>
    const segments = (req.url || '').split('/').filter(Boolean)
    if (segments.length !== 4 || segments[0] !== 'hook' || segments[1] !== 'pre-tool-use') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(denyResponse('Invalid path')))
      return
    }

    const urlSecret = segments[2]
    const urlToken = segments[3]

    // Validate app secret
    if (urlSecret !== this.appSecret) {
      log('Rejected request: invalid app secret')
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(denyResponse('Invalid credentials')))
      return
    }

    // Validate run token
    const registration = this.runTokens.get(urlToken)
    if (!registration) {
      log(`Rejected request: unknown run token ${urlToken.substring(0, 8)}…`)
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(denyResponse('Unknown run')))
      return
    }

    // Read body with size limit
    let body = ''
    let bodySize = 0
    for await (const chunk of req) {
      bodySize += (chunk as Buffer).length
      if (bodySize > MAX_BODY_SIZE) {
        log('Rejected request: body too large')
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(denyResponse('Request too large')))
        return
      }
      body += chunk
    }

    // Parse JSON
    let toolRequest: HookToolRequest
    try {
      toolRequest = JSON.parse(body) as HookToolRequest
    } catch {
      log('Rejected request: invalid JSON')
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(denyResponse('Invalid JSON')))
      return
    }

    // Validate required fields
    if (!toolRequest.tool_name || !toolRequest.session_id || !toolRequest.hook_event_name) {
      log('Rejected request: missing required fields')
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(denyResponse('Missing required fields')))
      return
    }

    // Validate hook event name
    if (toolRequest.hook_event_name !== 'PreToolUse') {
      log(`Rejected request: unexpected hook event ${toolRequest.hook_event_name}`)
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(denyResponse('Unexpected hook event')))
      return
    }

    if (DEBUG) {
      log(`Hook request: tool=${toolRequest.tool_name} id=${toolRequest.tool_use_id} session=${toolRequest.session_id} tab=${registration.tabId.substring(0, 8)}…`)
    } else {
      log(`Hook: ${toolRequest.tool_name} → tab=${registration.tabId.substring(0, 8)}…`)
    }

    // Check scoped allows
    const sessionId = toolRequest.session_id
    const toolName = toolRequest.tool_name

    // Check session-scoped allow
    if (this.scopedAllows.has(`session:${sessionId}:tool:${toolName}`)) {
      if (DEBUG) log(`Auto-allowing ${toolName} (session-allowed)`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(allowResponse('Allowed for session by user')))
      return
    }

    // Check domain-scoped allow (WebFetch)
    if (toolName === 'WebFetch') {
      const domain = extractDomain(toolRequest.tool_input?.url)
      if (domain && this.scopedAllows.has(`session:${sessionId}:webfetch:${domain}`)) {
        if (DEBUG) log(`Auto-allowing WebFetch to ${domain} (domain-allowed)`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(allowResponse(`Domain ${domain} allowed by user`)))
        return
      }
    }

    // Auto-approve safe (read-only) Bash commands without prompting
    if (toolName === 'Bash' && isSafeBashCommand(toolRequest.tool_input?.command)) {
      if (DEBUG) log(`Auto-allowing safe Bash: ${String(toolRequest.tool_input?.command).substring(0, 80)}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(allowResponse('Safe read-only command')))
      return
    }

    // Auto-approve writes to ~/.claude/plans/ — Claude's internal planning directory.
    // Blocking these breaks plan mode, which is a core agent mechanic, not a user action.
    if ((toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit')) {
      const filePath = typeof toolRequest.tool_input?.file_path === 'string'
        ? toolRequest.tool_input.file_path
        : ''
      const plansDir = join(homedir(), '.claude', 'plans')
      if (filePath.startsWith(plansDir + '/')) {
        if (DEBUG) log(`Auto-allowing ${toolName} to plans dir: ${filePath}`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(allowResponse('Claude internal plans directory')))
        return
      }
    }

    // Generate question ID and wait for user decision
    const questionId = `hook-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`

    const decision = await new Promise<PermissionDecision>((resolve) => {
      const timeout = setTimeout(() => {
        log(`Permission timeout [${questionId}] — auto-denying`)
        this.pendingRequests.delete(questionId)
        resolve({ decision: 'deny', reason: 'Permission timed out after 5 minutes' })
      }, PERMISSION_TIMEOUT_MS)

      this.pendingRequests.set(questionId, {
        toolRequest,
        resolve,
        timeout,
        questionId,
        runToken: urlToken,
      })

      // Get tool-specific options for the permission card
      const options = this.getOptionsForTool(toolName, toolRequest.tool_input)

      // Emit with direct tabId from registration — no session_id lookup needed
      this.emit('permission-request', questionId, toolRequest, registration.tabId, options)
    })

    // Return structured hook response
    const hookResponse = decision.decision === 'allow'
      ? allowResponse(decision.reason || 'Approved by user')
      : denyResponse(decision.reason || 'Denied by user')

    if (DEBUG) {
      log(`Hook response [${questionId}]: ${decision.decision}`)
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(hookResponse))
  }
}

/** Mask sensitive fields in tool_input (recursive). Exported for defense-in-depth use by control-plane. */
export function maskSensitiveFields(input: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_FIELD_RE.test(key)) {
      masked[key] = '***'
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      masked[key] = maskSensitiveFields(value as Record<string, unknown>)
    } else if (Array.isArray(value)) {
      masked[key] = value.map(item =>
        item !== null && typeof item === 'object' && !Array.isArray(item)
          ? maskSensitiveFields(item as Record<string, unknown>)
          : item
      )
    } else {
      masked[key] = value
    }
  }
  return masked
}
