package session

import "github.com/dsswift/ion/engine/internal/types"

// Manual /compact bookkeeping for the delegated-CLI backends (dispatchCompact
// Path B), which have no CompactNow to report progress on. dispatchCompact
// opens a live "Compacting…" indicator (engine_compacting active=true)
// before forwarding the command to the CLI; these helpers own the two ways
// it can close, and the two events dispatchCompact and handleRunExit emit
// to open/close it.
//
// See engineSession.manualCompactRunID / manualCompactStdinActive in
// types.go for the full field docs on what each marker names and why it is
// one-shot.

// consumeManualCompactRunExitLocked is handleRunExit's one-shot consumption
// of both manual-compact markers, mirroring how it already consumes
// orchestratorAbortRunID and operatorAbortRunID. Call under m.mu.Lock()
// (handleRunExit already holds it while walking those other markers).
// Returns true when this exit should emit the closing engine_compacting.
func consumeManualCompactRunExitLocked(s *engineSession, runID string) bool {
	closed := false
	// The Path-B idle sub-path dispatched /compact AS this exact run.
	// Matching on runID means a marker left by an earlier run can never
	// close a later run's indicator.
	if s.manualCompactRunID != "" && s.manualCompactRunID == runID {
		closed = true
		s.manualCompactRunID = ""
	}
	// A /compact forwarded into this run's stdin mid-turn never got its
	// closing compact_boundary frame before the run ended (abort, crash) —
	// the backstop for clearManualCompactStdinOnNativeCompaction below.
	if s.manualCompactStdinActive {
		closed = true
		s.manualCompactStdinActive = false
	}
	return closed
}

// closeManualCompactStdinOnNativeCompaction is handleNormalizedEvent's
// response to observing the delegated CLI's own compact_boundary frame
// (NativeCompactionEvent) while a manual /compact is pending in this
// session's active run's stdin. A no-op for every other event type.
//
// Desktop already renders the engine_native_compaction emitted for this same
// NormalizedEvent as a closing engine_compacting (see
// engine-control-plane-stream.ts on the desktop side), so this is pure
// engine bookkeeping — without it, a later, unrelated run exit would emit a
// second, spurious close via the backstop in consumeManualCompactRunExitLocked.
func (m *Manager) closeManualCompactStdinOnNativeCompaction(key string, event types.NormalizedEvent) {
	if _, isNative := event.Data.(*types.NativeCompactionEvent); !isNative {
		return
	}
	m.mu.Lock()
	if s, ok := m.sessions[key]; ok {
		s.manualCompactStdinActive = false
	}
	m.mu.Unlock()
}

// manualCompactOpenEvent and manualCompactCloseEvent are the engine_compacting
// payloads dispatchCompact emits directly (not via the CompactingEvent ->
// translateToEngineEvent path Path A and the backend runloop use — this is
// session/manager code, not a backend's normalized-event stream).
// CompactingActive's Go zero value (false) on manualCompactCloseEvent is
// exactly what translateToEngineEvent produces for Active: false, so the two
// paths are indistinguishable on the wire.
func manualCompactOpenEvent() types.EngineEvent {
	return types.EngineEvent{Type: "engine_compacting", CompactingActive: true}
}

func manualCompactCloseEvent() types.EngineEvent {
	return types.EngineEvent{Type: "engine_compacting"}
}
