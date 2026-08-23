/**
 * Studio shell: loads settings and the active theme pack, hosts the canvas, and
 * drives the simulation engine off the live agent cache. React renders only
 * the chrome (toolbar, error/empty states) — all 30Hz simulation state lives
 * in the imperative engine outside the component tree.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { rError, rInfo } from "../../rendererLogger";
import type {
  StudioSettings,
  StudioThemeListEntry,
} from "../../../shared/types-studio";
import { createVisualizerEngine, type StudioEngine } from "./engine";
import { loadTheme, ipcAssetSource, type LoadedTheme } from "./theme/loader";
import { AgentCache, type StudioActiveState } from "./state/agent-cache";
import { persistSeed, resolveSeed } from "./state/seed";
import { Toolbar } from "./Toolbar";
import { StudioSoundEngine } from "./sound/sound-engine";
import { clipRemaining, type ClipState } from "./export/clip";
import { useStudioControlsBus } from "../state/controls-bus";
import { useExports } from "./useExports";
import { VisualizerCanvas } from "./VisualizerCanvas";
import { canvasPointFromClient } from "./canvas-coordinates";
import { humanDuration, type Tooltip, type Phase } from "./visualizer-types";

/** Imperative surface-tab handle: pause/resume the render+sim loop (D10). */
export interface VisualizerHandle {
  pause(): void;
  resume(): void;
}

export interface VisualizerRootProps {
  /**
   * Shell hook: agent clicked on the canvas. When provided, the shell owns
   * the interaction (inspector dock); the desktop-surfacing fallback stays
   * available from the inspector's "Open in desktop" button. Manager clicks
   * pass '__manager__'.
   */
  onAgentClick?(tabId: string, agentName: string): void;
  /**
   * Surface-tab host hook: receives pause/resume controls for the engine
   * loop. Event ingestion (AgentCache) is NOT paused — only render/sim.
   */
  handleRef?: React.MutableRefObject<VisualizerHandle | null>;
}

