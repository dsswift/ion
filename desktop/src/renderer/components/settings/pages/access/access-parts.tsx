/**
 * access-parts — the small pieces the Access & pairing sections share: a
 * m:ss countdown, a one-time code drawn large enough to type, and a copy to
 * the clipboard that logs a refusal instead of dropping it.
 */
import React from 'react'
import { useColors } from '../../../../theme'
import { KIT } from '../../kit'
import { rWarn } from '../../../../rendererLogger'

/** Time left until `until`, as m:ss. */
export function remaining(until: number, now: number): string {
  const seconds = Math.max(0, Math.round((until - now) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** A one-time code someone reads off this screen and types elsewhere. */
export function CodeText({ children, large, testId }: { children: string; large?: boolean; testId?: string }): React.JSX.Element {
  const colors = useColors()
  return (
    <span
      data-testid={testId}
      style={{ fontFamily: KIT.mono, fontSize: large ? KIT.font + 7 : KIT.font + 2, letterSpacing: large ? 3 : 2, color: colors.textPrimary, userSelect: 'all', whiteSpace: 'nowrap' }}
    >
      {children}
    </span>
  )
}

export function copyText(tag: string, text: string): void {
  void navigator.clipboard.writeText(text).catch((err: unknown) => rWarn(tag, 'copy failed', { error: String(err) }))
}

/** How far in the future `at` is, for an expiry: "in 10 min". */
export function formatFromNow(at: number, now: number = Date.now()): string {
  const diff = at - now
  if (diff <= 0) return 'now'
  if (diff < 60_000) return 'in under a minute'
  if (diff < 3_600_000) return `in ${Math.round(diff / 60_000)} min`
  if (diff < 86_400_000) return `in ${Math.round(diff / 3_600_000)} h`
  return `in ${Math.round(diff / 86_400_000)} days`
}
