import React from 'react'
import {
  File, FileTs, FileJs, FileCode, FileText, FileCss, FileHtml, FilePy,
  Image, GearSix,
} from '@phosphor-icons/react'
import type { ColorPalette } from '../theme-tokens'

export interface FileIconInfo {
  icon: React.ComponentType<{ size?: number; color?: string; weight?: 'fill' | 'regular' | 'bold' }>
  /** Theme token to resolve via useColors() — callers render `colors[colorKey]`. */
  colorKey: keyof ColorPalette
}

/** Map a filename to a Phosphor icon + theme color token. */
export function getFileIcon(name: string): FileIconInfo {
  const ext = name.includes('.') ? '.' + name.split('.').pop()!.toLowerCase() : ''
  const base = name.toLowerCase()

  switch (ext) {
    case '.ts':
    case '.tsx':
      return { icon: FileTs, colorKey: 'iconBlue' }
    case '.js':
    case '.jsx':
      return { icon: FileJs, colorKey: 'iconYellow' }
    case '.json':
      return { icon: FileCode, colorKey: 'iconGreen' }
    case '.md':
      return { icon: FileText, colorKey: 'iconSky' }
    case '.css':
    case '.scss':
      return { icon: FileCss, colorKey: 'iconPurple' }
    case '.html':
      return { icon: FileHtml, colorKey: 'iconOrange' }
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.svg':
    case '.gif':
    case '.ico':
    case '.webp':
      return { icon: Image, colorKey: 'iconPurple' }
    case '.py':
      return { icon: FilePy, colorKey: 'iconBlue' }
    default:
      break
  }

  // Config files by name
  if (['.gitignore', '.env', '.editorconfig', '.prettierrc'].includes(base)) {
    return { icon: GearSix, colorKey: 'iconGray' }
  }

  return { icon: File, colorKey: 'textTertiary' }
}
