import { describe, it, expect } from 'vitest'
import { darkColors } from './palette-dark'
import { lightColors } from './palette-light'
import { classicColors } from './palette-classic'
import { hudColors } from './palette-hud'

describe('palette parity', () => {
  it('all four palettes carry the identical key set', () => {
    const darkKeys = Object.keys(darkColors).sort()
    expect(Object.keys(lightColors).sort()).toEqual(darkKeys)
    expect(Object.keys(classicColors).sort()).toEqual(darkKeys)
    expect(Object.keys(hudColors).sort()).toEqual(darkKeys)
  })

  it('every token is a non-empty string in every palette', () => {
    for (const palette of [darkColors, lightColors, classicColors, hudColors]) {
      for (const [key, value] of Object.entries(palette)) {
        expect(typeof value, `${key} must be a string`).toBe('string')
        expect((value as string).length, `${key} must be non-empty`).toBeGreaterThan(0)
      }
    }
  })

  // Running / question status dots must stay legibly distinct from each other
  // and from the accent blue. Ion Dark/Light previously set the running dot to
  // the accent hex and the question dot to a near-identical lighter blue, which
  // read as one color. These pins guard the orange-running / purple-question
  // split. The running value is deliberately shared verbatim across all three
  // built-ins — Ion Classic's terracotta is the canonical "working" hue.
  it('running dot is Classic terracotta in every built-in, decoupled from the accent blue', () => {
    expect(darkColors.statusRunning).toBe('#d97757')
    expect(lightColors.statusRunning).toBe('#d97757')
    expect(classicColors.statusRunning).toBe('#d97757')
    expect(darkColors.statusRunning).not.toBe(darkColors.accent)
    expect(lightColors.statusRunning).not.toBe(lightColors.accent)
  })

  // Warm-hue separation in the tab-dot cascade. With running on terracotta,
  // the dots that sit next to it in the priority order must not collapse into
  // one warm smear: "working", "blocked on you", and "dead" have to stay three
  // readable signals. Classic intentionally shares one terracotta between
  // running and permission (its whole palette is earthy and it predates this
  // split), so it is exempt from the permission clause.
  it('running stays distinct from the permission and error dots', () => {
    for (const [name, palette] of Object.entries({ dark: darkColors, light: lightColors })) {
      const p = palette as Record<string, string>
      expect(p.statusRunning, `${name}: running vs permission`).not.toBe(p.statusPermission)
      expect(p.statusRunning, `${name}: running vs error`).not.toBe(p.statusError)
      expect(p.statusRunning, `${name}: running vs waiting-children`).not.toBe(
        p.statusWaitingChildren,
      )
    }
  })

  it('question dot has a dedicated purple token, independent of the shared infoText blue', () => {
    expect(darkColors.statusQuestion).toBe('#A78BFA')
    expect(darkColors.statusQuestion).not.toBe(darkColors.infoText)
    expect(darkColors.statusQuestion).not.toBe(darkColors.statusRunning)
    expect(lightColors.statusQuestion).toBe('#7C3AED')
    expect(lightColors.statusQuestion).not.toBe(lightColors.infoText)
    expect(lightColors.statusQuestion).not.toBe(lightColors.statusRunning)
  })

  // The shell-activity dot (statusBash) fires when a shell is executing in a
  // tab — a user-typed `!` command or an agent's background command. It must
  // never be confusable with the error dot: error is the top-priority state in
  // the cascade, so a "your build is running" pink that reads as red is an
  // actively misleading signal. It must also stay distinct from the question
  // dot, which sits adjacent in the priority order.
  it('shell dot is distinct from the error and question dots in every palette', () => {
    for (const [name, palette] of Object.entries({
      dark: darkColors,
      light: lightColors,
      classic: classicColors,
      hud: hudColors,
    })) {
      const p = palette as Record<string, string>
      expect(p.statusBash, `${name}: statusBash must differ from statusError`).not.toBe(p.statusError)
      expect(p.statusBash, `${name}: statusBash must differ from statusDead`).not.toBe(p.statusDead)
      expect(p.statusBash, `${name}: statusBash must differ from statusQuestion`).not.toBe(
        p.statusQuestion,
      )
      expect(p.statusBash, `${name}: statusBash must differ from statusPermission`).not.toBe(
        p.statusPermission,
      )
      expect(
        p.statusBash,
        `${name}: statusBash must differ from statusWaitingChildren`,
      ).not.toBe(p.statusWaitingChildren)
    }
  })

  // Each palette tunes the shell dot for its own surface: blaze on the dark
  // themes, deepened on light, saturated-but-restrained in Classic's earthy
  // register. Pinning the values keeps a future palette edit from drifting one
  // theme back toward the washed-out mauve (#cc6b9a) that Classic and HUD
  // previously shared, or toward the error red.
  it('shell dot is tuned per theme', () => {
    expect(darkColors.statusBash).toBe('#ff2d95')
    expect(hudColors.statusBash).toBe('#ff2d95')
    expect(lightColors.statusBash).toBe('#e6007a')
    expect(classicColors.statusBash).toBe('#e0559b')
  })


  it('inline-code chip is neutral, decoupled from the accent tint', () => {
    for (const palette of [darkColors, lightColors, classicColors, hudColors]) {
      const p = palette as Record<string, string>
      expect(typeof p.inlineCodeBg).toBe('string')
      expect(p.inlineCodeBg).not.toBe(p.accent)
      expect(p.inlineCodeBg).not.toBe(p.accentLight)
    }
  })
})

