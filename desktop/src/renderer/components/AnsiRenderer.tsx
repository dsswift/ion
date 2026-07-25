import React, { useMemo } from 'react'
import { useColors } from '../theme'

interface AnsiRendererProps {
  lines: string[]
  style?: React.CSSProperties
}

interface StyledSegment {
  text: string
  bold: boolean
  fg: string | null
  bg: string | null
}

/**
 * Parse one line of ANSI-escaped terminal output into styled segments.
 * `ansi16` maps the standard 16-color SGR codes (30-37 fg, 90-97 bright fg;
 * 40-47 backgrounds reuse the 30-37 entries) to theme colors — built from
 * the active palette's ansi* tokens in the component via useColors().
 */
function parseAnsiLine(line: string, ansi16: Record<number, string>): StyledSegment[] {
  const segments: StyledSegment[] = []
  let bold = false
  let fg: string | null = null
  let bg: string | null = null
  let i = 0

  while (i < line.length) {
    if (line[i] === '\x1b' && line[i + 1] === '[') {
      // Parse CSI sequence
      let j = i + 2
      while (j < line.length && line[j] !== 'm') j++
      if (j >= line.length) break

      const params = line.substring(i + 2, j).split(';').map(Number)
      let k = 0
      while (k < params.length) {
        const p = params[k]
        if (p === 0) { bold = false; fg = null; bg = null }
        else if (p === 1) bold = true
        else if (p === 22) bold = false
        else if (p === 39) fg = null
        else if (p === 49) bg = null
        else if (p >= 30 && p <= 37) fg = ansi16[p] || null
        else if (p >= 90 && p <= 97) fg = ansi16[p] || null
        else if (p >= 40 && p <= 47) bg = ansi16[p - 10] || null
        else if (p === 38 && params[k + 1] === 2) {
          // 24-bit fg: 38;2;R;G;B
          fg = `rgb(${params[k + 2]},${params[k + 3]},${params[k + 4]})` // hardcoded-ok: 24-bit SGR passthrough from terminal data
          k += 4
        } else if (p === 48 && params[k + 1] === 2) {
          // 24-bit bg: 48;2;R;G;B
          bg = `rgb(${params[k + 2]},${params[k + 3]},${params[k + 4]})` // hardcoded-ok: 24-bit SGR passthrough from terminal data
          k += 4
        } else if (p === 38 && params[k + 1] === 5) {
          // 256-color fg (simplified: pass through)
          k += 2
        } else if (p === 48 && params[k + 1] === 5) {
          k += 2
        }
        k++
      }
      i = j + 1
    } else {
      // Collect text until next escape
      let j = i
      while (j < line.length && line[j] !== '\x1b') j++
      const text = line.substring(i, j)
      if (text) segments.push({ text, bold, fg, bg })
      i = j
    }
  }
  return segments
}

export function AnsiRenderer({ lines, style }: AnsiRendererProps) {
  const colors = useColors()

  // Standard 16-color palette (SGR 30-37, 90-97), resolved from theme tokens.
  const ansi16 = useMemo<Record<number, string>>(() => ({
    30: colors.ansiBlack, 31: colors.ansiRed, 32: colors.ansiGreen, 33: colors.ansiYellow,
    34: colors.ansiBlue, 35: colors.ansiMagenta, 36: colors.ansiCyan, 37: colors.ansiWhite,
    90: colors.ansiBrightBlack, 91: colors.ansiBrightRed, 92: colors.ansiBrightGreen, 93: colors.ansiBrightYellow,
    94: colors.ansiBrightBlue, 95: colors.ansiBrightMagenta, 96: colors.ansiBrightCyan, 97: colors.ansiBrightWhite,
  }), [colors])

  const rendered = useMemo(() => {
    return lines.map((line, lineIdx) => {
      const segments = parseAnsiLine(line, ansi16)
      if (segments.length === 0) return <div key={lineIdx} style={{ minHeight: '1.2em' }}>&nbsp;</div>

      return (
        <div key={lineIdx} style={{ whiteSpace: 'pre', lineHeight: '1.4' }}>
          {segments.map((seg, segIdx) => (
            <span
              key={segIdx}
              style={{
                fontWeight: seg.bold ? 700 : 400,
                color: seg.fg || colors.textPrimary,
                backgroundColor: seg.bg || undefined,
              }}
            >
              {seg.text}
            </span>
          ))}
        </div>
      )
    })
  }, [lines, colors.textPrimary, ansi16])

  return (
    <div style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12, ...style }}>
      {rendered}
    </div>
  )
}
