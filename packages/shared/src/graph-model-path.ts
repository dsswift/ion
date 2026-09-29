/**
 * Path helpers for Graph View's renderer-side model.
 *
 * Node's `path` module cannot be imported by the renderer, so these helpers
 * normalize both native separator styles to forward slashes. That gives the
 * corpus scanner and link resolver one stable path representation on macOS
 * and Windows.
 */

import { isAbsolutePath as isNativeAbsolutePath } from './paths'

export function isAbsolutePath(p: string): boolean {
  return isNativeAbsolutePath(p)
}

export function dirnamePath(p: string): string {
  const normalized = p.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  if (idx < 0) return '.'
  if (idx === 0) return '/'
  return normalized.slice(0, idx)
}

export function joinPaths(...segments: string[]): string {
  const joined = segments
    .map((segment) => segment.replace(/\\/g, '/'))
    .filter((s) => s.length > 0)
    .join('/')
  return normalizePath(joined)
}

/** Collapse `.`, `..`, and repeated slashes. Preserves an absolute prefix. */
export function normalizePath(p: string): string {
  const normalized = p.replace(/\\/g, '/')
  const drive = /^([A-Za-z]:)(?:\/|$)/.exec(normalized)?.[1] ?? ''
  const unc = normalized.startsWith('//')
  const absolute = isAbsolutePath(normalized)
  const withoutPrefix = drive ? normalized.slice(2) : unc ? normalized.slice(2) : normalized
  const parts = withoutPrefix.split('/').filter((part) => part.length > 0 && part !== '.')
  const out: string[] = []
  for (const part of parts) {
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
    } else {
      out.push(part)
    }
  }
  const result = out.join('/')
  if (drive) return `${drive}/${result}`
  if (unc) return `//${result}`
  return absolute ? `/${result}` : result || '.'
}
