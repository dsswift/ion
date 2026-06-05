import { readFile, access } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import yaml from 'js-yaml'
import { log as _log } from '../logger'

/** Structured metadata parsed from YAML frontmatter in command templates. */
export interface FrontmatterMeta {
  description?: string
  allowedBashCommands?: string[]
  /**
   * Model identifier hint from the slash-command frontmatter. May be a
   * tier alias (resolved via `~/.ion/models.json` `tiers` section by
   * the engine's `modelconfig.ResolveTierChain`), a literal model name,
   * or anything in between. The desktop does NOT attempt resolution
   * itself — the field is forwarded onto `RunOptions.Model` and the
   * engine walks the chain (tier → literal → `defaultModel` from
   * `engine.json`). An explicit per-prompt override on the desktop
   * side takes precedence over this hint; see `prompt-pipeline.ts`
   * for the no-stomp policy.
   */
  model?: string
}

/** Result of slash command expansion. */
export type SlashExpansion =
  | { expanded: true; systemPrompt: string; userPrompt: string; frontmatter: FrontmatterMeta }
  | { expanded: false }

const SLASH_RE = /^\/(\S+)\s*([\s\S]*)$/

function log(msg: string): void {
  _log('slash-expand', msg)
}

/**
 * Expand a slash command prompt into system prompt + user arguments.
 *
 * Resolution priority (when scope is 'all'):
 *   1. {projectPath}/.ion/commands/{name}.md      (project scope, Ion-native)
 *   2. ~/.ion/commands/{name}.md                  (user scope, Ion-native)
 *   3. {projectPath}/.claude/commands/{name}.md   (project scope, Claude compat)
 *   4. ~/.claude/commands/{name}.md               (user scope, Claude compat)
 *   5. ~/.claude/skills/{name}/SKILL.md           (user scope, Claude compat)
 *
 * The `scope` parameter controls which subset of paths is probed:
 *   - `'ion'`   → only `.ion/commands/` paths (1–2)
 *   - `'claude'`→ only `.claude/commands/` + `.claude/skills/` paths (3–5)
 *   - `'all'`   → both, ion first then claude (default, backward-compat)
 *
 * Colon-delimited names (e.g. `e2e:setup`) resolve to subdirectory paths
 * (`e2e/setup.md`).
 *
 * When a template contains `$ARGUMENTS`, the placeholder is replaced with
 * the user-supplied args (all occurrences). When the template does NOT
 * contain `$ARGUMENTS` and the user supplied non-empty args, the args are
 * appended as a trailing `\n\nARGUMENTS: {args}` block — matching Claude
 * Code's `substituteArguments` behaviour (appendIfNoPlaceholder branch in
 * `claude-code/src/utils/argumentSubstitution.ts:140-142`). Without this,
 * `/skillname <prompt>` drops `<prompt>` whenever SKILL.md doesn't
 * reference `$ARGUMENTS`.
 *
 * Returns `{ expanded: false }` when the prompt is not a slash command or
 * no matching `.md` file is found on disk.
 */
export async function expandSlashCommand(
  prompt: string,
  projectPath?: string,
  scope: 'ion' | 'claude' | 'all' = 'all',
): Promise<SlashExpansion> {
  const match = prompt.match(SLASH_RE)
  if (!match) return { expanded: false }

  const commandName = match[1]
  const args = match[2].trim()

  log(`command=${commandName} argsLen=${args.length} scope=${scope}`)

  // Convert colon-delimited names to path separators
  const filePath = commandName.replace(/:/g, '/') + '.md'

  const home = homedir()
  const candidates: string[] = []

  const includeIon = scope === 'ion' || scope === 'all'
  const includeClaude = scope === 'claude' || scope === 'all'

  // Ion-native paths (highest priority)
  if (includeIon) {
    if (projectPath) {
      candidates.push(join(projectPath, '.ion', 'commands', filePath))
    }
    candidates.push(join(home, '.ion', 'commands', filePath))
  }

  // Claude-compat paths
  if (includeClaude) {
    if (projectPath) {
      candidates.push(join(projectPath, '.claude', 'commands', filePath))
    }
    candidates.push(join(home, '.claude', 'commands', filePath))

    // User scope skills (SKILL.md inside named directory)
    // Only for non-colon names (skills are flat directories)
    if (!commandName.includes(':')) {
      candidates.push(join(home, '.claude', 'skills', commandName, 'SKILL.md'))
    }
  }

  log(`candidates=${candidates.length}`)

  for (const candidate of candidates) {
    log(`probing path=${candidate}`)
    const content = await tryReadFile(candidate)
    if (content === null) continue

    const { body, meta } = parseFrontmatter(content)
    const hasPlaceholder = body.includes('$ARGUMENTS')
    let resolved = body.replace(/\$ARGUMENTS/g, args)

    log(`resolved path=${candidate} bodyLen=${body.length} hasPlaceholder=${hasPlaceholder}`)

    // Claude Code parity: if the template has no $ARGUMENTS placeholder and
    // the user supplied args, append them as a trailing block so the LLM
    // still sees the user's instructions. See
    // claude-code/src/utils/argumentSubstitution.ts (substituteArguments,
    // appendIfNoPlaceholder branch). Without this, /skillname <prompt> drops
    // <prompt> entirely whenever SKILL.md doesn't reference $ARGUMENTS.
    if (!hasPlaceholder && args) {
      resolved = resolved + `\n\nARGUMENTS: ${args}`
      log(`appended ARGUMENTS suffix command=${commandName} argsLen=${args.length}`)
    }

    return {
      expanded: true,
      systemPrompt: '',
      userPrompt: resolved,
      frontmatter: meta,
    }
  }

  log(`no match command=${commandName}`)
  return { expanded: false }
}

