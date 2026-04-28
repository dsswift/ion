// ion-meta -- extension authoring assistant.
// SDK-first extension that demonstrates the createIon() pattern: hook
// registration, tool registration. The engine auto-bundles ../sdk/ion-sdk.ts
// at transpile time.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createIon, log } from '../sdk/ion-sdk'

const ion = createIon()

// --- Hook catalog ---

const hookCatalog: Record<string, string[]> = {
  lifecycle: [
    'session_start', 'session_end', 'before_prompt', 'turn_start', 'turn_end',
    'message_start', 'message_end', 'tool_start', 'tool_end', 'tool_call',
    'on_error', 'agent_start', 'agent_end',
  ],
  session: [
    'session_before_compact', 'session_compact', 'session_before_fork',
    'session_fork', 'session_before_switch',
  ],
  'pre-action': [
    'before_agent_start', 'before_provider_request',
  ],
  content: [
    'context', 'message_update', 'tool_result', 'input', 'model_select',
    'user_bash', 'plan_mode_prompt',
  ],
  'per-tool-call': [
    'bash_tool_call', 'read_tool_call', 'write_tool_call', 'edit_tool_call',
    'grep_tool_call', 'glob_tool_call', 'agent_tool_call',
  ],
  'per-tool-result': [
    'bash_tool_result', 'read_tool_result', 'write_tool_result', 'edit_tool_result',
    'grep_tool_result', 'glob_tool_result', 'agent_tool_result',
  ],
  'context-discovery': [
    'context_discover', 'context_load', 'instruction_load',
  ],
  permission: [
    'permission_request', 'permission_denied', 'permission_classify',
  ],
  file: [
    'file_changed',
  ],
  task: [
    'task_created', 'task_completed',
  ],
  elicitation: [
    'elicitation_request', 'elicitation_result',
  ],
  'context-injection': [
    'context_inject',
  ],
  capability: [
    'capability_discover', 'capability_match', 'capability_invoke',
  ],
  'extension-lifecycle': [
    'extension_respawned', 'turn_aborted', 'peer_extension_died',
    'peer_extension_respawned',
  ],
}

// --- Tool handlers ---

function handleScaffold(params: { name: string; type: 'extension' | 'agent' | 'skill' }) {
  const { name, type } = params

  switch (type) {
    case 'extension':
      return {
        files: ['index.ts', 'README.md', 'agents/orchestrator.md'],
        description: 'Extension directory with entry point, README, and root agent',
      }
    case 'agent':
      return {
        files: [`${name}.md`],
        template: [
          '---',
          `name: ${name}`,
          'description: <description>',
          'model: claude-sonnet-4-6',
          'tools: [Read, Write]',
          '---',
          '',
          'You are...',
        ].join('\n'),
      }
    case 'skill':
      return {
        files: [`${name}.md`],
        template: [
          '---',
          `name: ${name}`,
          'description: <description>',
          '---',
          '',
          'Skill body...',
        ].join('\n'),
      }
    default:
      return { error: `Unknown scaffold type: ${type}` }
  }
}

function handleValidateAgent(params: { content: string }) {
  const { content } = params
  const errors: string[] = []
  const warnings: string[] = []

  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!fmMatch) {
    return { valid: false, errors: ['No frontmatter found (expected --- fenced block)'], warnings }
  }

  const frontmatter = fmMatch[1]
  const fields: Record<string, string> = {}

  for (const line of frontmatter.split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    fields[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim()
  }

  if (!fields['name']) errors.push('Missing required field: name')
  if (!fields['description']) errors.push('Missing required field: description')
  if (!fields['model']) warnings.push('No model specified (will use session default)')
  if (!fields['tools']) warnings.push('No tools specified (agent will have no tool access)')

  return { valid: errors.length === 0, errors, warnings }
}

function handleListHooks(params: { category?: string }) {
  if (params.category) {
    const key = params.category.toLowerCase()
    if (hookCatalog[key]) return { [key]: hookCatalog[key] }
    return {
      error: `Unknown category: ${params.category}. Valid categories: ${Object.keys(hookCatalog).join(', ')}`,
    }
  }
  return hookCatalog
}

// --- Orchestrator persona ---

// Strip leading YAML frontmatter (--- ... ---) from an agent .md file.
function stripFrontmatter(text: string): string {
  const match = text.match(/^---\s*\n[\s\S]*?\n---\s*\n?/)
  return match ? text.slice(match[0].length) : text
}

let personaCache: string | null = null

function loadPersona(extensionDir: string): string {
  if (personaCache !== null) return personaCache
  try {
    const raw = readFileSync(join(extensionDir, 'agents', 'orchestrator.md'), 'utf8')
    personaCache = buildPersona(stripFrontmatter(raw).trim())
  } catch (err) {
    log.warn(`ion-meta: failed to load orchestrator.md: ${(err as Error).message}`)
    personaCache = buildPersona('')
  }
  return personaCache
}

