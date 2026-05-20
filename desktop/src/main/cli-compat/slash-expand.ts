import { readFile, access } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

/** Result of slash command expansion. */
export type SlashExpansion =
  | { expanded: true; systemPrompt: string; userPrompt: string }
  | { expanded: false }

const SLASH_RE = /^\/(\S+)\s*([\s\S]*)$/

/**
 * Expand a slash command prompt into system prompt + user arguments.
 *
 * Resolution priority:
 *   1. {projectPath}/.claude/commands/{name}.md   (project scope)
 *   2. ~/.claude/commands/{name}.md               (user scope)
 *   3. ~/.claude/skills/{name}/SKILL.md           (user scope)
 *
 * Colon-delimited names (e.g. `e2e:setup`) resolve to subdirectory paths
 * (`e2e/setup.md`).
 *
 * Returns `{ expanded: false }` when the prompt is not a slash command or
 * no matching `.md` file is found on disk.
 */
export async function expandSlashCommand(
  prompt: string,
  projectPath?: string,
): Promise<SlashExpansion> {
  const match = prompt.match(SLASH_RE)
  if (!match) return { expanded: false }

  const commandName = match[1]
  const args = match[2].trim()

  // Convert colon-delimited names to path separators
  const filePath = commandName.replace(/:/g, '/') + '.md'

  const home = homedir()
  const candidates: string[] = []

  // 1. Project scope (highest priority)
  if (projectPath) {
    candidates.push(join(projectPath, '.claude', 'commands', filePath))
  }

  // 2. User scope commands
  candidates.push(join(home, '.claude', 'commands', filePath))

  // 3. User scope skills (SKILL.md inside named directory)
  // Only for non-colon names (skills are flat directories)
  if (!commandName.includes(':')) {
    candidates.push(join(home, '.claude', 'skills', commandName, 'SKILL.md'))
  }

  for (const candidate of candidates) {
    const content = await tryReadFile(candidate)
    if (content === null) continue

    const body = stripFrontmatter(content)
    const resolved = body.replace(/\$ARGUMENTS/g, args)

    // Following Claude Code's behavior: the expanded command content
    // becomes the user message directly. When args are present and the
    // template contains $ARGUMENTS, the substituted content is the full
    // instruction. When no args, the raw content is the instruction.
    return {
      expanded: true,
      systemPrompt: '',
      userPrompt: resolved,
    }
  }

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
