/**
 * The browser's answer to a native Save-As dialog.
 *
 * Electron opens an OS file dialog and hands back a path on the user's own
 * machine. A browser tab has no such dialog — but it does not need one, since
 * the files a browser Studio client edits live on the SERVER, and a path there
 * is exactly what `fsWriteFile` already takes over the wire. What is missing
 * is only the part that asks the user where. This supplies that.
 *
 * It is deliberately a path prompt rather than a rendered directory tree. The
 * contract a caller needs is "a promise that resolves to an absolute path or a
 * cancellation", identical in shape to `fsSaveDialog`'s, and typing a path
 * satisfies it completely. A browsable picker is a better experience and can
 * replace the body of this dialog later without any caller changing, because
 * the seam is the promise, not the widget.
 *
 * The imperative shape (`promptForSavePath()` returns a promise) exists so the
 * three existing Save-As call sites keep the control flow they already have:
 * they awaited a dialog before and they await one now. Rewriting them to hoist
 * dialog state into their own components would have been a much larger change
 * for no behavioural gain.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useColors } from '../theme'
import { usePopoverLayer } from '../components/PopoverLayer'
import { DEFAULT_MONO_FONT } from '../typography'
import { isAbsolutePath, joinPath } from '@ion/shared/paths'
import { currentRequest, registerPromptHost, settleRequest, type SavePathResult } from './save-path-prompt-state'

export { promptForSavePath, promptForDirectory, type SavePathResult } from './save-path-prompt-state'

/**
 * Mounted once, near the root. Renders nothing until a save prompt is pending.
 */
export function SavePathPromptHost(): React.JSX.Element | null {
  const colors = useColors()
  const layer = usePopoverLayer()
  const [, forceRender] = useState(0)
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const request = currentRequest()

  useEffect(() => {
    registerPromptHost(() => forceRender((n) => n + 1))
    return () => registerPromptHost(null)
  }, [])

  useEffect(() => {
    if (!request) return
    setValue(joinPath(request.defaultPath ?? '', request.defaultFileName ?? ''))
    // Select the file name, leaving the directory intact — the same selection
    // a native Save-As dialog opens with.
    const id = requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      const slash = Math.max(el.value.lastIndexOf('/'), el.value.lastIndexOf('\\'))
      const dot = el.value.lastIndexOf('.')
      el.setSelectionRange(slash + 1, dot > slash ? dot : el.value.length)
    })
    return () => cancelAnimationFrame(id)
  }, [request])

  const settle = useCallback((result: SavePathResult) => {
    settleRequest(result)
    forceRender((n) => n + 1)
  }, [])

  if (!request || !layer) return null

  const trimmed = value.trim()
  // `isAbsolutePath`, not `startsWith('/')`: the server on the other end of
  // this prompt may be Windows, where an absolute path starts with a drive
  // letter and a POSIX-only test would reject every valid answer.
  const valid = trimmed.length > 0 && isAbsolutePath(trimmed)

  return createPortal(
    <div
      data-ion-ui
      style={{
        position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: colors.scrim, pointerEvents: 'auto', zIndex: 1000,
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) settle({ filePath: null }) }}
    >
      <div
        style={{
          width: 520, maxWidth: '90vw', padding: 20, borderRadius: 10,
          background: colors.containerBg, border: `1px solid ${colors.containerBorder}`,
          display: 'flex', flexDirection: 'column', gap: 12,
        }}
      >
        <div style={{ color: colors.textPrimary, fontSize: 14, fontWeight: 600 }}>
          {request.kind === 'directory' ? 'Choose a folder' : 'Save as'}
        </div>
        <div style={{ color: colors.textTertiary, fontSize: 12 }}>
          Absolute {request.kind === 'directory' ? 'folder' : 'file'} path on the server this Studio is connected to.
        </div>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') settle({ filePath: null })
            if (e.key === 'Enter' && valid) settle({ filePath: trimmed })
          }}
          spellCheck={false}
          style={{
            padding: '8px 10px', borderRadius: 6, fontSize: 12, fontFamily: DEFAULT_MONO_FONT,
            background: colors.surfacePrimary, color: colors.textPrimary,
            border: `1px solid ${valid || trimmed.length === 0 ? colors.inputBorder : colors.accentPressed}`,
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={() => settle({ filePath: null })}
            style={{ padding: '6px 12px', borderRadius: 6, border: `1px solid ${colors.containerBorder}`, background: 'transparent', color: colors.textSecondary, cursor: 'pointer', fontSize: 12 }}
          >
            Cancel
          </button>
          <button
            disabled={!valid}
            onClick={() => settle({ filePath: trimmed })}
            style={{ padding: '6px 12px', borderRadius: 6, border: 'none', background: valid ? colors.accent : colors.surfaceHover, color: valid ? colors.textOnAccent : colors.textTertiary, cursor: valid ? 'pointer' : 'default', fontSize: 12 }}
          >
            {request.kind === 'directory' ? 'Choose' : 'Save'}
          </button>
        </div>
      </div>
    </div>,
    layer,
  )
}
