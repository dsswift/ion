// Ion Extension SDK -- runtime.
// JSON-RPC 2.0 plumbing over stdin/stdout, hook/tool/command dispatch,
// context builder, console redirect, native logger, and the public
// createIon() factory. Pure types live in ./types.ts.

import { createInterface } from 'node:readline'
import { format as utilFormat } from 'node:util'

import type {
  AgentSpec,
  CommandDef,
  DiscoverAgentsOpts,
  DiscoveredAgent,
  DispatchAgentOpts,
  DispatchAgentResult,
  ElicitOptions,
  ElicitResult,
  EngineEvent,
  ExtensionConfig,
  IonContext,
  IonSDK,
  ProcessInfo,
  SandboxProfile,
  SandboxWrapResult,
  SendPromptOpts,
  ToolDef,
} from './types'

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const hooks = new Map<string, (ctx: IonContext, payload?: any) => any>()
const tools = new Map<string, ToolDef>()
const commands = new Map<string, CommandDef>()
let initConfig: ExtensionConfig | null = null

// Non-null while a hook handler is executing. Events pushed here get bundled
// into the hook response rather than sent as standalone notifications.
let activeEvents: EngineEvent[] | null = null

// ---------------------------------------------------------------------------
// Logging (native API + console redirect)
// ---------------------------------------------------------------------------

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

function emitLog(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  process.stdout.write(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'log',
      params: { level, message, fields: fields ?? {} },
    }) + '\n',
  )
}

/**
 * Native logging API. All output goes through the engine's JSON-RPC log
 * channel and lands in `~/.ion/engine.log` tagged with the extension name.
 * Use this instead of `console.log` -- raw stdout writes corrupt the
 * JSON-RPC frame stream and break the engine's protocol parser.
 *
 * @example
 * ```ts
 * import { log } from '../sdk/ion-sdk'
 * log.info('extension started', { version: '1.0' })
 * log.warn('missing optional config', { key: 'mcpConfigPath' })
 * log.error('dispatch failed', { agent: 'chief-admin', err: String(err) })
 * ```
 */
export const log = {
  debug: (message: string, fields?: Record<string, unknown>) => emitLog('debug', message, fields),
  info: (message: string, fields?: Record<string, unknown>) => emitLog('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => emitLog('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => emitLog('error', message, fields),
}

let consoleRedirectInstalled = false

/**
 * Replace `console.{log,info,warn,error,debug}` with calls to the SDK
 * logger so accidental prints (including from transitive node_modules
 * dependencies) cannot corrupt the JSON-RPC stdout frame stream. The
 * redirected message is prefixed `stray console.<level>:` so the
 * extension author can find and replace the call with the native API.
 */
function installConsoleRedirect(): void {
  if (consoleRedirectInstalled) return
  consoleRedirectInstalled = true
  const formatArgs = (args: unknown[]) => utilFormat(...args)
  console.log = (...args: unknown[]) => emitLog('warn', `stray console.log: ${formatArgs(args)}`)
  console.info = (...args: unknown[]) => emitLog('info', `stray console.info: ${formatArgs(args)}`)
  console.warn = (...args: unknown[]) => emitLog('warn', `stray console.warn: ${formatArgs(args)}`)
  console.error = (...args: unknown[]) => emitLog('error', `stray console.error: ${formatArgs(args)}`)
  console.debug = (...args: unknown[]) => emitLog('debug', `stray console.debug: ${formatArgs(args)}`)
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

function respond(id: number, result: any): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function respondError(id: number, code: number, message: string, data?: Record<string, any>): void {
  const err: Record<string, any> = { code, message }
  if (data) err.data = data
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: err }) + '\n')
}

function notify(method: string, params: any): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
}

let nextRequestId = 100000
const pendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
const notificationHandlers = new Map<string, (params: any) => void>()

function request(method: string, params: any): Promise<any> {
  const id = nextRequestId++
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject })
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
    )
  })
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

const emptyConfig: ExtensionConfig = {
  extensionDir: '',
  model: '',
  workingDirectory: '',
}

