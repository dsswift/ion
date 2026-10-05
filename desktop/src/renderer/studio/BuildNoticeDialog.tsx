/**
 * BuildNoticeDialog — the Build Notice: on the first Studio window of a
 * desktop build this device has not acknowledged, says Ion Studio was updated,
 * which build is running and which build it replaced, and the release's
 * What's new notes when it has any. Dismissing it acknowledges the build;
 * until then it shows on every launch.
 *
 * Desktop only: a browser Studio has no desktop build (no 'updates'
 * capability).
 */
import React, { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import type { BuildNotice, DesktopBuild } from '@ion/shared/build-notice'
import { usePopoverLayer } from '../components/PopoverLayer'
import { useColors } from '../theme'
import { transitions } from '../theme-tokens'
import { useInteractiveState } from '../hooks/useInteractiveState'
import { host } from '../host/host-instance'
import { rError, rInfo } from '../rendererLogger'

export function BuildNoticeDialog(): React.JSX.Element | null {
  const popoverLayer = usePopoverLayer()
  const [notice, setNotice] = useState<BuildNotice | null>(null)

  useEffect(() => {
    if (!host.capabilities().includes('updates')) return
    let live = true
    host.shell.getBuildNotice()
      .then((next) => {
        if (!live || !next) return
        rInfo('build-notice', 'build notice shown', { version: next.current.version, previous_version: next.previous?.version ?? null })
        setNotice(next)
      })
      .catch((err: unknown) => rError('build-notice', 'build notice unavailable', { error: String(err) }))
    return () => { live = false }
  }, [])

  const dismiss = useCallback(() => {
    setNotice(null)
    host.shell.acknowledgeBuildNotice()
      .catch((err: unknown) => rError('build-notice', 'build acknowledgement failed', { error: String(err) }))
  }, [])

  if (!popoverLayer || !notice) return null
  return createPortal(<NoticeDialog notice={notice} onDismiss={dismiss} />, popoverLayer)
}

function formatBuiltAt(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  return at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function NoticeDialog({ notice, onDismiss }: { notice: BuildNotice; onDismiss: () => void }): React.JSX.Element {
  const colors = useColors()
  const { current, previous, highlights } = notice
  const heading = previous ? 'Ion Studio was updated' : 'Ion Studio was installed'

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onDismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDismiss])

  return (
    <motion.div
      data-ion-ui
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onClick={onDismiss}
      style={{
        position: 'fixed',
        inset: 0,
        background: colors.scrim,
        pointerEvents: 'auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        boxSizing: 'border-box',
      }}
    >
      <motion.div
        data-ion-ui
        role="dialog"
        aria-label={heading}
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        onClick={(e) => e.stopPropagation()}
        className="glass-surface"
        style={{
          width: 380,
          maxWidth: '100%',
          maxHeight: '100%',
          minWidth: 0,
          boxSizing: 'border-box',
          borderRadius: 16,
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: colors.textPrimary }}>{heading}</div>
        <div style={{ fontSize: 11, color: colors.textSecondary }}>You're running the latest build.</div>
        <BuildRow label="Now running" build={current} emphasis />
        {previous && <BuildRow label="Previous" build={previous} />}
        {highlights.length > 0 && <WhatsNew highlights={highlights} />}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
          <DismissButton onClick={onDismiss} />
        </div>
      </motion.div>
    </motion.div>
  )
}

function WhatsNew({ highlights }: { highlights: string[] }): React.JSX.Element {
  const colors = useColors()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: colors.textPrimary }}>What's new</div>
      <ul
        aria-label="What's new"
        style={{ margin: 0, paddingLeft: 16, maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}
      >
        {highlights.map((item) => (
          <li key={item} style={{ fontSize: 11, lineHeight: 1.5, color: colors.textSecondary, overflowWrap: 'anywhere' }}>{item}</li>
        ))}
      </ul>
    </div>
  )
}

function BuildRow({ label, build, emphasis = false }: { label: string; build: DesktopBuild; emphasis?: boolean }): React.JSX.Element {
  const colors = useColors()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <div style={{ fontSize: 10, color: colors.textTertiary }}>{label}</div>
      <div
        style={{
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 12,
          fontWeight: emphasis ? 600 : 400,
          color: emphasis ? colors.textPrimary : colors.textSecondary,
          overflowWrap: 'anywhere',
        }}
      >
        {build.version}
      </div>
      <div style={{ fontSize: 11, color: colors.textSecondary }}>Built {formatBuiltAt(build.builtAt)}</div>
    </div>
  )
}

function DismissButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  const colors = useColors()
  const ix = useInteractiveState()
  const background = ix.pressed ? colors.accentPressed : ix.hover ? colors.accentHover : colors.accent
  return (
    <button
      onClick={onClick}
      {...ix.handlers}
      autoFocus
      className="ion-focusable px-3 py-1 rounded-lg text-[11px]"
      style={{ color: colors.textOnAccent, background, border: 'none', cursor: 'pointer', transition: `background ${transitions.base}` }}
    >
      Dismiss
    </button>
  )
}
