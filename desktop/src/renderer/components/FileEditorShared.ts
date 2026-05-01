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
import remarkGfm from 'remark-gfm'

export const REMARK_PLUGINS = [remarkGfm]

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
    default:
      return null
  }
}

export function isMarkdownFile(fileName: string): boolean {
  return fileName.toLowerCase().endsWith('.md')
}