function buildContext(ctxData: any): IonContext {
  return {
    sessionKey: typeof ctxData?.sessionKey === 'string' ? ctxData.sessionKey : '',
    cwd: ctxData?.cwd || initConfig?.workingDirectory || '',
    model: ctxData?.model || null,
    config: ctxData?.config || initConfig || emptyConfig,
    emit(event: EngineEvent) {
      if (activeEvents) {
        activeEvents.push(event)
      } else {
        notify('ext/emit', event)
      }
    },
    sendMessage(text: string) {
      notify('ext/send_message', { text })
    },
    async registerProcess(name: string, pid: number, task: string) {
      await request('ext/register_process', { name, pid, task })
    },
    async deregisterProcess(name: string) {
      await request('ext/deregister_process', { name })
    },
    async listProcesses(): Promise<ProcessInfo[]> {
      const result = await request('ext/list_processes', {})
      return result?.processes || []
    },
    async terminateProcess(name: string) {
      await request('ext/terminate_process', { name })
    },
    async cleanStaleProcesses(): Promise<number> {
      const result = await request('ext/clean_stale_processes', {})
      return result?.cleaned || 0
    },
    async suppressTool(name: string): Promise<void> {
      await request('ext/suppress_tool', { name })
    },
    async callTool(name: string, input: Record<string, unknown>) {
      const result = await request('ext/call_tool', { name, input: input || {} })
      return {
        content: typeof result?.content === 'string' ? result.content : '',
        isError: !!result?.isError,
      }
    },
    async sendPrompt(text: string, opts?: SendPromptOpts): Promise<void> {
      await request('ext/send_prompt', { text, model: opts?.model || '' })
    },
    async dispatchAgent(opts: DispatchAgentOpts): Promise<DispatchAgentResult> {
      const { onEvent, ...rpcOpts } = opts
      if (onEvent) {
        notificationHandlers.set('dispatch_event', onEvent)
      }
      try {
        return await request('ext/dispatch_agent', rpcOpts)
      } finally {
        notificationHandlers.delete('dispatch_event')
      }
    },
    async discoverAgents(opts?: DiscoverAgentsOpts): Promise<DiscoveredAgent[]> {
      const result = await request('ext/discover_agents', opts || {})
      return result?.agents || []
    },
    async sandboxWrap(command: string, profile?: SandboxProfile): Promise<SandboxWrapResult> {
      const result = await request('ext/sandbox_wrap', { command, ...(profile || {}) })
      return { wrapped: result?.wrapped ?? command, platform: result?.platform ?? '' }
    },
    async registerAgentSpec(spec: AgentSpec): Promise<void> {
      await request('ext/register_agent_spec', spec)
    },
    async deregisterAgentSpec(name: string): Promise<void> {
      await request('ext/deregister_agent_spec', { name })
    },
    async elicit(opts: ElicitOptions): Promise<ElicitResult> {
      const result = await request('ext/elicit', opts || {})
      return {
        response: result?.response,
        cancelled: !!result?.cancelled,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Request dispatcher
// ---------------------------------------------------------------------------

async function handleRequest(
  id: number,
  method: string,
  params: any,
): Promise<void> {
  try {
    // -- Init handshake -----------------------------------------------------
    if (method === 'init') {
      initConfig = params || emptyConfig
      respond(id, {
        tools: Array.from(tools.values()).map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
        commands: Object.fromEntries(
          Array.from(commands.entries()).map(([name, def]) => [
            name,
            { description: def.description },
          ]),
        ),
      })
      return
    }

    // -- Hook calls ---------------------------------------------------------
    if (method.startsWith('hook/')) {
      const hookName = method.slice(5)
      const handler = hooks.get(hookName)
      if (!handler) {
        respond(id, null)
        return
      }

      const ctxData = params?._ctx
      const payload = { ...params }
      delete payload._ctx

      // Use a local array to collect events. Save/restore the global so
      // reentrant hook calls (possible when handlers await) don't clobber.
      const savedEvents = activeEvents
      const localEvents: EngineEvent[] = []
      activeEvents = localEvents
      const ctx = buildContext(ctxData)
      const result = await handler(
        ctx,
        Object.keys(payload).length > 0 ? payload : undefined,
      )
      activeEvents = savedEvents

      // Wrap the handler return value with any accumulated events.
      if (localEvents.length > 0) {
        if (result && typeof result === 'object') {
          respond(id, { ...result, events: localEvents })
        } else if (result != null) {
          respond(id, { value: result, events: localEvents })
        } else {
          respond(id, { events: localEvents })
        }
      } else {
        respond(id, result ?? null)
      }
      return
    }

    // -- Tool calls ---------------------------------------------------------
    if (method.startsWith('tool/')) {
      const toolName = method.slice(5)
      const tool = tools.get(toolName)
      if (!tool) {
        respondError(id, -32601, `Tool not found: ${toolName}`)
        return
      }
      const ctx = buildContext(params?._ctx)
      const toolParams = { ...params }
      delete toolParams._ctx
      const result = await tool.execute(toolParams, ctx)
      respond(id, result)
      return
    }

    // -- Command calls ------------------------------------------------------
    if (method.startsWith('command/')) {
      const cmdName = method.slice(8)
      const cmd = commands.get(cmdName)
      if (!cmd) {
        respondError(id, -32601, `Command not found: ${cmdName}`)
        return
      }
      const ctx = buildContext(params?._ctx)
      await cmd.execute(params?.args || '', ctx)
      respond(id, null)
      return
    }

    respondError(id, -32601, `Method not found: ${method}`)
  } catch (err: any) {
    respondError(id, -32603, err?.message || String(err), {
      stack: err?.stack,
      type: err?.constructor?.name,
    })
  }
}

// ---------------------------------------------------------------------------
// Stdin listener (NDJSON line protocol)
// ---------------------------------------------------------------------------

function startListening(): void {
  const rl = createInterface({ input: process.stdin, terminal: false })

  rl.on('line', (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      const msg = JSON.parse(trimmed)
      if (msg.id !== undefined && msg.method) {
        // Incoming request from engine (fire-and-forget; reentrancy guarded
        // by per-call activeEvents save/restore in handleRequest)
        handleRequest(msg.id, msg.method, msg.params).catch(() => {})
      } else if (msg.id !== undefined && !msg.method) {
        // Response to an outgoing request
        const pending = pendingRequests.get(msg.id)
        if (pending) {
          pendingRequests.delete(msg.id)
          if (msg.error) {
            pending.reject(new Error(msg.error.message || 'RPC error'))
          } else {
            pending.resolve(msg.result)
          }
        }
      } else if (msg.method && msg.id === undefined) {
        // JSON-RPC notification from engine (no id).
        // Suspend activeEvents so any ctx.emit() calls from the notification
        // handler go through notify() directly rather than pushing to a hook
        // handler's event batch.
        const handler = notificationHandlers.get(msg.method)
        if (handler) {
          const saved = activeEvents
          activeEvents = null
          try { handler(msg.params) } finally { activeEvents = saved }
        }
      }
    } catch {
      // Ignore malformed input
    }
  })
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create an Ion SDK instance. Call this once at the top of your extension
 * entrypoint, then register hooks, tools, and commands on the returned object.
 * The SDK begins listening for engine requests on the next tick, giving your
 * registration code time to run synchronously first.
 */
export function createIon(): IonSDK {
  // Guardrail: catch any stray console.* calls (from extension code or
  // transitive node_modules) before they reach raw stdout and corrupt the
  // JSON-RPC frame stream. The redirect routes them through the same
  // `log` notification the native API uses.
  installConsoleRedirect()

  process.nextTick(() => startListening())

  return {
    on(hook, handler) {
      hooks.set(hook, handler)
    },
    registerTool(def) {
      tools.set(def.name, def)
    },
    registerCommand(name, def) {
      commands.set(name, def)
    },
  }
}
