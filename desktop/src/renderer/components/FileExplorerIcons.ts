import React from 'react'
import {
  File, FileTs, FileJs, FileCode, FileText, FileCss, FileHtml, FilePy,
  Image, GearSix,
} from '@phosphor-icons/react'

export interface FileIconInfo {
  icon: React.ComponentType<{ size?: number; color?: string; weight?: 'fill' | 'regular' | 'bold' }>
  color: string
}

/** Map a filename to a Phosphor icon + color. */
export function getFileIcon(name: string, fallbackColor: string): FileIconInfo {
  const ext = name.includes('.') ? '.' + name.split('.').pop()!.toLowerCase() : ''
  const base = name.toLowerCase()

  switch (ext) {
    case '.ts':
    case '.tsx':
      return { icon: FileTs, color: '#3b82f6' }
    case '.js':
    case '.jsx':
      return { icon: FileJs, color: '#eab308' }
    case '.json':
      return { icon: FileCode, color: '#22c55e' }
    case '.md':
      return { icon: FileText, color: '#60a5fa' }
    case '.css':
    case '.scss':
      return { icon: FileCss, color: '#a855f7' }
    case '.html':
      return { icon: FileHtml, color: '#f97316' }
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.svg':
    case '.gif':
    case '.ico':
    case '.webp':
      return { icon: Image, color: '#a855f7' }
    case '.py':
      return { icon: FilePy, color: '#3b82f6' }
    default:
      break
  }

  // Config files by name
  if (['.gitignore', '.env', '.editorconfig', '.prettierrc'].includes(base)) {
    return { icon: GearSix, color: '#9ca3af' }
  }

  return { icon: File, color: fallbackColor }
}
