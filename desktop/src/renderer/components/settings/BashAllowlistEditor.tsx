import React, { useCallback } from 'react'
import { Plus, Trash, ArrowUp, ArrowDown } from '@phosphor-icons/react'
import { useColors } from '../../theme'

/**
 * Editor for a `string[]` preference rendered as an Apple-style flat
 * editable list: add row, edit text inline, delete, reorder up/down.
 *
 * Designed to match the iOS `DesktopSettingsPrimitiveListEditor`
 * semantics so the two clients present the same affordances for a
 * primitive-list projectable setting. The iOS side projects this same
 * preference under the `'list' + itemType: 'string'` projection shape,
 * and the round-trip is `string[]` end-to-end (no CSV coercion).
 *
 * Render contract
 * ───────────────
 * - Each row is a text input + delete button + up/down reorder
 *   buttons. The reorder buttons disable themselves at the edges
 *   (first row can't move up, last can't move down). Reorder is
 *   intentionally explicit-button rather than drag-handle to keep the
 *   keyboard-accessibility story simple and to avoid adopting a
 *   drag-and-drop library for one editor.
 * - "Add row" appends an empty string to the end of the array. The
 *   caller's `onChange` is invoked synchronously with the new array;
 *   no internal staging — the list IS the value, mirroring the iOS
 *   editor's "snapshot, no optimistic state" stance.
 * - An empty array shows a placeholder "No commands allowed" message
 *   above the Add button so the user knows the empty state is
 *   intentional ("Bash blocked entirely") not a loading skeleton.
 *
 * Why this lives in a separate file
 * ─────────────────────────────────
 * `AIModelsCategory.tsx` is already ~270 lines and the bash-allowlist
 * editor is reusable for any future `string[]` projectable setting.
 * Co-located here so the next contributor adding a similar preference
 * can drop it in with one import rather than copy-pasting boilerplate.
 */
export interface BashAllowlistEditorProps {
  /** Current allowlist value. Empty array = Bash blocked entirely. */
  value: string[]
  /** Called with the new array on any mutation (add/edit/delete/reorder). */
  onChange: (next: string[]) => void
  /** Placeholder text shown inside an empty input. Defaults to "gh pr view". */
  placeholder?: string
}

export function BashAllowlistEditor({
  value,
  onChange,
  placeholder = 'e.g. gh',
}: BashAllowlistEditorProps) {
  const colors = useColors()

  const updateAt = useCallback(
    (index: number, next: string) => {
      const copy = value.slice()
      copy[index] = next
      onChange(copy)
    },
    [value, onChange],
  )

  const deleteAt = useCallback(
    (index: number) => {
      const copy = value.slice()
      copy.splice(index, 1)
      onChange(copy)
    },
    [value, onChange],
  )

  const moveUp = useCallback(
    (index: number) => {
      if (index === 0) return
      const copy = value.slice()
      const tmp = copy[index - 1]
      copy[index - 1] = copy[index]
      copy[index] = tmp
      onChange(copy)
    },
    [value, onChange],
  )

  const moveDown = useCallback(
    (index: number) => {
      if (index === value.length - 1) return
      const copy = value.slice()
      const tmp = copy[index + 1]
      copy[index + 1] = copy[index]
      copy[index] = tmp
      onChange(copy)
    },
    [value, onChange],
  )

  const addRow = useCallback(() => {
    onChange([...value, ''])
  }, [value, onChange])

  return (
    <div>
      {value.length === 0 && (
        <p
          style={{
            color: colors.textTertiary,
            fontSize: 11,
            fontStyle: 'italic',
            margin: '0 0 6px',
          }}
        >
          No commands allowed — Bash is blocked entirely in plan mode.
        </p>
      )}
      {value.map((cmd, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginBottom: 6,
          }}
        >
          <input
            type="text"
            value={cmd}
            placeholder={placeholder}
            onChange={(e) => updateAt(i, e.target.value)}
            style={{
              flex: 1,
              padding: '4px 8px',
              fontSize: 13,
              fontFamily: 'Menlo, Monaco, monospace',
              background: colors.surfacePrimary,
              color: colors.textPrimary,
              border: `1px solid ${colors.inputBorder}`,
              borderRadius: 4,
              outline: 'none',
            }}
          />
          <button
            onClick={() => moveUp(i)}
            disabled={i === 0}
            title="Move up"
            aria-label={`Move "${cmd}" up`}
            style={iconBtnStyle(colors, i === 0)}
          >
            <ArrowUp size={14} weight="bold" />
          </button>
          <button
            onClick={() => moveDown(i)}
            disabled={i === value.length - 1}
            title="Move down"
            aria-label={`Move "${cmd}" down`}
            style={iconBtnStyle(colors, i === value.length - 1)}
          >
            <ArrowDown size={14} weight="bold" />
          </button>
          <button
            onClick={() => deleteAt(i)}
            title="Delete"
            aria-label={`Delete "${cmd}"`}
            style={iconBtnStyle(colors, false)}
          >
            <Trash size={14} weight="bold" />
          </button>
        </div>
      ))}
      <button
        onClick={addRow}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '4px 10px',
          fontSize: 12,
          background: 'transparent',
          color: colors.textPrimary,
          border: `1px dashed ${colors.inputBorder}`,
          borderRadius: 4,
          cursor: 'pointer',
        }}
      >
        <Plus size={12} weight="bold" />
        Add command
      </button>
    </div>
  )
}

/** Shared style for the up/down/delete icon buttons. */
function iconBtnStyle(
  colors: ReturnType<typeof useColors>,
  disabled: boolean,
): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 24,
    height: 24,
    background: 'transparent',
    color: disabled ? colors.textTertiary : colors.textSecondary,
    border: `1px solid ${colors.inputBorder}`,
    borderRadius: 4,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.4 : 1,
  }
}
