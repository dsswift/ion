/**
 * AtvReplayBar — transport controls for session replay: scrub, play/pause,
 * speed cycle, and a prominent LIVE return. Mounted by AtvApp when the user
 * enters replay from the control bar; polls the engine's transport state at
 * UI rate (the engine advances the clock at tick rate).
 */
import React, { useEffect, useState } from 'react'
import { Play, Pause, ClockCounterClockwise, Broadcast } from '@phosphor-icons/react'
import { darkColors } from '../theme-tokens'
import type { AtvEngine } from './engine'
import type { ReplaySpeed } from './engine/replay'

export interface AtvReplayBarProps {
  engine: AtvEngine
  onExit(): void
}

function fmt(ms: number, startMs: number): string {
  const s = Math.max(0, Math.round((ms - startMs) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const SPEEDS: ReplaySpeed[] = [1, 4, 16]

export function AtvReplayBar(props: AtvReplayBarProps): React.JSX.Element | null {
  const [transport, setTransport] = useState(props.engine.getReplay())

  useEffect(() => {
    const timer = setInterval(() => setTransport(props.engine.getReplay()), 200)
    return () => clearInterval(timer)
  }, [props.engine])

  if (!transport) return null

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 10px',
        background: darkColors.containerBgCollapsed,
        borderTop: `1px solid ${darkColors.containerBorder}`,
        fontFamily: 'system-ui, sans-serif',
        fontSize: 11,
        color: darkColors.textSecondary,
      }}
    >
      <ClockCounterClockwise size={13} color={darkColors.statusWaitingChildren} />
      <button
        onClick={() => props.engine.setReplayPlaying(!transport.playing)}
        style={{ border: 'none', background: 'transparent', color: darkColors.textPrimary, cursor: 'pointer', display: 'flex' }}
        aria-label={transport.playing ? 'Pause replay' : 'Play replay'}
      >
        {transport.playing ? <Pause size={13} /> : <Play size={13} />}
      </button>
      <span style={{ minWidth: 34, textAlign: 'right' }}>{fmt(transport.clockMs, transport.startMs)}</span>
      <input
        type="range"
        min={transport.startMs}
        max={transport.endMs}
        value={transport.clockMs}
        onChange={(e) => props.engine.replaySeek(Number(e.target.value))}
        style={{ flex: 1 }}
        aria-label="Replay position"
      />
      <span style={{ minWidth: 34 }}>{fmt(transport.endMs, transport.startMs)}</span>
      <button
        onClick={() => {
          const next = SPEEDS[(SPEEDS.indexOf(transport.speed as ReplaySpeed) + 1) % SPEEDS.length]
          props.engine.setReplaySpeed(next)
        }}
        style={{
          border: `1px solid ${darkColors.containerBorder}`,
          borderRadius: 5,
          background: 'transparent',
          color: darkColors.textPrimary,
          fontSize: 10,
          padding: '1px 6px',
          cursor: 'pointer',
          minWidth: 30,
        }}
      >
        {transport.speed}×
      </button>
      <button
        onClick={props.onExit}
        style={{
          border: 'none',
          borderRadius: 5,
          background: darkColors.statusRunning,
          color: '#fff',
          fontSize: 10,
          fontWeight: 700,
          padding: '2px 8px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        <Broadcast size={11} /> LIVE
      </button>
    </div>
  )
}