// Classic-era values historically shared by the HUD (inherited pre-freeze)
// and preserved verbatim by Ion Classic. Used by both freeze suites below.
const frozenFormerlyInheritedRef: Record<string, string> = {}

describe('Jarvis HUD freeze', () => {
  // The HUD palette is fully self-contained (no spread of another palette),
  // so edits to Ion Dark can never change the HUD look. This freeze pins the
  // values that were historically inherited from the dark palette — the exact
  // keys that would silently shift if someone reintroduced a spread or
  // "helpfully" synced HUD to a dark-palette change. A failure here means an
  // intentional HUD redesign; update the pins only in that case.
  const frozenFormerlyInherited: Record<string, string> = {
    cardShadow: '0 2px 8px rgba(0,0,0,0.35)',
    cardShadowCollapsed: '0 2px 6px rgba(0,0,0,0.4)',
    statusIdle: '#8a8a80',
    statusCompacting: '#60a5fa',
    statusCompactingBg: 'rgba(96, 165, 250, 0.1)',
    statusComplete: '#7aac8c',
    statusCompleteBg: 'rgba(122, 172, 140, 0.1)',
    statusError: '#c47060',
    statusErrorBg: 'rgba(196, 112, 96, 0.08)',
    statusWarning: '#f59e0b',
    statusDead: '#c47060',
    // statusBash / statusBashGlow are deliberately NOT frozen here. This map
    // pins values HUD and Classic share; the shell dot is now tuned per theme
    // (blaze #ff2d95 on the dark HUD surface, a restrained #e0559b in
    // Classic's earthy register), so a shared pin would be wrong for one of
    // them. Both are pinned individually by the "shell dot is tuned per theme"
    // test above, which is the stronger guard.
    statusPermission: '#d97757',
    statusPermissionGlow: 'rgba(217, 119, 87, 0.4)',
    statusWaitingChildren: '#f59e0b',
    statusWaitingChildrenGlow: 'rgba(245, 158, 11, 0.4)',
    timelineLine: '#353530',
    timelineNode: 'rgba(217, 119, 87, 0.2)',
    timelineNodeActive: '#d97757',
    stopBg: '#ef4444',
    stopHover: '#dc2626',
    codeBg: '#1a1a18',
    micBg: '#353530',
    micColor: '#c0bdb2',
    micDisabled: '#42423d',
    btnDisabled: '#42423d',
    textOnAccent: '#ffffff',
    btnHoverColor: '#c0bdb2',
    btnHoverBg: '#302f2d',
    permissionBorder: 'rgba(245, 158, 11, 0.3)',
    permissionShadow: '0 2px 12px rgba(245, 158, 11, 0.08)',
    permissionHeaderBg: 'rgba(245, 158, 11, 0.06)',
    permissionHeaderBorder: 'rgba(245, 158, 11, 0.12)',
    permissionAllowBg: 'rgba(34, 197, 94, 0.1)',
    permissionAllowHoverBg: 'rgba(34, 197, 94, 0.22)',
    permissionAllowBorder: 'rgba(34, 197, 94, 0.25)',
    permissionDenyBg: 'rgba(239, 68, 68, 0.08)',
    permissionDenyHoverBg: 'rgba(239, 68, 68, 0.18)',
    permissionDenyBorder: 'rgba(239, 68, 68, 0.22)',
    permissionDeniedBorder: 'rgba(196, 112, 96, 0.3)',
    permissionDeniedHeaderBorder: 'rgba(196, 112, 96, 0.12)',
    infoBg: 'rgba(96, 165, 250, 0.1)',
    infoHoverBg: 'rgba(96, 165, 250, 0.15)',
    infoBorder: 'rgba(96, 165, 250, 0.25)',
    infoText: 'rgba(96, 165, 250, 0.85)',
    infoShadow: 'rgba(96, 165, 250, 0.06)',
    tabGlowPlanReady: 'rgba(122, 172, 140, 0.5)',
    tabGlowPlanReadyShadow: 'rgba(122, 172, 140, 0.25)',
    tabGlowQuestion: 'rgba(96, 165, 250, 0.5)',
    tabGlowQuestionShadow: 'rgba(96, 165, 250, 0.25)',
    worktreeGreen: '#4ade80',
    diffAddBg: 'rgba(122, 172, 140, 0.12)',
    diffAddText: '#7aac8c',
    diffRemoveBg: 'rgba(196, 112, 96, 0.1)',
    diffRemoveText: '#c47060',
    // Tokens introduced for formerly-hardcoded component colors: the HUD
    // values pin what those components rendered before tokenization.
    bashModeRing: 'rgba(244, 114, 182, 0.5)',
    scrim: 'rgba(0, 0, 0, 0.4)',
    gitAdded: '#7aac8c',
    gitModified: '#6b9bd2',
    gitDeleted: '#c47060',
    gitRenamed: '#b08fd8',
    gitUntracked: '#d4a843',
    gitConflict: '#d97757',
    modeThinking: '#8b7fd4',
    modeAcceptEdits: '#2eb8a6',
    iconBlue: '#3b82f6',
    iconYellow: '#eab308',
    iconGreen: '#22c55e',
    iconSky: '#60a5fa',
    iconPurple: '#a855f7',
    iconOrange: '#f97316',
    iconGray: '#9ca3af',
    bubbleCodeBg: 'rgba(0, 0, 0, 0.12)',
    bubblePreBg: 'rgba(0, 0, 0, 0.1)',
    bubblePreBorder: 'rgba(0, 0, 0, 0.1)',
    bubbleThBg: 'rgba(0, 0, 0, 0.08)',
    ansiBlack: '#000',
    ansiRed: '#c23621',
    ansiGreen: '#25bc24',
    ansiYellow: '#adad27',
    ansiBlue: '#492ee1',
    ansiMagenta: '#d338d3',
    ansiCyan: '#33bbc8',
    ansiWhite: '#cbcccd',
    ansiBrightBlack: '#818383',
    ansiBrightRed: '#fc391f',
    ansiBrightGreen: '#31e722',
    ansiBrightYellow: '#eaec23',
    ansiBrightBlue: '#5833ff',
    ansiBrightMagenta: '#f935f8',
    ansiBrightCyan: '#14f0f0',
    ansiBrightWhite: '#e9ebeb',
  }

  Object.assign(frozenFormerlyInheritedRef, frozenFormerlyInherited)

  it('formerly-inherited HUD values stay pinned', () => {
    for (const [key, value] of Object.entries(frozenFormerlyInherited)) {
      expect(hudColors[key as keyof typeof hudColors], `hudColors.${key}`).toBe(value)
    }
  })

  it('HUD signature values stay pinned', () => {
    expect(hudColors.accent).toBe('#33C3F7')
    expect(hudColors.sendBg).toBe('#33C3F7')
    expect(hudColors.statusRunning).toBe('#33C3F7')
    expect(hudColors.containerBg).toBe('rgba(4, 12, 26, 0.96)')
    expect(hudColors.textPrimary).toBe('rgba(190, 235, 255, 0.92)')
  })

  it('Ion Dark / Ion Light carry the blue accent system', () => {
    expect(darkColors.accent).toBe('#366FFB')
    expect(darkColors.focusBorder).toBe('#366FFB')
    expect(darkColors.sendBg).toBe('#366FFB')
    expect(darkColors.inputFocusBorder).toBe('#366FFB')
    expect(lightColors.accent).toBe('#2B5FE8')
    expect(lightColors.focusBorder).toBe('#2B5FE8')
  })

  it('HUD does not alias the dark palette', () => {
    // Guards against reintroducing `{ ...darkColors }` with shared identity
    // or accidental reference equality.
    expect(hudColors).not.toBe(darkColors)
  })
})

