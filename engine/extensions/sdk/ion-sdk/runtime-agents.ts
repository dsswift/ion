// Ion Extension SDK -- agent-to-tool registration helpers.
// Extracted from runtime.ts to keep it under the 600-line cap.
// Discovers agent definitions from agents/*.md and registers dispatch tools.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { log } from './runtime-log'
import type {
  DiscoveredAgent,
  IonContext,
  RegisterAgentToolsOpts,
  ToolDef,
} from './types'

/**
 * Well-known frontmatter keys consumed as typed fields on
 * {@link DiscoveredAgent}. Any other key encountered in the YAML frontmatter
 * lands in `DiscoveredAgent.meta` as an arbitrary string. Mirrors the Go-side
 * `engine/internal/agentdiscovery/frontmatter.go` switch so the SDK helper's
 * metadata semantics match what the engine's own `discoverAgents()` walk
 * populates.
 */
const WELL_KNOWN_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
  'name', 'parent', 'description', 'model', 'tools',
])

/** A parsed frontmatter block plus the body that follows it. */
export interface SplitFrontmatter {
  /** Flat key/value map from the YAML frontmatter. Inline arrays
   *  (`[a, b]`) are returned as `string[]`; bare values as `string`. */
  fields: Record<string, string | string[] | undefined>
  /** The persona text below the closing `---` delimiter, with leading
   *  whitespace trimmed. Empty when there is no body, or when the file
   *  contains only a frontmatter block. */
  body: string
}

/**
 * Parse YAML-style frontmatter from a markdown file's content. Returns just
 * the flat key/value map. Kept exported for backwards compatibility; new
 * callers should prefer {@link splitFrontmatter} so they can also consume
 * the body text below the closing delimiter.
 */
export function parseFrontmatter(content: string): Record<string, string | string[] | undefined> {
  return splitFrontmatter(content).fields
}

/**
 * Split a markdown file into its YAML frontmatter and body. The regex is
 * anchored to the start of the file and matches non-greedily, so `---`
 * lines that appear inside the body (e.g. horizontal rules) are not
 * mistaken for a closing delimiter — only the first delimiter pair counts.
 *
 * Returns `{ fields: {}, body: <full content> }` when no frontmatter
 * delimiter is present, so callers can treat any `.md` file as a
 * "body-only" agent (with the agent name falling back to the filename
 * stem at the caller's discretion).
 */
export function splitFrontmatter(content: string): SplitFrontmatter {
  // Match `---\n…\n---\n?` from the start of the file. The `\r?\n`
  // discipline mirrors the original regex so CRLF files parse the same
  // as LF files.
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) {
    // No frontmatter fence — treat the entire content as the body.
    return { fields: {}, body: content.replace(/^\s+/, '') }
  }
  const fields: Record<string, string | string[] | undefined> = {}
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim()
    const val = line.slice(colon + 1).trim()
    // Handle YAML inline arrays: [a, b, c]
    if (val.startsWith('[') && val.endsWith(']')) {
      fields[key] = val.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean)
    } else {
      fields[key] = val
    }
  }
  // Body = everything after the matched delimiter block, leading-trimmed
  // so a persona that begins with a blank line still starts at its first
  // real paragraph. We intentionally do NOT trim trailing whitespace —
  // some personas terminate with a deliberate blank line so the engine's
  // system-prompt concatenation lands cleanly when more text is appended.
  const body = content.slice(match[0].length).replace(/^\s+/, '')
  return { fields, body }
}

/** Discover agents from the extension's agents/ directory and register
 *  a dispatch tool per agent. Runs synchronously at init time. */
