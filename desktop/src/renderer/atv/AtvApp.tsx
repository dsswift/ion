/**
 * ATV shell: loads settings and the active theme pack, hosts the canvas, and
 * drives the simulation engine off the live agent cache. React renders only
 * the chrome (toolbar, error/empty states) — all 30Hz simulation state lives
 * in the imperative engine outside the component tree.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { rError, rInfo } from '../rendererLogger'
import { darkColors } from '../theme-tokens'
import type { AtvSettings, AtvThemeListEntry } from '../../shared/types-atv'
import { createAtvEngine, type AtvEngine } from './engine'
import { loadTheme, ipcAssetSource, type LoadedTheme } from './theme/loader'
import { AgentCache, type AtvActiveState } from './state/agent-cache'
import { persistSeed, resolveSeed } from './state/seed'
import { AtvToolbar } from './AtvToolbar'
import { AtvReplayBar } from './AtvReplayBar'
import { AtvCampus } from './AtvCampus'
import { AtvSoundEngine } from './sound/sound-engine'
import { clipRemaining, type ClipState } from './export/clip'
import { useAtvControlsBus } from './state/controls-bus'
import { useAtvExports } from './useAtvExports'

type Phase = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string }

interface Tooltip {
  x: number
  y: number
  title: string
  lines: string[]
}

/** Humanize seconds: 42s, 3m 12s, 1h 4m. */
function humanDuration(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return ''
  if (secs < 60) return `${Math.round(secs)}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
}

export interface AtvAppProps {
  /**
   * Shell hook: agent clicked on the canvas. When provided, the shell owns
   * the interaction (inspector dock); the desktop-surfacing fallback stays
   * available from the inspector's "Open in desktop" button. Manager clicks
   * pass '__manager__'.
   */
  onAgentClick?(tabId: string, agentName: string): void
  /** Conversation-dock toggle state (rendered as a toolbar button). */
  dockOpen?: boolean
  onToggleDock?(): void
}

export function AtvApp({ onAgentClick, dockOpen, onToggleDock }: AtvAppProps = {}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const engineRef = useRef<AtvEngine | null>(null)
  const themeRef = useRef<LoadedTheme | null>(null)
  const cacheRef = useRef<AgentCache | null>(null)
  const settingsRef = useRef<AtvSettings | null>(null)
  const activeRef = useRef<AtvActiveState | null>(null)

  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [themes, setThemes] = useState<AtvThemeListEntry[]>([])
  const [tabLabel, setTabLabel] = useState('no active tab')
  const [seed, setSeed] = useState('')
  const [zoom, setZoomState] = useState(0)
  const [problems, setProblems] = useState<string[]>([])
  const [heatOn, setHeatOn] = useState(false)
  const [replaying, setReplaying] = useState(false)
  const [campus, setCampus] = useState(false)
  const [soundOn, setSoundOn] = useState(false)
  const soundRef = useRef(new AtvSoundEngine())
  const [clip, setClip] = useState<ClipState>({ kind: 'idle' })
  const [tooltip, setTooltip] = useState<Tooltip | null>(null)
  const [, setActiveTabId] = useState<string | null>(null)
  const dragRef = useRef<{ x: number; y: number } | null>(null)

  /** Push live dashboard data (kanban statuses, cost sparkline) to the canvas. */
  const refreshDashboards = useCallback(() => {
    const engine = engineRef.current
    const active = activeRef.current
    if (!engine || !active) return
    const stats = cacheRef.current?.statsFor(active.tabId)
    const statuses = active.agents.flatMap((a) =>
      (((a.metadata ?? {}) as Record<string, unknown>).dispatches as Array<{ status?: string }> | undefined ?? []).map(
        (d) => String(d.status ?? 'pending'),
      ),
    )
    engine.setDashboardData({
      dispatchStatuses: statuses,
      sparkline: stats ? stats.samples.map((sm) => sm.conversationCostUsd) : [],
      conversationCostUsd: (active.statusFields as { conversationCostUsd?: number } | null)?.conversationCostUsd ?? 0,
    })
  }, [])

  // Postcard/clip export callbacks — extracted to useAtvExports.ts (file cap).
  const { recordClip, exportPostcard } = useAtvExports({ canvasRef, activeRef, cacheRef, seed, clip, setClip })

  /** (Re)build the office for the current active tab. */
  const rebuildScene = useCallback((state: AtvActiveState | null) => {
    const engine = engineRef.current
    const settings = settingsRef.current
    if (!engine || !settings) return
    activeRef.current = state
    setActiveTabId(state?.tabId ?? null)
    if (!state) {
      setTabLabel('no active tab')
      return
    }
    const effectiveSeed = resolveSeed(settings.atvSeed)
    setSeed(effectiveSeed)
    setTabLabel(`${state.profileId ?? 'local'} · ${state.tabId.slice(0, 8)}`)
    engine.setScene(effectiveSeed, state.agents, state.events)
    refreshDashboards()
    const sceneProblems = [...engine.getSceneErrors(), ...(themeRef.current?.skipped ?? [])]
    setProblems(sceneProblems)
    rInfo('atv', 'scene built', {
      tab_id: state.tabId,
      seed: effectiveSeed,
      agent_count: state.agents.length,
      problems: sceneProblems.length,
    })
  }, [refreshDashboards])

  // Boot: settings → theme list → active theme → engine → cache.
  useEffect(() => {
    let disposed = false
    const cache = new AgentCache()
    cacheRef.current = cache

    async function boot(): Promise<void> {
      const settings = await window.ion.atvGetSettings()
      const themeList = await window.ion.atvListThemes()
      if (disposed) return
      settingsRef.current = settings
      setThemes(themeList)
      setZoomState(settings.atvZoom)

      const themeId = themeList.some((t) => t.id === settings.atvTheme)
        ? settings.atvTheme
        : (themeList[0]?.id ?? 'ion-works')
      const theme = await loadTheme(ipcAssetSource(), themeId, {
        logWarn: (msg, fields) => rError('atv', msg, fields),
      })
      if (disposed) return
      themeRef.current = theme

      const canvas = canvasRef.current
      if (!canvas) throw new Error('canvas missing at boot')
      const engine = createAtvEngine(canvas, theme)
      // atvZoom 0 = fit-to-window (the engine's default); 1..6 = manual.
      if (settings.atvZoom >= 1) engine.setZoom(settings.atvZoom)
      if (settings.atvHeat) {
        engine.setHeatOverlay(true)
        setHeatOn(true)
      }
      if (settings.atvSound) {
        // Enabled flag only — the AudioContext constructs lazily on the
        // first audible intent after a user gesture (autoplay policy).
        soundRef.current.enabled = true
        setSoundOn(true)
      }
      engineRef.current = engine
      setPhase({ kind: 'ready' })

      cache.start({
        onRetarget: (state) => rebuildScene(state),
        onSnapshot: (agents) => {
          if (activeRef.current) activeRef.current = { ...activeRef.current, agents }
          refreshDashboards()
          const intents = engineRef.current?.pushSnapshot(agents) ?? []
          soundRef.current.handleIntents(intents)
          // Status transitions are the visualization's heartbeat — log every
          // batch that produced motion so a "nothing moved" report is
          // diagnosable from desktop.jsonl alone.
          if (intents.length > 0) {
            rInfo('atv', 'snapshot intents', {
              count: intents.length,
              intents: intents.map((i) => ('agent' in i ? `${i.kind}:${i.agent}` : i.kind)).join(','),
            })
          }
        },
        onEvents: (events) => {
          const intents = engineRef.current?.pushEvents(events) ?? []
          soundRef.current.handleIntents(intents)
          if (intents.length > 0 && intents.some((i) => i.kind !== 'agent-activity')) {
            rInfo('atv', 'event intents', {
              count: intents.length,
              intents: intents.map((i) => ('agent' in i ? `${i.kind}:${i.agent}` : i.kind)).join(','),
            })
          }
        },
      })
    }

    boot().catch((err) => {
      rError('atv', 'boot failed', { error: String(err) })
      if (!disposed) setPhase({ kind: 'error', message: String(err) })
    })

    return () => {
      disposed = true
      cache.stop()
      engineRef.current?.destroy()
      engineRef.current = null
    }
  }, [rebuildScene, refreshDashboards])

  // Keep the canvas backing store matched to its layout size.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let rafId = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        canvas.width = canvas.clientWidth
        canvas.height = canvas.clientHeight
      })
    })
    observer.observe(canvas)
    return () => { cancelAnimationFrame(rafId); observer.disconnect() }
  }, [phase.kind])

  const onApplySeed = useCallback((newSeed: string) => {
    const settings = settingsRef.current
    if (!settings) return
    // One office for the whole desktop: the seed applies everywhere.
    void persistSeed(newSeed).then(() => {
      settings.atvSeed = newSeed.trim()
      rebuildScene(activeRef.current)
    })
  }, [rebuildScene])

  const onResetSeed = useCallback(() => onApplySeed(''), [onApplySeed])

  const onZoom = useCallback((delta: number) => {
    setZoomState((prev) => {
      // Stepping from fit mode starts at the fit zoom's effective factor.
      const base = prev === 0 ? Math.max(1, Math.round(engineRef.current?.getView().zoom ?? 1)) : prev
      const next = Math.max(1, Math.min(6, base + delta))
      engineRef.current?.setZoom(next)
      void window.ion.atvSetSetting('atvZoom', next)
      return next
    })
  }, [])

  const onZoomFit = useCallback(() => {
    engineRef.current?.zoomToFit()
    setZoomState(0)
    void window.ion.atvSetSetting('atvZoom', 0)
  }, [])

  // Canvas interactions: drag to pan (manual zoom), hover for agent info.
  const onCanvasMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    dragRef.current = { x: e.clientX, y: e.clientY }
  }, [])

  const onCanvasMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const engine = engineRef.current
    if (!engine) return
    if (dragRef.current && e.buttons === 1) {
      const dx = e.clientX - dragRef.current.x
      const dy = e.clientY - dragRef.current.y
      dragRef.current = { x: e.clientX, y: e.clientY }
      engine.panBy(dx, dy)
      // Panning leaves fit mode; reflect the engine's view in the toolbar.
      const view = engine.getView()
      setZoomState((prev) => (prev === view.zoom ? prev : view.zoom))
      setTooltip(null)
      return
    }
    const entity = engine.getEntityAt(e.nativeEvent.offsetX, e.nativeEvent.offsetY)
    if (!entity) {
      // No character under the cursor: label the room or desk instead so the
      // office itself is legible (whose department, whose workstation).
      const spot = engine.getSpotAt(e.nativeEvent.offsetX, e.nativeEvent.offsetY)
      if (spot) {
        setTooltip({ x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY, title: spot.title, lines: spot.lines })
      } else {
        setTooltip(null)
      }
      return
    }
    // What an operator wants at a glance: who, role/team, live status with
    // human durations, the current tool, the task, and the spend.
    const agent = activeRef.current?.agents.find((a) => a.name === entity.name)
    const lines: string[] = []
    if (entity.role === 'pet') {
      lines.push('office pet')
    } else if (entity.name === '__manager__') {
      lines.push(`orchestrator — ${activeRef.current?.statusFields?.state ?? 'idle'}`)
      const sf = activeRef.current?.statusFields as { runCostUsd?: number; conversationCostUsd?: number } | null
      if (sf?.runCostUsd) lines.push(`run $${sf.runCostUsd.toFixed(2)}`)
      if (sf?.conversationCostUsd) lines.push(`conversation $${sf.conversationCostUsd.toFixed(2)}`)
    } else {
      const md = (agent?.metadata ?? {}) as Record<string, unknown>
      const status = agent?.status ?? 'idle'
      const elapsed = typeof md.elapsed === 'number' ? humanDuration(md.elapsed) : ''
      if (status === 'running') {
        lines.push(`${entity.role} — working${elapsed ? ` for ${elapsed}` : ''}`)
        if (entity.activity) lines.push(`using ${entity.activity}`)
      } else if (status === 'done') {
        lines.push(`${entity.role} — done${elapsed ? ` in ${elapsed}` : ''}`)
      } else if (entity.waiting) {
        lines.push(`${entity.role} — waiting on team`)
      } else {
        lines.push(`${entity.role} — ${status}`)
      }
      const task = typeof md.task === 'string' ? md.task : ''
      if (task) lines.push(task.length > 90 ? `${task.slice(0, 90)}…` : task)
      const lastWork = typeof md.lastWork === 'string' ? md.lastWork : ''
      if (!task && lastWork) lines.push(lastWork.length > 90 ? `${lastWork.slice(0, 90)}…` : lastWork)
      // Odometer: lifetime totals for this agent (deduped dispatch_end sums).
      const totals = activeRef.current ? cacheRef.current?.statsFor(activeRef.current.tabId).totalsFor(entity.name) : null
      if (totals && totals.dispatches > 0) {
        const tok = totals.inputTokens + totals.outputTokens > 0
          ? ` · ${(totals.inputTokens / 1000).toFixed(1)}k in / ${(totals.outputTokens / 1000).toFixed(1)}k out`
          : ''
        lines.push(`$${totals.costUsd.toFixed(2)}${tok} · ${totals.dispatches} dispatch${totals.dispatches === 1 ? '' : 'es'}`)
      } else {
        const cost = typeof md.cost === 'number' && md.cost > 0 ? `$${md.cost.toFixed(2)}` : ''
        if (cost) lines.push(cost)
      }
      if (entity.completed || status === 'running') lines.push('click to open dispatch')
    }
    setTooltip({
      x: e.nativeEvent.offsetX,
      y: e.nativeEvent.offsetY,
      title: entity.name === '__manager__' ? 'Manager' : entity.displayName,
      lines,
    })
  }, [])

  // Click (without drag): open the agent's dispatch detail in the desktop.
  const onCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const engine = engineRef.current
    const active = activeRef.current
    if (!engine || !active) return
    const entity = engine.getEntityAt(e.nativeEvent.offsetX, e.nativeEvent.offsetY)
    if (!entity || entity.role === 'pet') return
    // The manager = the orchestrator = the main conversation: clicking him
    // shows the desktop on that conversation (no dispatch panel).
    if (entity.name === '__manager__') {
      rInfo('atv', 'manager clicked', { tab_id: active.tabId })
      if (onAgentClick) onAgentClick(active.tabId, '__manager__')
      else window.ion.atvFocusAgent(active.tabId, '__orchestrator__')
      return
    }
    // Shift+click: follow-cam / focus-mode cycle (game-feel camera).
    if (e.shiftKey) {
      const mode = engine.cycleFollow(entity.name)
      rInfo('atv', 'follow cycled', { agent: entity.name, mode })
      return
    }
    if (!entity.working && !entity.completed && !entity.waiting) return
    rInfo('atv', 'agent clicked', { agent: entity.name, tab_id: active.tabId })
    if (onAgentClick) onAgentClick(active.tabId, entity.name)
    else window.ion.atvFocusAgent(active.tabId, entity.name)
  }, [onAgentClick])

  const onCanvasMouseUp = useCallback(() => {
    dragRef.current = null
  }, [])

  const onToggleSound = useCallback(() => {
    setSoundOn((prev) => {
      const next = !prev
      soundRef.current.enabled = next
      void window.ion.atvSetSetting('atvSound', next)
      return next
    })
  }, [])

  const onSelectTheme = useCallback((id: string) => {
    void window.ion.atvSetSetting('atvTheme', id).then(async () => {
      // Full theme swap: reload the pack and rebuild the scene against it.
      try {
        const theme = await loadTheme(ipcAssetSource(), id, {
          logWarn: (msg, fields) => rError('atv', msg, fields),
        })
        themeRef.current = theme
        engineRef.current?.destroy()
        const canvas = canvasRef.current
        if (!canvas) return
        const engine = createAtvEngine(canvas, theme)
        engine.setZoom(zoom)
        engineRef.current = engine
        if (settingsRef.current) settingsRef.current.atvTheme = id
        rebuildScene(activeRef.current)
      } catch (err) {
        rError('atv', 'theme swap failed', { theme_id: id, error: String(err) })
        setPhase({ kind: 'error', message: String(err) })
      }
    })
  }, [rebuildScene, zoom])

  // Publish window-level controls (sound, seed, theme) to the controls bus —
  // the TabStrip's ATV button popover (AtvControlsPopover) renders them.
  useEffect(() => {
    useAtvControlsBus.getState().publish({
      seed,
      tabLabel,
      soundOn,
      themes,
      activeThemeId: settingsRef.current?.atvTheme ?? 'ion-works',
      actions: { toggleSound: onToggleSound, applySeed: onApplySeed, resetSeed: onResetSeed, selectTheme: onSelectTheme },
    })
  }, [seed, tabLabel, soundOn, themes, onToggleSound, onApplySeed, onResetSeed, onSelectTheme])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
      {phase.kind === 'ready' && (
        <AtvToolbar
          dockOpen={dockOpen ?? false}
          onToggleDock={onToggleDock ?? (() => {})}
          campus={campus}
          onToggleCampus={() => setCampus((v) => !v)}
          replaying={replaying}
          onToggleReplay={() => {
            const engine = engineRef.current
            const recorder = cacheRef.current?.recorder
            if (!engine || !recorder) return
            if (replaying) {
              engine.stopReplay()
              setReplaying(false)
              // Live truth returns immediately from the cache.
              rebuildScene(cacheRef.current?.getActive() ?? null)
            } else if (recorder.frames.length > 1) {
              engine.startReplay([...recorder.frames])
              setReplaying(true)
            }
          }}
          onExportPostcard={() => void exportPostcard()}
          clipSecondsLeft={clip.kind === 'recording' ? Math.ceil(clipRemaining(clip, performance.now())) : clip.kind === 'saving' ? -1 : 0}
          onRecordClip={recordClip}
          heatOn={heatOn}
          onToggleHeat={() => {
            const next = !heatOn
            setHeatOn(next)
            engineRef.current?.setHeatOverlay(next)
            void window.ion.atvSetSetting('atvHeat', next)
          }}
          zoom={zoom}
          problems={problems}
          onZoom={onZoom}
          onZoomFit={onZoomFit}
        />
      )}
      {/* minHeight: 0 + overflow: hidden + an absolutely positioned canvas —
          all three are load-bearing. A canvas is a replaced element: its
          backing-store height (set from clientHeight by the ResizeObserver)
          becomes its flex MIN-CONTENT size, so an in-flow canvas can never
          shrink again — the pane overflowed the shell column and painted
          over the status bar, and the grow-measure-grow feedback produced
          the "ResizeObserver loop" error storms. Absolute positioning takes
          the canvas out of layout entirely; overflow: hidden is the backstop
          so nothing in this pane can ever paint outside it. */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
        <canvas
          ref={canvasRef}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', cursor: zoom === 0 ? 'default' : 'grab' }}
          onWheel={(e) => {
            const engine = engineRef.current
            if (!engine) return
            engine.wheelZoom(e.nativeEvent.offsetX, e.nativeEvent.offsetY, e.deltaY < 0 ? 1 : -1)
            const view = engine.getView()
            setZoomState((prev) => (prev === view.zoom ? prev : view.zoom))
          }}
          onMouseDown={onCanvasMouseDown}
          onMouseMove={onCanvasMouseMove}
          onMouseUp={onCanvasMouseUp}
          onClick={onCanvasClick}
          onMouseLeave={() => {
            dragRef.current = null
            setTooltip(null)
          }}
        />
        {campus && (
          <AtvCampus
            seed={seed}
            onSelect={(tabId) => {
              window.ion.atvFocusTab(tabId)
              setCampus(false)
            }}
            onExit={() => setCampus(false)}
          />
        )}
        {replaying && engineRef.current && (
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
            <AtvReplayBar
              engine={engineRef.current}
              onExit={() => {
                engineRef.current?.stopReplay()
                setReplaying(false)
                rebuildScene(cacheRef.current?.getActive() ?? null)
              }}
            />
          </div>
        )}
        {tooltip && (
          <div
            style={{
              position: 'absolute',
              left: Math.min(tooltip.x + 12, (canvasRef.current?.clientWidth ?? 300) - 180),
              top: Math.max(tooltip.y - 44, 4),
              background: darkColors.containerBg,
              border: `1px solid ${darkColors.containerBorder}`,
              borderRadius: 6,
              padding: '4px 8px',
              pointerEvents: 'none',
              fontFamily: 'system-ui, sans-serif',
              fontSize: 11,
              color: darkColors.textPrimary,
              maxWidth: 220,
              zIndex: 10,
            }}
          >
            <div style={{ fontWeight: 600 }}>{tooltip.title}</div>
            {tooltip.lines.map((line, i) => (
              <div key={i} style={{ color: darkColors.textTertiary }}>{line}</div>
            ))}
          </div>
        )}
        {phase.kind !== 'ready' && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: darkColors.textTertiary,
              fontFamily: 'system-ui, sans-serif',
              fontSize: 13,
              padding: 24,
              textAlign: 'center',
            }}
          >
            {phase.kind === 'loading' ? 'Loading theme…' : `Theme failed to load: ${phase.message}`}
          </div>
        )}
      </div>
    </div>
  )
}