function buildPersona(orchestratorBody: string): string {
  const header =
    'This session is dedicated to building Ion Engine extensions, agents, skills, and hooks.\n' +
    'Treat the SDK shape, hook catalog, and CLI verbs below as ground truth. Do not invent symbols, package names, methods, or commands. If something is not listed here, say so rather than guess.'
  const sdk =
    'SDK shape (canonical — use this exact form for all extension code samples):\n' +
    '```ts\n' +
    "import { createIon, log } from '../sdk/ion-sdk'\n" +
    '\n' +
    'const ion = createIon()\n' +
    '\n' +
    "ion.on('session_start', () => log.info('extension active'))\n" +
    "ion.on('tool_end', (ctx, info) => { /* info shape depends on the hook */ })\n" +
    '\n' +
    "ion.registerTool({ name: 'my_tool', description: '...', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: 'ok' }) })\n" +
    '```\n' +
    'There is no `Extension` class, no `@ion/sdk` package, no `registerHook` method, no `ext.start()`. The engine auto-bundles the SDK at transpile time — extensions never `npm install` it.\n' +
    '\n' +
    'IonContext fields available in every hook/tool/command handler:\n' +
    '- `ctx.sessionKey: string` — engine session id; use as a Map key for per-session state.\n' +
    '- `ctx.cwd: string` — working directory.\n' +
    '- `ctx.model: { id, contextWindow } | null` — active model.\n' +
    '- `ctx.config: ExtensionConfig` — passed during init.\n' +
    '- Methods: `emit`, `sendMessage`, `callTool(name, input)`, `sendPrompt(text, opts?)`, `dispatchAgent`, `discoverAgents`, `registerAgentSpec`, `elicit`, `sandboxWrap`, process lifecycle helpers.\n' +
    '\n' +
    '`ctx.callTool` dispatches a registered tool (built-in, MCP, or extension-registered) without an LLM round trip — useful for slash commands like `/recall <q>` calling a `memory_recall` tool. Subject to the session permission policy. Per-tool hooks (`bash_tool_call`, etc.) and `permission_request` do NOT fire on these calls.\n' +
    '\n' +
    '`ctx.sendPrompt(text, opts?)` queues a fresh prompt on the session. Use from a slash command to drive an LLM turn (e.g. `/cloud <msg>` forcing a remote model), or from `session_start` to prime the agent. Recursion hazard: calling from `before_prompt` triggers `before_prompt` again — guard with a per-session in-flight flag keyed on `ctx.sessionKey`.\n' +
    '\n' +
    '`ctx.emit(event)` accepts the five engine-recognised types (`engine_agent_state`, `engine_status`, `engine_working_message`, `engine_notify`, `engine_harness_message`) plus any custom `{ type: string, ...fields }` shape. Custom types pass through the engine and desktop bridge verbatim; pick a unique prefix (e.g. `myharness_*`) to avoid collisions.'
  const catalog =
    'Canonical hook catalog (do not rename or invent):\n' +
    Object.entries(hookCatalog)
      .map(([cat, names]) => `- ${cat}: ${names.join(', ')}`)
      .join('\n')
  const cli =
    'Engine CLI verbs (the only ones that exist): serve, start, prompt, attach, status, stop, shutdown, record, rpc, version.\n' +
    'Loading an extension: place it at `~/.ion/extensions/<name>/index.ts` and reference it via `--extension ~/.ion/extensions/<name>/index.ts` on `ion prompt` or `ion start`. There is no `ion ext load` command.\n' +
    '\n' +
    'Extension directory layout:\n' +
    '- `index.ts` (or extension.ts / index.js / main) — entry point.\n' +
    '- `extension.json` (optional) — manifest. Fields: `name`, `external` (string[] for native deps the bundler should leave external), `engineVersion`. Unknown top-level keys are rejected.\n' +
    '- `package.json` (optional) — npm deps. Engine auto-runs `npm install --omit=dev` before transpile (idempotent).\n' +
    '- `agents/*.md` (optional) — bundled agent definitions.\n' +
    '- `.ion-build/` — engine-generated build artifacts; gitignored automatically.\n' +
    'TypeScript output: ESM (.mjs), Node 20 target. Top-level `await` works. Native modules go in `extension.json` `external` and are required at runtime via `NODE_PATH=<extDir>/node_modules`.'
  const tools =
    'Available tools:\n' +
    '- ion_scaffold: generate scaffold structure for an extension, agent, or skill.\n' +
    '- ion_validate_agent: validate agent markdown frontmatter.\n' +
    '- ion_list_hooks: list engine hooks, optionally filtered by category. Call only when the user wants the catalog itself returned; otherwise reuse the embedded catalog above.\n' +
    '- Agent: dispatch a specialist sub-agent for detailed work.\n' +
    'Delegate detailed work to the specialist sub-agents named in the orchestrator role below.'
  return [header, orchestratorBody, sdk, catalog, cli, tools].filter(Boolean).join('\n\n')
}

// --- Hook registration ---

ion.on('session_start', () => {
  log.info('ion-meta extension active')
})

ion.on('before_prompt', (ctx, _prompt) => ({
  systemPrompt: loadPersona(ctx.config.extensionDir),
}))

// --- Tool registration ---

ion.registerTool({
  name: 'ion_scaffold',
  description: 'Generate scaffold structure for an Ion extension, agent, or skill',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name of the extension, agent, or skill' },
      type: {
        type: 'string',
        enum: ['extension', 'agent', 'skill'],
        description: 'Type of scaffold to generate',
      },
    },
    required: ['name', 'type'],
  },
  execute: async (params) => ({
    content: JSON.stringify(handleScaffold(params), null, 2),
  }),
})

ion.registerTool({
  name: 'ion_validate_agent',
  description: 'Validate agent markdown frontmatter for required and optional fields',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'Full markdown content of the agent file' },
    },
    required: ['content'],
  },
  execute: async (params) => ({
    content: JSON.stringify(handleValidateAgent(params), null, 2),
  }),
})

ion.registerTool({
  name: 'ion_list_hooks',
  description: 'List available Ion engine hooks, optionally filtered by category',
  parameters: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        description:
          'Filter by category (lifecycle, session, pre-action, content, per-tool-call, per-tool-result, context-discovery, permission, file, task, elicitation, context-injection, capability, extension-lifecycle)',
      },
    },
  },
  execute: async (params) => ({
    content: JSON.stringify(handleListHooks(params), null, 2),
  }),
})