describe('Ion Classic freeze', () => {
  // Ion Classic is the preserved original palette. The classic-era values
  // shared with the HUD freeze map above must match it exactly, and its
  // signature warm-scheme values are pinned here. A failure means the
  // classic look drifted — which defeats the theme's purpose.
  it('classic matches the classic-era values pinned in the freeze map', () => {
    expect(Object.keys(frozenFormerlyInheritedRef).length).toBeGreaterThan(50)
    for (const [key, value] of Object.entries(frozenFormerlyInheritedRef)) {
      expect(classicColors[key as keyof typeof classicColors], `classicColors.${key}`).toBe(value)
    }
  })

  it('classic signature values stay pinned', () => {
    expect(classicColors.containerBg).toBe('#242422')
    expect(classicColors.accent).toBe('#d97757')
    expect(classicColors.sendBg).toBe('#d97757')
    expect(classicColors.statusRunning).toBe('#d97757')
    expect(classicColors.textPrimary).toBe('#ccc9c0')
    expect(classicColors.surfacePrimary).toBe('#353530')
    expect(classicColors.inputPillBg).toBe('#2a2a27')
  })

  it('classic does not alias any other palette', () => {
    expect(classicColors).not.toBe(darkColors)
    expect(classicColors).not.toBe(hudColors)
  })
})
