import type { Extension } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { go } from '@codemirror/lang-go'
import { rust } from '@codemirror/lang-rust'
import { sql } from '@codemirror/lang-sql'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import { cpp } from '@codemirror/lang-cpp'
import { java } from '@codemirror/lang-java'
import { StreamLanguage } from '@codemirror/language'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import remarkGfm from 'remark-gfm'

export const REMARK_PLUGINS = [remarkGfm]

/** All supported languages for the language picker */
export const ALL_LANGUAGES = [
  { id: 'typescript', label: 'TypeScript', exts: ['.ts', '.tsx'] },
  { id: 'javascript', label: 'JavaScript', exts: ['.js', '.jsx'] },
  { id: 'json', label: 'JSON', exts: ['.json'] },
  { id: 'css', label: 'CSS', exts: ['.css', '.scss'] },
  { id: 'html', label: 'HTML', exts: ['.html'] },
  { id: 'markdown', label: 'Markdown', exts: ['.md'] },
  { id: 'python', label: 'Python', exts: ['.py'] },
  { id: 'go', label: 'Go', exts: ['.go'] },
  { id: 'rust', label: 'Rust', exts: ['.rs'] },
  { id: 'sql', label: 'SQL', exts: ['.sql'] },
  { id: 'xml', label: 'XML', exts: ['.xml', '.svg'] },
  { id: 'yaml', label: 'YAML', exts: ['.yml', '.yaml'] },
  { id: 'cpp', label: 'C/C++', exts: ['.c', '.cpp', '.h', '.hpp', '.cc'] },
  { id: 'java', label: 'Java', exts: ['.java'] },
  { id: 'shell', label: 'Shell', exts: ['.sh', '.bash', '.zsh'] },
] as const

/** Map a language ID to its CodeMirror extension */
export function getLanguageExtensionById(id: string): Extension | null {
  switch (id) {
    case 'typescript': return javascript({ typescript: true, jsx: true })
    case 'javascript': return javascript({ jsx: true })
    case 'json': return json()
    case 'css': return css()
    case 'html': return html()
    case 'markdown': return markdown()
    case 'python': return python()
    case 'go': return go()
    case 'rust': return rust()
    case 'sql': return sql()
    case 'xml': return xml()
    case 'yaml': return yaml()
    case 'cpp': return cpp()
    case 'java': return java()
    case 'shell': return StreamLanguage.define(shell)
    default: return null
  }
}

/** Map file extension to CodeMirror language extension */
export function getLanguageExtension(fileName: string): Extension | null {
  const ext = fileName.includes('.') ? '.' + fileName.split('.').pop()!.toLowerCase() : ''
  switch (ext) {
    case '.ts':
    case '.tsx':
      return javascript({ typescript: true, jsx: ext === '.tsx' })
    case '.js':
    case '.jsx':
      return javascript({ jsx: ext === '.jsx' })
    case '.json':
      return json()
    case '.css':
    case '.scss':
      return css()
    case '.html':
      return html()
    case '.md':
      return markdown()
    case '.py':
      return python()
    case '.go':
      return go()
    case '.rs':
      return rust()
    case '.sql':
      return sql()
    case '.xml':
    case '.svg':
      return xml()
    case '.yml':
    case '.yaml':
      return yaml()
    case '.c':
    case '.cpp':
    case '.h':
    case '.hpp':
    case '.cc':
      return cpp()
    case '.java':
      return java()
    case '.sh':
    case '.bash':
    case '.zsh':
      return StreamLanguage.define(shell)
    default:
      return null
  }
}

/** Human-readable language label for a file name */
export function getLanguageLabel(fileName: string): string {
  const ext = fileName.includes('.') ? '.' + fileName.split('.').pop()!.toLowerCase() : ''
  const match = ALL_LANGUAGES.find((l) => (l.exts as readonly string[]).includes(ext))
  return match?.label ?? 'Plain Text'
}

export function isMarkdownFile(fileName: string): boolean {
  return fileName.toLowerCase().endsWith('.md')
}