export function VisualizerRoot({
  onAgentClick,
  handleRef,
}: VisualizerRootProps = {}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<StudioEngine | null>(null);
  const themeRef = useRef<LoadedTheme | null>(null);
  const cacheRef = useRef<AgentCache | null>(null);
  const settingsRef = useRef<StudioSettings | null>(null);
  const activeRef = useRef<StudioActiveState | null>(null);

  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [themes, setThemes] = useState<StudioThemeListEntry[]>([]);
  const [tabLabel, setTabLabel] = useState("no active tab");
  const [seed, setSeed] = useState("");
  const [zoom, setZoomState] = useState(0);
  const [problems, setProblems] = useState<string[]>([]);
  const [heatOn, setHeatOn] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [campus, setCampus] = useState(false);
  const [soundOn, setSoundOn] = useState(false);
  const soundRef = useRef(new StudioSoundEngine());
  const [clip, setClip] = useState<ClipState>({ kind: "idle" });
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const [, setActiveTabId] = useState<string | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  /** Push live dashboard data (kanban statuses, cost sparkline) to the canvas. */
  const refreshDashboards = useCallback(() => {
    const engine = engineRef.current;
    const active = activeRef.current;
    if (!engine || !active) return;
    const stats = cacheRef.current?.statsFor(active.tabId);
    const statuses = active.agents.flatMap((a) =>
      (
        (((a.metadata ?? {}) as Record<string, unknown>).dispatches as
          Array<{ status?: string }> | undefined) ?? []
      ).map((d) => String(d.status ?? "pending")),
    );
    engine.setDashboardData({
      dispatchStatuses: statuses,
      sparkline: stats ? stats.samples.map((sm) => sm.conversationCostUsd) : [],
      conversationCostUsd:
        (active.statusFields as { conversationCostUsd?: number } | null)
          ?.conversationCostUsd ?? 0,
    });
  }, []);

  // Postcard/clip export callbacks — extracted to useExports.ts (file cap).
  const { recordClip, exportPostcard } = useExports({
    canvasRef,
    activeRef,
    cacheRef,
    seed,
    clip,
    setClip,
  });

  /** (Re)build the office for the current active tab. */
  const rebuildScene = useCallback(
    (state: StudioActiveState | null) => {
      const engine = engineRef.current;
      const settings = settingsRef.current;
      if (!engine || !settings) return;
      activeRef.current = state;
      setActiveTabId(state?.tabId ?? null);
      if (!state) {
        setTabLabel("no active tab");
        return;
      }
      const effectiveSeed = resolveSeed(settings.studioSeed);
      setSeed(effectiveSeed);
      setTabLabel(`${state.profileId ?? "local"} · ${state.tabId.slice(0, 8)}`);
      engine.setScene(effectiveSeed, state.agents, state.events);
      refreshDashboards();
      const sceneProblems = [
        ...engine.getSceneErrors(),
        ...(themeRef.current?.skipped ?? []),
      ];
      setProblems(sceneProblems);
      rInfo("studio", "scene built", {
        tab_id: state.tabId,
        seed: effectiveSeed,
        agent_count: state.agents.length,
        problems: sceneProblems.length,
      });
    },
    [refreshDashboards],
  );

  // Boot: settings → theme list → active theme → engine → cache.
  useEffect(() => {
    let disposed = false;
    const cache = new AgentCache();
    cacheRef.current = cache;

    async function boot(): Promise<void> {
      const settings = await window.ion.studioGetSettings();
      const themeList = await window.ion.studioListThemes();
      if (disposed) return;
      settingsRef.current = settings;
      setThemes(themeList);
      setZoomState(settings.studioZoom);

      const themeId = themeList.some((t) => t.id === settings.studioTheme)
        ? settings.studioTheme
        : (themeList[0]?.id ?? "ion-works");
      const theme = await loadTheme(ipcAssetSource(), themeId, {
        logWarn: (msg, fields) => rError("studio", msg, fields),
      });
      if (disposed) return;
      themeRef.current = theme;

      const canvas = canvasRef.current;
      if (!canvas) throw new Error("canvas missing at boot");
      const engine = createVisualizerEngine(canvas, theme);
      // studioZoom 0 = fit-to-window (the engine's default); 1..6 = manual.
      if (settings.studioZoom >= 1) engine.setZoom(settings.studioZoom);
      if (settings.studioHeat) {
        engine.setHeatOverlay(true);
        setHeatOn(true);
      }
      if (settings.studioSound) {
        // Enabled flag only — the AudioContext constructs lazily on the
        // first audible intent after a user gesture (autoplay policy).
        soundRef.current.enabled = true;
        setSoundOn(true);
      }
      engineRef.current = engine;
      if (handleRef) {
        handleRef.current = {
          pause: () => engineRef.current?.pause(),
          resume: () => engineRef.current?.resume(),
        };
      }
      setPhase({ kind: "ready" });

      cache.start({
        onRetarget: (state) => rebuildScene(state),
        onSnapshot: (agents) => {
          if (activeRef.current)
            activeRef.current = { ...activeRef.current, agents };
          refreshDashboards();
          const intents = engineRef.current?.pushSnapshot(agents) ?? [];
          soundRef.current.handleIntents(intents);
          // Status transitions are the visualization's heartbeat — log every
          // batch that produced motion so a "nothing moved" report is
          // diagnosable from desktop.jsonl alone.
          if (intents.length > 0) {
            rInfo("studio", "snapshot intents", {
              count: intents.length,
              intents: intents
                .map((i) => ("agent" in i ? `${i.kind}:${i.agent}` : i.kind))
                .join(","),
            });
          }
        },
        onEvents: (events) => {
          const intents = engineRef.current?.pushEvents(events) ?? [];
          soundRef.current.handleIntents(intents);
          if (
            intents.length > 0 &&
            intents.some((i) => i.kind !== "agent-activity")
          ) {
            rInfo("studio", "event intents", {
              count: intents.length,
              intents: intents
                .map((i) => ("agent" in i ? `${i.kind}:${i.agent}` : i.kind))
                .join(","),
            });
          }
        },
      });
    }

    boot().catch((err) => {
      rError("studio", "boot failed", { error: String(err) });
      if (!disposed) setPhase({ kind: "error", message: String(err) });
    });

    return () => {
      disposed = true;
      cache.stop();
      engineRef.current?.destroy();
      engineRef.current = null;
    };
    // handleRef is a stable ref object per host; including it satisfies
    // exhaustive-deps without re-running the boot effect in practice.
  }, [rebuildScene, refreshDashboards, handleRef]);

  // Keep the canvas backing store matched to its layout size.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let rafId = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        canvas.width = canvas.clientWidth;
        canvas.height = canvas.clientHeight;
      });
    });
    observer.observe(canvas);
    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [phase.kind]);

  const onApplySeed = useCallback(
    (newSeed: string) => {
      const settings = settingsRef.current;
      if (!settings) return;
      // One office for the whole desktop: the seed applies everywhere.
      void persistSeed(newSeed).then(() => {
        settings.studioSeed = newSeed.trim();
        rebuildScene(activeRef.current);
      });
    },
    [rebuildScene],
  );

  const onResetSeed = useCallback(() => onApplySeed(""), [onApplySeed]);

  const onZoom = useCallback((delta: number) => {
    setZoomState((prev) => {
      // Stepping from fit mode starts at the fit zoom's effective factor.
      const base =
        prev === 0
          ? Math.max(1, Math.round(engineRef.current?.getView().zoom ?? 1))
          : prev;
      const next = Math.max(1, Math.min(6, base + delta));
      engineRef.current?.setZoom(next);
      void window.ion.studioSetSetting("studioZoom", next);
      return next;
    });
  }, []);

  const onZoomFit = useCallback(() => {
    engineRef.current?.zoomToFit();
    setZoomState(0);
    void window.ion.studioSetSetting("studioZoom", 0);
  }, []);

  // Canvas interactions: drag to pan (manual zoom), hover for agent info.
  const onCanvasMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      dragRef.current = canvasPointFromClient(
        e.currentTarget,
        e.clientX,
        e.clientY,
      );
    },
    [],
  );

  const onCanvasMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const engine = engineRef.current;
      if (!engine) return;
      const point = canvasPointFromClient(
        e.currentTarget,
        e.clientX,
        e.clientY,
      );
      if (dragRef.current && e.buttons === 1) {
        const dx = point.x - dragRef.current.x;
        const dy = point.y - dragRef.current.y;
        dragRef.current = point;
        engine.panBy(dx, dy);
        // Panning leaves fit mode; reflect the engine's view in the toolbar.
        const view = engine.getView();
        setZoomState((prev) => (prev === view.zoom ? prev : view.zoom));
        setTooltip(null);
        return;
      }
      const entity = engine.getEntityAt(point.x, point.y);
      if (!entity) {
        // No character under the cursor: label the room or desk instead so the
        // office itself is legible (whose department, whose workstation).
        const spot = engine.getSpotAt(point.x, point.y);
        if (spot) {
          setTooltip({
            x: point.x,
            y: point.y,
            title: spot.title,
            lines: spot.lines,
          });
        } else {
          setTooltip(null);
        }
        return;
      }
      // What an operator wants at a glance: who, role/team, live status with
      // human durations, the current tool, the task, and the spend.
      const agent = activeRef.current?.agents.find(
        (a) => a.name === entity.name,
      );
      const lines: string[] = [];
      if (entity.role === "pet") {
        lines.push("office pet");
      } else if (entity.name === "__manager__") {
        lines.push(
          `orchestrator — ${activeRef.current?.statusFields?.state ?? "idle"}`,
        );
        const sf = activeRef.current?.statusFields as {
          runCostUsd?: number;
          conversationCostUsd?: number;
        } | null;
        if (sf?.runCostUsd) lines.push(`run $${sf.runCostUsd.toFixed(2)}`);
        if (sf?.conversationCostUsd)
          lines.push(`conversation $${sf.conversationCostUsd.toFixed(2)}`);
      } else {
        const md = (agent?.metadata ?? {}) as Record<string, unknown>;
        const status = agent?.status ?? "idle";
        const elapsed =
          typeof md.elapsed === "number" ? humanDuration(md.elapsed) : "";
        if (status === "running") {
          lines.push(
            `${entity.role} — working${elapsed ? ` for ${elapsed}` : ""}`,
          );
          if (entity.activity) lines.push(`using ${entity.activity}`);
        } else if (status === "done") {
          lines.push(`${entity.role} — done${elapsed ? ` in ${elapsed}` : ""}`);
        } else if (entity.waiting) {
          lines.push(`${entity.role} — waiting on team`);
        } else {
          lines.push(`${entity.role} — ${status}`);
        }
        const task = typeof md.task === "string" ? md.task : "";
        if (task) lines.push(task.length > 90 ? `${task.slice(0, 90)}…` : task);
        const lastWork = typeof md.lastWork === "string" ? md.lastWork : "";
        if (!task && lastWork)
          lines.push(
            lastWork.length > 90 ? `${lastWork.slice(0, 90)}…` : lastWork,
          );
        // Odometer: lifetime totals for this agent (deduped dispatch_end sums).
        const totals = activeRef.current
          ? cacheRef.current
              ?.statsFor(activeRef.current.tabId)
              .totalsFor(entity.name)
          : null;
        if (totals && totals.dispatches > 0) {
          const tok =
            totals.inputTokens + totals.outputTokens > 0
              ? ` · ${(totals.inputTokens / 1000).toFixed(1)}k in / ${(totals.outputTokens / 1000).toFixed(1)}k out`
              : "";
          lines.push(
            `$${totals.costUsd.toFixed(2)}${tok} · ${totals.dispatches} dispatch${totals.dispatches === 1 ? "" : "es"}`,
          );
        } else {
          const cost =
            typeof md.cost === "number" && md.cost > 0
              ? `$${md.cost.toFixed(2)}`
              : "";
          if (cost) lines.push(cost);
        }
        if (entity.completed || status === "running")
          lines.push("click to open dispatch");
      }
      setTooltip({
        x: point.x,
        y: point.y,
        title: entity.name === "__manager__" ? "Manager" : entity.displayName,
        lines,
      });
    },
    [],
  );

  // Click (without drag): open the agent's dispatch detail in the desktop.
  const onCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const engine = engineRef.current;
      const active = activeRef.current;
      if (!engine || !active) return;
      const point = canvasPointFromClient(
        e.currentTarget,
        e.clientX,
        e.clientY,
      );
      const entity = engine.getEntityAt(point.x, point.y);
      if (!entity || entity.role === "pet") return;
      // The manager = the orchestrator = the main conversation: clicking him
      // shows the desktop on that conversation (no dispatch panel).
      if (entity.name === "__manager__") {
        rInfo("studio", "manager clicked", { tab_id: active.tabId });
        if (onAgentClick) onAgentClick(active.tabId, "__manager__");
        else window.ion.studioFocusAgent(active.tabId, "__orchestrator__");
        return;
      }
      // Shift+click: follow-cam / focus-mode cycle (game-feel camera).
      if (e.shiftKey) {
        const mode = engine.cycleFollow(entity.name);
        rInfo("studio", "follow cycled", { agent: entity.name, mode });
        return;
      }
      if (!entity.working && !entity.completed && !entity.waiting) return;
      rInfo("studio", "agent clicked", {
        agent: entity.name,
        tab_id: active.tabId,
      });
      if (onAgentClick) onAgentClick(active.tabId, entity.name);
      else window.ion.studioFocusAgent(active.tabId, entity.name);
    },
    [onAgentClick],
  );

  const onCanvasMouseUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const onToggleSound = useCallback(() => {
    setSoundOn((prev) => {
      const next = !prev;
      soundRef.current.enabled = next;
      void window.ion.studioSetSetting("studioSound", next);
      return next;
    });
  }, []);

  const onSelectTheme = useCallback(
    (id: string) => {
      void window.ion.studioSetSetting("studioTheme", id).then(async () => {
        // Full theme swap: reload the pack and rebuild the scene against it.
        try {
          const theme = await loadTheme(ipcAssetSource(), id, {
            logWarn: (msg, fields) => rError("studio", msg, fields),
          });
          themeRef.current = theme;
          engineRef.current?.destroy();
          const canvas = canvasRef.current;
          if (!canvas) return;
          const engine = createVisualizerEngine(canvas, theme);
          engine.setZoom(zoom);
          engineRef.current = engine;
          if (settingsRef.current) settingsRef.current.studioTheme = id;
          rebuildScene(activeRef.current);
        } catch (err) {
          rError("studio", "theme swap failed", {
            theme_id: id,
            error: String(err),
          });
          setPhase({ kind: "error", message: String(err) });
        }
      });
    },
    [rebuildScene, zoom],
  );

  // Publish window-level controls (sound, seed, theme) to the controls bus —
  // the TabStrip's Studio button popover (ControlsPopover) renders them.
  useEffect(() => {
    useStudioControlsBus.getState().publish({
      seed,
      tabLabel,
      soundOn,
      themes,
      activeThemeId: settingsRef.current?.studioTheme ?? "ion-works",
      actions: {
        toggleSound: onToggleSound,
        applySeed: onApplySeed,
        resetSeed: onResetSeed,
        selectTheme: onSelectTheme,
      },
    });
  }, [
    seed,
    tabLabel,
    soundOn,
    themes,
    onToggleSound,
    onApplySeed,
    onResetSeed,
    onSelectTheme,
  ]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
      }}
    >
      {phase.kind === "ready" && (
        <Toolbar
          campus={campus}
          onToggleCampus={() => setCampus((v) => !v)}
          replaying={replaying}
          onToggleReplay={() => {
            const engine = engineRef.current;
            const recorder = cacheRef.current?.recorder;
            if (!engine || !recorder) return;
            if (replaying) {
              engine.stopReplay();
              setReplaying(false);
              // Live truth returns immediately from the cache.
              rebuildScene(cacheRef.current?.getActive() ?? null);
            } else if (recorder.frames.length > 1) {
              engine.startReplay([...recorder.frames]);
              setReplaying(true);
            }
          }}
          onExportPostcard={() => void exportPostcard()}
          clipSecondsLeft={
            clip.kind === "recording"
              ? Math.ceil(clipRemaining(clip, performance.now()))
              : clip.kind === "saving"
                ? -1
                : 0
          }
          onRecordClip={recordClip}
          heatOn={heatOn}
          onToggleHeat={() => {
            const next = !heatOn;
            setHeatOn(next);
            engineRef.current?.setHeatOverlay(next);
            void window.ion.studioSetSetting("studioHeat", next);
          }}
          zoom={zoom}
          problems={problems}
          onZoom={onZoom}
          onZoomFit={onZoomFit}
          onOpenSettings={(anchor) => useStudioControlsBus.getState().toggle(anchor)}
        />
      )}
      <VisualizerCanvas
        phase={phase}
        canvasRef={canvasRef}
        engineRef={engineRef}
        cacheRef={cacheRef}
        seed={seed}
        zoom={zoom}
        setZoom={setZoomState}
        campus={campus}
        setCampus={setCampus}
        replaying={replaying}
        setReplaying={setReplaying}
        tooltip={tooltip}
        setTooltip={setTooltip}
        onMouseDown={onCanvasMouseDown}
        onMouseMove={onCanvasMouseMove}
        onMouseUp={onCanvasMouseUp}
        onClick={onCanvasClick}
        rebuildScene={rebuildScene}
      />
    </div>
  );
}