export function doRegisterAgentTools(
  tools: Map<string, ToolDef>,
  opts?: RegisterAgentToolsOpts,
): void {
  const agentsDir = join(process.cwd(), 'agents')
  if (!existsSync(agentsDir)) return

  const files = readdirSync(agentsDir).filter(f => f.endsWith('.md'))
  for (const file of files) {
    const content = readFileSync(join(agentsDir, file), 'utf-8')
    const { fields: fm, body } = splitFrontmatter(content)
    const name = (fm.name as string) || file.replace(/\.md$/, '')
    const parent = fm.parent as string | undefined
    const description = fm.description as string | undefined

    // Collect non-well-known frontmatter keys into `meta`. Mirrors the
    // Go-side AgentDef.Meta pattern (engine/internal/agentdiscovery/
    // frontmatter.go:48-62) so the SDK helper's view of an agent matches
    // what discoverAgents() returns from the engine-side walk. List-valued
    // unknowns are re-joined with ", " to keep the map shape
    // Record<string,string> — a typed-array variant is an additive future
    // change, not required for this fix.
    const meta: Record<string, string> = {}
    for (const [key, val] of Object.entries(fm)) {
      if (WELL_KNOWN_FRONTMATTER_KEYS.has(key)) continue
      if (val == null) continue
      meta[key] = Array.isArray(val) ? val.join(', ') : String(val)
    }

    const agent: DiscoveredAgent = {
      name,
      path: join(agentsDir, file),
      source: 'extension',
      parent,
      description,
      model: fm.model as string | undefined,
      tools: fm.tools as string[] | undefined,
      systemPrompt: body || undefined,
      meta: Object.keys(meta).length > 0 ? meta : undefined,
    }

    // Default filter: exclude root agents (no parent) — they ARE the
    // conversation, not dispatch targets.
    const filter = opts?.filter ?? ((a: DiscoveredAgent) => !!a.parent)
    if (!filter(agent)) continue

    const toolName = opts?.toolName
      ? opts.toolName(agent)
      : `dispatch_${name.replace(/-/g, '_')}`
    const toolDesc = opts?.description
      ? opts.description(agent)
      : description
        ? `Dispatch the ${description} specialist`
        : `Dispatch the ${name} specialist`

    // Capture the persona + model on the closure (not just the name), so
    // the dispatch tool delivers a fully-configured child session.
    // Before this fix the helper passed only `{ name, task }`, silently
    // dropping the systemPrompt / model parsed above — the dispatched
    // specialist then ran as an unconfigured generic LLM. See plan:
    // "Fix extension agent dispatches".
    const dispatchSystemPrompt = agent.systemPrompt
    const dispatchModel = agent.model
    const metaKeyCount = Object.keys(meta).length

    // INFO at wire-time: fires once per agent file during extension
    // init. The systemPrompt length + meta key count are the load-
    // bearing assertions — if either is zero on an agent that has a
    // populated .md body, the helper silently dropped data.
    log.info('registerAgentTools: wired dispatch tool', {
      agent: name,
      toolName,
      model: dispatchModel ?? '',
      sysPromptLen: dispatchSystemPrompt?.length ?? 0,
      metaKeys: metaKeyCount,
      parent: parent ?? '',
    })

    tools.set(toolName, {
      name: toolName,
      description: toolDesc,
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'The task for the specialist to perform',
          },
        },
        required: ['task'],
      },
      execute: async (params: any, ctx: IonContext) => {
        const taskStr = typeof params?.task === 'string' ? params.task : ''
        // DEBUG per dispatch: high-volume callsite; logging at INFO would
        // noise up dispatch-heavy sessions. The wire-time log above is
        // the once-per-agent INFO record; this is the per-call trace.
        log.debug('registerAgentTools: dispatching', {
          agent: name,
          model: dispatchModel ?? '',
          sysPromptLen: dispatchSystemPrompt?.length ?? 0,
          taskLen: taskStr.length,
        })
        const result = await ctx.dispatchAgent({
          name,
          task: taskStr,
          // Pass `undefined` cleanly when missing — both fields are
          // optional on DispatchAgentOpts. The engine's dispatch path
          // already falls back to the session default model when
          // `model` is empty, and skips the AppendSystemPrompt wiring
          // when `systemPrompt` is empty.
          systemPrompt: dispatchSystemPrompt,
          model: dispatchModel,
        })
        return { content: result.output, isError: result.exitCode !== 0 }
      },
    })
  }
}
