import type { GitChangedFile } from '../../shared/types'

// ─── Status badge colors ───
// Single source of truth for the status → theme-token-key mapping lives in
// the git store (`stores/git/types.ts`); re-exported here for component-side
// consumers. Resolve via `useColors()`: `colors[GIT_STATUS_COLOR_KEYS[status]]`.
export { GIT_STATUS_COLOR_KEYS } from '../stores/git/types'

export const STATUS_LETTERS: Record<string, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
}

// ─── File tree grouping ───
export interface FileTreeNode {
  name: string
  path: string
  isDir: boolean
  children: FileTreeNode[]
  file?: GitChangedFile
}

export function buildFileTree(files: GitChangedFile[]): FileTreeNode[] {
  const root: FileTreeNode[] = []

  for (const file of files) {
    const parts = file.path.split('/')
    let current = root

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]
      const isLast = i === parts.length - 1
      const path = parts.slice(0, i + 1).join('/')

      let existing = current.find((n) => n.name === name && n.isDir === !isLast)
      if (!existing) {
        existing = {
          name,
          path,
          isDir: !isLast,
          children: [],
          file: isLast ? file : undefined,
        }
        current.push(existing)
      }
      if (!isLast) {
        current = existing.children
      }
    }
  }

  // Collapse single-child directories
  function collapse(nodes: FileTreeNode[]): FileTreeNode[] {
    return nodes.map((node) => {
      if (node.isDir && node.children.length === 1 && node.children[0].isDir) {
        const child = node.children[0]
        return {
          ...child,
          name: `${node.name}/${child.name}`,
          children: collapse(child.children),
        }
      }
      return { ...node, children: node.isDir ? collapse(node.children) : [] }
    })
  }

  return collapse(root)
}

// ─── Relative date formatter ───
export function relativeDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}
