import { readdir, readFile, stat } from 'fs/promises'
import { homedir } from 'os'
import { join, relative, basename, extname } from 'path'

export interface DiscoveredCommand {
  name: string
  description: string
  scope: 'user' | 'project'
  source: 'command' | 'skill'
}

/**
 * Discover slash commands from user and project command/skill directories.
 * Scans ~/.claude/commands, ~/.claude/skills, and {projectPath}/.claude/commands.
 */
export async function discoverCommands(projectPath: string): Promise<DiscoveredCommand[]> {
  const home = homedir()

  const [userCommands, userSkills, projectCommands] = await Promise.all([
    scanCommandDir(join(home, '.claude', 'commands'), 'user'),
    scanSkillsDir(join(home, '.claude', 'skills')),
    scanCommandDir(join(projectPath, '.claude', 'commands'), 'project'),
  ])

  return [...userCommands, ...userSkills, ...projectCommands]
}

/** Check if a directory exists and is actually a directory. */
async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const s = await stat(dirPath)
    return s.isDirectory()
  } catch {
    return false
  }
}

/** Skip dotfiles and README.md */
function shouldSkip(name: string): boolean {
  return name.startsWith('.') || name === 'README.md'
}

/** Extract description from a command .md file: first non-empty line, truncated to 80 chars. */
function extractCommandDescription(content: string): string {
  const lines = content.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length > 0) {
      return trimmed.length > 80 ? trimmed.slice(0, 80) : trimmed
    }
  }
  return ''
}

/** Parse YAML-like frontmatter between --- delimiters for a `description:` field. */
function parseFrontmatterDescription(content: string): string {
  const lines = content.split('\n')
  if (lines[0]?.trim() !== '---') return ''

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '---') break

    const match = line.match(/^description:\s*(.+)$/i)
    if (match) {
      // Strip surrounding quotes if present
      let desc = match[1].trim()
      if ((desc.startsWith('"') && desc.endsWith('"')) || (desc.startsWith("'") && desc.endsWith("'"))) {
        desc = desc.slice(1, -1)
      }
      return desc.length > 80 ? desc.slice(0, 80) : desc
    }
  }
  return ''
}

/**
 * Recursively scan a commands directory for .md files.
 * Subdirectories produce colon-separated names (e.g., e2e/setup.md -> e2e:setup).
 */
async function scanCommandDir(
  dirPath: string,
  scope: 'user' | 'project',
): Promise<DiscoveredCommand[]> {
  if (!(await dirExists(dirPath))) return []

  const commands: DiscoveredCommand[] = []
  await walkCommandDir(dirPath, dirPath, scope, commands)
  return commands
}

async function walkCommandDir(
  baseDir: string,
  currentDir: string,
  scope: 'user' | 'project',
  results: DiscoveredCommand[],
): Promise<void> {
  let entries
  try {
    entries = await readdir(currentDir, { withFileTypes: true })
  } catch {
    return
  }

  const tasks: Promise<void>[] = []

  for (const entry of entries) {
    if (shouldSkip(entry.name)) continue

    const fullPath = join(currentDir, entry.name)

    if (entry.isDirectory()) {
      tasks.push(walkCommandDir(baseDir, fullPath, scope, results))
    } else if (entry.isFile() && extname(entry.name) === '.md') {
      tasks.push(
        readFile(fullPath, 'utf-8').then((content) => {
          const rel = relative(baseDir, fullPath)
          // Strip .md extension and replace path separators with colons
          const name = rel.slice(0, -3).replace(/\//g, ':')
          results.push({
            name,
            description: extractCommandDescription(content),
            scope,
            source: 'command',
          })
        }).catch(() => {
          // Skip files that can't be read
        }),
      )
    }
  }

  await Promise.all(tasks)
}

/**
 * Scan ~/.claude/skills/ for directories containing SKILL.md.
 */
async function scanSkillsDir(skillsDir: string): Promise<DiscoveredCommand[]> {
  if (!(await dirExists(skillsDir))) return []

  let entries
  try {
    entries = await readdir(skillsDir, { withFileTypes: true })
  } catch {
    return []
  }

  const tasks = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map(async (entry): Promise<DiscoveredCommand | null> => {
      const skillPath = join(skillsDir, entry.name, 'SKILL.md')
      try {
        const content = await readFile(skillPath, 'utf-8')
        return {
          name: entry.name,
          description: parseFrontmatterDescription(content),
          scope: 'user',
          source: 'skill',
        }
      } catch {
        return null
      }
    })

  const results = await Promise.all(tasks)
  return results.filter((r): r is DiscoveredCommand => r !== null)
}
