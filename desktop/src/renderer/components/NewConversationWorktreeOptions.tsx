import React from 'react'
import { CheckSquare, Square } from '@phosphor-icons/react'
import type { useColors } from '../theme'
import { IS_MAC } from '../platform/mod-key'

/** The key that, held while starting a worktree conversation, asks for the branch again. */
export const CHOOSE_BRANCH_KEY_LABEL = IS_MAC ? 'Option' : 'Alt'

/**
 * The two choices on the branch step of a worktree conversation: whether the
 * worktree is ephemeral, and whether the branch and that answer are saved for
 * the project so the next worktree conversation starts without this step.
 *
 * `ephemeral` is null while the project's default is still being read; the
 * control is then disabled rather than showing a value that may flip.
 */
export function WorktreeChoiceOptions({ ephemeral, remember, colors, onEphemeral, onRemember }: {
  ephemeral: boolean | null
  remember: boolean
  colors: ReturnType<typeof useColors>
  onEphemeral(next: boolean): void
  onRemember(next: boolean): void
}): React.JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 10px', borderBottom: `1px solid ${colors.popoverBorder}` }}>
      <OptionCheckbox
        label="Ephemeral"
        hint="Removed when the conversation closes, unless it has unlanded work."
        checked={ephemeral === true}
        disabled={ephemeral === null}
        colors={colors}
        onChange={onEphemeral}
      />
      <OptionCheckbox
        label="Remember for this project"
        hint={`Next time, start from this branch without asking. Hold ${CHOOSE_BRANCH_KEY_LABEL} to choose again.`}
        checked={remember}
        colors={colors}
        onChange={onRemember}
      />
    </div>
  )
}

function OptionCheckbox({ label, hint, checked, disabled = false, colors, onChange }: {
  label: string
  hint: string
  checked: boolean
  disabled?: boolean
  colors: ReturnType<typeof useColors>
  onChange(next: boolean): void
}): React.JSX.Element {
  const Icon = checked ? CheckSquare : Square
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="ion-focusable"
      // Keep focus in the search box, so Enter still picks the highlighted branch.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onChange(!checked)}
      style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '4px 0', border: 'none', background: 'transparent', textAlign: 'left', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1 }}
    >
      <Icon size={15} weight={checked ? 'fill' : 'regular'} color={checked ? colors.accent : colors.textTertiary} style={{ flexShrink: 0, marginTop: 1 }} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span style={{ fontSize: 12, color: colors.textPrimary }}>{label}</span>
        <span style={{ fontSize: 11, color: colors.textSecondary }}>{hint}</span>
      </span>
    </button>
  )
}