/** Strip YAML frontmatter (--- delimited block at file start). */
export function stripFrontmatter(content: string): string {
  const lines = content.split('\n')
  if (lines[0]?.trim() !== '---') return content

  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      return lines.slice(i + 1).join('\n').trimStart()
    }
  }

  // No closing --- found; return content as-is
  return content
}

/**
 * Parse YAML frontmatter and return both the body and structured metadata.
 *
 * Uses `js-yaml` (the de-facto Node ecosystem YAML parser) so the
 * frontmatter scanner handles the full YAML 1.2 surface: inline lists,
 * indent-block lists, quoted scalars, multiline strings, anchors,
 * nested mappings, and so on. Replaces the previous hand-rolled regex
 * cluster which only handled `description` (single-line) and
 * `allowed_bash_commands` (inline / indent list) and was fragile under
 * quoted scalars, nested mappings, or any YAML construct the regex
 * cluster didn't anticipate.
 *
 * Empty / malformed frontmatter falls back to an empty meta map; the
 * body is the original content minus the frontmatter block. YAML
 * load errors (`yaml.load` throws on syntactically invalid YAML) are
 * caught and logged at debug, matching the rest of the slash-expand
 * "best-effort frontmatter" stance.
 */
export function parseFrontmatter(content: string): { body: string; meta: FrontmatterMeta } {
  const lines = content.split('\n')
  if (lines[0]?.trim() !== '---') return { body: content, meta: {} }

  let closingIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closingIdx = i
      break
    }
  }
  if (closingIdx === -1) return { body: content, meta: {} }

  const frontmatterText = lines.slice(1, closingIdx).join('\n')
  const body = lines.slice(closingIdx + 1).join('\n').trimStart()

  let raw: unknown
  try {
    raw = yaml.load(frontmatterText)
  } catch (err) {
    _log('slash-expand', `parseFrontmatter: yaml.load failed (treating as empty meta): ${err}`)
    return { body, meta: {} }
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { body, meta: {} }
  }

  const meta: FrontmatterMeta = {}
  const obj = raw as Record<string, unknown>

  if (typeof obj.description === 'string') {
    meta.description = obj.description
  }
  if (Array.isArray(obj.allowed_bash_commands)) {
    meta.allowedBashCommands = obj.allowed_bash_commands
      .filter((v): v is string => typeof v === 'string')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  // Optional `model` hint. Accepted only as a string; anything else
  // (number, array, object, null) is ignored — the field's contract
  // is "a tier alias or model id", neither of which is meaningful as
  // a non-string. Whitespace is trimmed so `model: '  smart  '` →
  // `'smart'`; an empty/whitespace-only value collapses to undefined
  // so it doesn't appear in logs as a spurious-looking blank hint.
  if (typeof obj.model === 'string') {
    const trimmed = obj.model.trim()
    if (trimmed.length > 0) {
      meta.model = trimmed
    }
  }

  return { body, meta }
}

/** Try to read a file, returning null if it doesn't exist or can't be read. */
async function tryReadFile(filePath: string): Promise<string | null> {
  try {
    await access(filePath)
    return await readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}
