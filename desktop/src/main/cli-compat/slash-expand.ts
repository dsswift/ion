import { readFile, access } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { log as _log } from '../logger'

/** Result of slash command expansion. */
export type SlashExpansion =
  | { expanded: true; systemPrompt: string; userPrompt: string }
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

    const body = stripFrontmatter(content)
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

/** Try to read a file, returning null if it doesn't exist or can't be read. */
async function tryReadFile(filePath: string): Promise<string | null> {
  try {
    await access(filePath)
    return await readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}
