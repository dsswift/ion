/**
 * Commit form — single compact row:
 *   [cc: ▾] [Commit message…] [char count] [✓ ▾]
 *
 * The cc: dropdown reads `.commit.json` from the repo root to respect
 * per-repo whitelist/blacklist of conventional-commit types.
 *
 * The commit button is a combo button with a dropdown containing:
 * Commit/Push toggle, Amend, Sign-off, GPG toggles, and AI commit action.
 *
 * Draft autosave per directory+branch. Post-commit banner with Push/Undo.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Check, Robot, ArrowCounterClockwise, CaretDown } from '@phosphor-icons/react'
import { useColors } from '../../theme'

interface CommitFormProps {
  directory: string
  branch: string
  stagedCount: number
  onCommit: (message: string, amend: boolean, opts?: { signoff?: boolean; gpg?: boolean }) => Promise<boolean>
  onQuickCommit: () => void
  onPush: () => void
}

type PrimaryAction = 'commit' | 'commit-push'

const PRIMARY_KEY = 'ion:commit-primary-action'
const DEFAULT_PREFIXES = ['feat', 'fix', 'chore', 'docs', 'refactor', 'test', 'style', 'perf']

function draftKey(dir: string, branch: string) { return `ion:commit-draft:${dir}:${branch}` }

export function CommitForm({ directory, branch, stagedCount, onCommit, onQuickCommit, onPush }: CommitFormProps) {
  const colors = useColors()
  const [message, setMessage] = useState('')
  const [amend, setAmend] = useState(false)
  const [signOff, setSignOff] = useState(false)
  const [gpg, setGpg] = useState(false)
  const [primary, setPrimary] = useState<PrimaryAction>(() => (typeof localStorage !== 'undefined' && (localStorage.getItem(PRIMARY_KEY) as PrimaryAction)) || 'commit')
  const [bannerOpen, setBannerOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [prefixOpen, setPrefixOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [prefixes, setPrefixes] = useState(DEFAULT_PREFIXES)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const prefixRef = useRef<HTMLDivElement>(null)
  const prefixDirRef = useRef<string | null>(null)

  // Load .commit.json for CC prefix config
  useEffect(() => {
    if (prefixDirRef.current === directory) return
    prefixDirRef.current = directory
    window.ion.fsReadFile(directory + '/.commit.json').then(({ content }) => {
      if (!content) { setPrefixes(DEFAULT_PREFIXES); return }
      try {
        const cfg = JSON.parse(content)
        const ct = cfg?.commitTypes
        if (!ct?.types || !Array.isArray(ct.types)) { setPrefixes(DEFAULT_PREFIXES); return }
        if (ct.mode === 'whitelist') {
          setPrefixes(ct.types.filter((t: string) => typeof t === 'string'))
        } else if (ct.mode === 'blacklist') {
          setPrefixes(DEFAULT_PREFIXES.filter(p => !ct.types.includes(p)))
        } else {
          setPrefixes(DEFAULT_PREFIXES)
        }
      } catch { setPrefixes(DEFAULT_PREFIXES) }
    }).catch(() => setPrefixes(DEFAULT_PREFIXES))
  }, [directory])

  // Load draft on directory/branch change
  useEffect(() => {
    const saved = localStorage.getItem(draftKey(directory, branch))
    setMessage(saved ?? '')
    setAmend(false)
  }, [directory, branch])

  // Save draft
  useEffect(() => {
    const k = draftKey(directory, branch)
    message.trim() ? localStorage.setItem(k, message) : localStorage.removeItem(k)
  }, [message, directory, branch])

  // Auto-resize textarea
  useEffect(() => {
    const ta = taRef.current; if (!ta) return
    ta.style.height = '20px'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'
  }, [message])

  // Persist primary action
  useEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(PRIMARY_KEY, primary)
  }, [primary])

  // Close dropdowns on outside click
  useEffect(() => {
    if (!menuOpen && !prefixOpen) return
    const handler = (e: MouseEvent) => {
      if (menuOpen && menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
      if (prefixOpen && prefixRef.current && !prefixRef.current.contains(e.target as Node)) setPrefixOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen, prefixOpen])

  const handleCommit = useCallback(async (alsoPush: boolean) => {
    if (!message.trim() || (stagedCount === 0 && !amend)) return
    setBusy(true)
    try {
      const ok = await onCommit(message.trim(), amend, { signoff: signOff, gpg })
      if (ok) {
        setMessage('')
        localStorage.removeItem(draftKey(directory, branch))
        setBannerOpen(true)
        setTimeout(() => setBannerOpen(false), 10000)
        if (alsoPush) onPush()
      }
    } finally {
      setBusy(false)
    }
  }, [message, stagedCount, amend, signOff, gpg, onCommit, onPush, directory, branch])

  const undoCommit = useCallback(async () => {
    try {
      const head = (await window.ion.gitGraph(directory, 0, 2)).commits[1]?.fullHash
      if (head) {
        await window.ion.gitReset(directory, head, 'soft')
        setBannerOpen(false)
      }
    } catch {}
  }, [directory])

  const insertPrefix = (prefix: string) => {
    setMessage((m) => (m.startsWith(prefix + ':') ? m : `${prefix}: ${m}`))
    setPrefixOpen(false)
    setTimeout(() => taRef.current?.focus(), 0)
  }

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleCommit(primary === 'commit-push')
    }
  }, [handleCommit, primary])

  const subjectLen = (message.split('\n')[0] || '').length
  const canCommit = message.trim().length > 0 && (stagedCount > 0 || amend) && !busy
  const overLimit = subjectLen > 50
  const farOver = subjectLen > 72

  // Commit button label
  const primaryLabel = primary === 'commit-push' ? 'Commit & Push' : 'Commit'
  const buttonLabel = amend ? `${primaryLabel} (amend)` : primaryLabel

  // Active toggle indicators
  const hasToggles = amend || signOff || gpg

  return (
    <div style={{ flexShrink: 0, borderBottom: `1px solid ${colors.containerBorder}`, background: colors.surfacePrimary, padding: '3px 8px' }}>
      {/* Single-row layout: [cc:▾] [textarea] [char count] [commit▾] */}
      <div className="flex items-center gap-1">
        {/* CC prefix dropdown */}
        <div ref={prefixRef} style={{ position: 'relative', flexShrink: 0 }}>
          <button
            onClick={() => setPrefixOpen(v => !v)}
            className="text-[9px] rounded flex items-center gap-px"
            style={{
              color: colors.textTertiary,
              background: 'transparent',
              padding: '2px 3px',
              lineHeight: 1,
            }}
          >
            cc:<CaretDown size={7} weight="bold" />
          </button>
          {prefixOpen && (
            <div
              className="absolute left-0 mt-1 rounded shadow text-[10px]"
              style={{
                background: colors.popoverBg,
                border: `1px solid ${colors.popoverBorder}`,
                boxShadow: colors.popoverShadow,
                backdropFilter: 'blur(12px)',
                zIndex: 10,
                minWidth: 80,
              }}
            >
              {prefixes.map(p => (
                <button
                  key={p}
                  onClick={() => insertPrefix(p)}
                  className="block w-full text-left px-2 py-0.5 hover:opacity-80"
                  style={{ color: colors.textSecondary }}
                >
                  {p}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Textarea */}
        <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
          <textarea
            ref={taRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            onClick={(e) => e.stopPropagation()}
            placeholder="Commit message…"
            className="bg-transparent outline-none rounded w-full resize-none"
            style={{
              color: colors.textPrimary,
              border: `1px solid ${colors.containerBorder}`,
              padding: '2px 6px',
              minHeight: 20,
              maxHeight: 120,
              fontSize: 9,
              lineHeight: '12px',
              fontFamily: 'var(--font-mono, monospace)',
              backgroundImage: 'linear-gradient(to right, transparent calc(50ch + 6px), rgba(212,168,67,0.12) calc(50ch + 6px) calc(50ch + 6px + 1px), transparent calc(50ch + 6px + 1px), transparent calc(72ch + 6px), rgba(196,112,96,0.16) calc(72ch + 6px) calc(72ch + 6px + 1px), transparent calc(72ch + 6px + 1px))',
              backgroundRepeat: 'no-repeat',
            }}
          />
          {/* Character count overlay */}
          {subjectLen > 0 && (
            <span
              className="text-[8px]"
              style={{
                position: 'absolute',
                right: 4,
                bottom: 2,
                color: farOver ? '#c47060' : overLimit ? '#d4a843' : colors.textMuted,
                pointerEvents: 'none',
                lineHeight: 1,
              }}
            >
              {subjectLen}
            </span>
          )}
        </div>

        {/* Commit combo button */}
        <div ref={menuRef} className="flex items-center flex-shrink-0" style={{ position: 'relative' }}>
          <button
            onClick={() => handleCommit(primary === 'commit-push')}
            disabled={!canCommit}
            className="flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded-l"
            style={{
              color: canCommit ? '#fff' : colors.textTertiary,
              background: canCommit ? colors.accent : 'transparent',
              border: canCommit ? 'none' : `1px solid ${colors.containerBorder}`,
              cursor: canCommit ? 'pointer' : 'not-allowed',
              fontWeight: 500,
              height: 20,
            }}
          >
            <Check size={10} weight="bold" />
            {hasToggles && <span style={{ width: 4, height: 4, borderRadius: '50%', background: '#fff', opacity: 0.7, flexShrink: 0 }} />}
          </button>
          <button
            onClick={() => setMenuOpen(v => !v)}
            className="text-[9px] px-0.5 py-0.5 rounded-r"
            style={{
              color: canCommit ? '#fff' : colors.textTertiary,
              background: canCommit ? colors.accent : 'transparent',
              borderLeft: canCommit ? '1px solid rgba(255,255,255,0.2)' : `1px solid ${colors.containerBorder}`,
              borderTop: canCommit ? 'none' : `1px solid ${colors.containerBorder}`,
              borderRight: canCommit ? 'none' : `1px solid ${colors.containerBorder}`,
              borderBottom: canCommit ? 'none' : `1px solid ${colors.containerBorder}`,
              cursor: 'pointer',
              height: 20,
            }}
          >
            <CaretDown size={8} weight="bold" />
          </button>

          {/* Dropdown menu */}
          {menuOpen && (
            <div
              className="absolute right-0 mt-1 rounded shadow text-[10px]"
              style={{
                top: '100%',
                background: colors.popoverBg,
                border: `1px solid ${colors.popoverBorder}`,
                boxShadow: colors.popoverShadow,
                backdropFilter: 'blur(12px)',
                zIndex: 10,
                minWidth: 160,
              }}
            >
              {/* Commit / Commit & Push toggle */}
              <button
                onClick={() => { setPrimary(primary === 'commit' ? 'commit-push' : 'commit'); setMenuOpen(false) }}
                className="flex items-center justify-between w-full px-2 py-1 hover:opacity-80"
                style={{ color: colors.textSecondary }}
              >
                <span>{primary === 'commit' ? 'Commit & Push' : 'Commit'}</span>
                <span className="text-[8px]" style={{ color: colors.textMuted }}>switch</span>
              </button>

              <div style={{ height: 1, background: colors.popoverBorder, margin: '2px 0' }} />

              {/* Amend toggle */}
              <button
                onClick={() => { setAmend(!amend); setMenuOpen(false) }}
                className="flex items-center gap-1.5 w-full px-2 py-1 hover:opacity-80"
                style={{ color: amend ? colors.accent : colors.textSecondary }}
              >
                <span style={{ width: 12, textAlign: 'center' }}>{amend ? '✓' : ''}</span>
                Amend
              </button>

              {/* Sign-off toggle */}
              <button
                onClick={() => { setSignOff(!signOff); setMenuOpen(false) }}
                className="flex items-center gap-1.5 w-full px-2 py-1 hover:opacity-80"
                style={{ color: signOff ? colors.accent : colors.textSecondary }}
              >
                <span style={{ width: 12, textAlign: 'center' }}>{signOff ? '✓' : ''}</span>
                Sign-off
              </button>

              {/* GPG toggle */}
              <button
                onClick={() => { setGpg(!gpg); setMenuOpen(false) }}
                className="flex items-center gap-1.5 w-full px-2 py-1 hover:opacity-80"
                style={{ color: gpg ? colors.accent : colors.textSecondary }}
              >
                <span style={{ width: 12, textAlign: 'center' }}>{gpg ? '✓' : ''}</span>
                GPG sign
              </button>

              <div style={{ height: 1, background: colors.popoverBorder, margin: '2px 0' }} />

              {/* AI commit (action, not toggle) */}
              <button
                onClick={() => { setMenuOpen(false); onQuickCommit() }}
                className="flex items-center gap-1.5 w-full px-2 py-1 hover:opacity-80"
                style={{ color: colors.textSecondary }}
              >
                <Robot size={11} />
                AI commit message
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Post-commit banner */}
      {bannerOpen && (
        <div className="flex items-center gap-2 mt-1 text-[9px]" style={{ color: colors.accent }}>
          <span>✓ Committed</span>
          <button onClick={onPush} className="underline" style={{ color: colors.accent }}>Push</button>
          <button onClick={undoCommit} className="flex items-center gap-0.5" style={{ color: '#c47060' }}>
            <ArrowCounterClockwise size={9} /> Undo
          </button>
          <button onClick={() => setBannerOpen(false)} style={{ color: colors.textTertiary }}>Dismiss</button>
        </div>
      )}
    </div>
  )
}
