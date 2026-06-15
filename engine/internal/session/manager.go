package session

import (
	"fmt"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/resource"
	"github.com/dsswift/ion/engine/internal/scheduling"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
	"github.com/dsswift/ion/engine/internal/webhooks"
)

// SessionInfo describes a session in the list response.
type SessionInfo struct {
	Key            string `json:"key"`
	HasActiveRun   bool   `json:"hasActiveRun"`
	ToolCount      int    `json:"toolCount"`
	ConversationID string `json:"conversationId,omitempty"`
	ExtensionName  string `json:"extensionName,omitempty"`
}


// Manager orchestrates multiple engine sessions, routing prompts to the
// backend and forwarding events to connected clients.
type Manager struct {
	mu       sync.RWMutex
	sessions map[string]*engineSession
	backend  backend.RunBackend
	config   *types.EngineRuntimeConfig

	onEvent func(string, types.EngineEvent)

	// childBackendOverride is a test-only seam: when non-nil, newChildBackend
	// returns this factory's output instead of constructing a real backend.
	// Lets unit tests substitute an in-process stub for the child-agent
	// spawner closure (which otherwise hardcodes an ApiBackend or CliBackend).
	// Production callers must never set this -- it has no setter on the
	// public API.
	childBackendOverride func() backend.RunBackend

	// Status-heartbeat fields. heartbeatStop is closed by Shutdown to
	// terminate the per-Manager goroutine that periodically re-emits
	// engine_status for every attached session. Lifecycle is tied to
	// NewManager / Shutdown: the goroutine starts in NewManager (so any
	// Manager that hosts sessions has heartbeats by default) and
	// terminates in Shutdown. heartbeatInterval is configurable so tests
	// can opt into a short cadence without busy-waiting on a 30 s ticker.
	// See manager_heartbeat.go for the implementation.
	heartbeatStop     chan struct{}
	heartbeatStopOnce sync.Once
	heartbeatInterval time.Duration

	// Async-trigger subsystems. Lazily allocated on first
	// ensureAsyncSubsystems call. Shared across every session managed
	// by this Manager so the engine never binds two webhook listeners
	// on the same port. asyncMu guards just these fields to keep the
	// main m.mu uncontended for the most-frequent reads.
	asyncMu       sync.Mutex
	webhookServer *webhooks.Server
	scheduler     *scheduling.Scheduler

	// globalBroker is the Manager-level resource broker for workspace-scoped
	// resources (items with no conversationId). Extensions publish to it when
	// an item has no conversationId; clients subscribe via resource_subscribe
	// with resourceGlobal=true. Persists for the Manager's lifetime.
	globalBroker *resource.Broker

	// watchers deduplicates filesystem watchers across sessions that
	// share the same working directory. Without this, N sessions on
	// one repo tree consume N * dirs kqueue FDs, exhausting the
	// per-process file descriptor limit.
	watchers *watcherPool

	// runOnce is the Manager-level registry for cross-instance dedup.
	// Extensions call ctx.runOnce(id, opts, fn) to run an operation on
	// only one instance when multiple sessions load the same extension.
	// Entries clear automatically when the last session for an extension
	// path stops. See run_once.go.
	runOnce *runOnceRegistry
}

// SetConfig stores the engine runtime config for applying defaults.
func (m *Manager) SetConfig(cfg *types.EngineRuntimeConfig) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.config = cfg
}

// GetTelemetryConfig returns the engine telemetry config. Nil if telemetry
// not configured. Harness can use for self-diagnostics.
func (m *Manager) GetTelemetryConfig() *types.TelemetryConfig {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.config == nil {
		return nil
	}
	return m.config.Telemetry
}


// DefaultSessionStatusHeartbeatInterval is the cadence at which Manager
// re-emits engine_status for every attached session. The value is
// large enough that the per-session ~50-byte payload contributes
// negligible bandwidth (typical Ion deployment: 10–20 active sessions,
// ~1 kB / 30 s = ~33 B/s), and small enough that a missed organic
// status event (transient socket flap, dropped frame) converges to
// authoritative state within one cadence.
//
// Override via Manager.SetHeartbeatInterval for tests. The interval is
// not currently exposed via engine.json; the public override knob is
// reserved for a future Phase 2.1 if production load testing surfaces
// a need to tune cadence per deployment.
const DefaultSessionStatusHeartbeatInterval = 30 * time.Second

// NewManager creates a Manager wired to the given backend.
// It registers normalized/exit/error listeners on the backend so that
// events are translated and forwarded through OnEvent.
//
// Lifecycle note: NewManager spawns the per-Manager status-heartbeat
// goroutine. Every caller that creates a Manager must call Shutdown
// when done — leaking a Manager leaks the goroutine. Tests that load
// extensions via StartSession already register Shutdown with
// t.Cleanup; the heartbeat addition does not change that contract.
func NewManager(b backend.RunBackend) *Manager {
	m := &Manager{
		sessions:          make(map[string]*engineSession),
		backend:           b,
		watchers:          newWatcherPool(),
		globalBroker:      resource.NewBroker(),
		heartbeatStop:     make(chan struct{}),
		heartbeatInterval: DefaultSessionStatusHeartbeatInterval,
		runOnce:           newRunOnceRegistry(),
	}

	b.OnNormalized(m.handleNormalizedEvent)
	b.OnExit(m.handleRunExit)
	b.OnError(m.handleRunError)

	// Start the status-heartbeat goroutine. The goroutine reads
	// heartbeatInterval atomically (via a snapshot in runStatusHeartbeat)
	// so SetHeartbeatInterval calls before the first tick take effect.
	// See manager_heartbeat.go.
	go m.runStatusHeartbeat()

	return m
}


// OnEvent registers the event callback. The key identifies which session
// produced the event.
func (m *Manager) OnEvent(fn func(string, types.EngineEvent)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onEvent = fn
}

func (m *Manager) emit(key string, event types.EngineEvent) {
	m.mu.RLock()
	// Stamp the stored extensionName onto engine-emitted status events so
	// clients always receive the friendly name the extension broadcast.
	if event.Type == "engine_status" && event.Fields != nil && event.Fields.ExtensionName == "" {
		if s, ok := m.sessions[key]; ok && s.extensionName != "" {
			event.Fields.ExtensionName = s.extensionName
		}
	}
	// Phase 3 of the state-management overhaul. Every engine_status
	// emission is mirrored as an engine_session_status emission so
	// consumers that have migrated to the new typed surface receive
	// one event per state transition, not zero. The mirror is built
	// from the same StatusFields the legacy event carries (and from
	// the session struct for fields the legacy event drops, like
	// HasInflightRun + SessionID + LastEmittedAt). Phase 4 removes the
	// legacy emission; today this dual-emit keeps both consumer
	// generations in sync without forcing every per-site emitter to
	// know about both event shapes.
	var mirror *types.EngineEvent
	if event.Type == "engine_status" && event.Fields != nil {
		mirror = buildSessionStatusMirror(key, event.Fields, m.sessions[key])
	}
	fn := m.onEvent
	m.mu.RUnlock()
	if fn != nil {
		fn(key, event)
		if mirror != nil {
			fn(key, *mirror)
		}
	}
}

// buildSessionStatusMirror constructs an engine_session_status event
// from a legacy engine_status StatusFields. Pure helper extracted
// because both emit-from-helper and emit-from-call-site paths need
// the same construction. Session pointer is allowed to be nil — when
// nil the mirror carries only what's in StatusFields (the call
// arrived after StopSession dropped the session struct).
//
// Tested via TestEmit_MirrorsEngineStatusToSessionStatus in
// manager_session_status_event_test.go.
func buildSessionStatusMirror(key string, f *types.StatusFields, s *engineSession) *types.EngineEvent {
	var hasInflight bool
	var convID string
	if s != nil {
		hasInflight = s.requestID != ""
		convID = s.conversationID
	}
	// SessionID precedence: StatusFields.SessionID wins (the engine
	// stamps it on session-lifecycle status events at task complete /
	// run exit) so the mirror tracks the legacy event verbatim.
	if f.SessionID != "" {
		convID = f.SessionID
	}
	return &types.EngineEvent{
		Type: "engine_session_status",
		SessionStatus: &types.SessionStatus{
			Key:                      key,
			State:                    f.State,
			LastEmittedAt:            time.Now().UnixMilli(),
			HasInflightRun:           hasInflight,
			BackgroundAgentCount:     f.BackgroundAgents,
			Model:                    f.Model,
			ContextPercent:           f.ContextPercent,
			ContextWindow:            f.ContextWindow,
			TotalCostUsd:             f.TotalCostUsd,
			PermissionDenialsPending: f.PermissionDenials,
			SessionID:                convID,
			ExtensionName:            f.ExtensionName,
		},
	}
}

// ListSessions returns info for all active sessions.
func (m *Manager) ListSessions() []SessionInfo {
	m.mu.RLock()
	defer m.mu.RUnlock()

	result := make([]SessionInfo, 0, len(m.sessions))
	for _, s := range m.sessions {
		toolCount := 0
		if s.extGroup != nil && !s.extGroup.IsEmpty() {
			toolCount = len(s.extGroup.Tools())
		}
		// Count MCP tools
		for _, conn := range s.mcpConns {
			toolCount += len(conn.Tools())
		}
		result = append(result, SessionInfo{
			Key:            s.key,
			HasActiveRun:   s.requestID != "",
			ToolCount:      toolCount,
			ConversationID: s.conversationID,
			ExtensionName:  s.extensionName,
		})
	}
	return result
}


// SendCommand dispatches an internal command to a session.
//
// Resolution order:
//  1. Extension commands (s.extGroup.Commands()) — checked first so a harness
//     that registers `/clear` or `/help` cannot be silently overridden by a
//     stale `.md` template on the consumer side. Always read live from the
//     group; never cached, so a command registered moments before this call
//     is found even if the corresponding engine_command_registry snapshot is
//     still in flight to consumers.
//  2. Built-in cases below (`clear`, `compact`, `export`).
//  3. Default arm: emit an engine_command_result with CommandError set so
//     consumers can distinguish "ran fine" from "engine disclaims this name"
//     and route to whatever fallback they own (e.g. local `.md` template
//     expansion). Without this, consumers have no observable signal — the
//     previous behavior was a silent no-op which leaves an in-flight
//     conversation hanging. The default arm is the defence-in-depth backstop
//     that makes mid-session registration races recoverable.
func (m *Manager) SendCommand(key, command, args string) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok {
		// Session not started yet (consumers may lazily start their engine
		// session on first prompt). A slash command that arrives before the
		// first prompt would otherwise vanish silently. Emit an
		// unknown-command result so consumers can route to whatever fallback
		// they own — semantically equivalent to "engine cannot run this
		// command, try the next routing option". Contract-wise this is
		// identical to the default-arm signal in dispatchCommand; consumers
		// do not need to distinguish the two.
		utils.Log("Session", fmt.Sprintf("SendCommand: session %s not found, emitting unknown_command for cmd=%s", key, command))
		m.emit(key, types.EngineEvent{
			Type:         "engine_command_result",
			EventMessage: "unknown command: " + command,
			Command:      command,
			CommandError: "unknown_command",
		})
		return
	}
	// Real dispatch lives in command_dispatch.go so this god-file stays at
	// a manageable size. The session lookup is kept here because it's the
	// gate that protects every dispatch arm from a nil session pointer.
	m.dispatchCommand(s, key, command, args)
}

// StopSession cancels the active run and cleans up the session.
func (m *Manager) StopSession(key string) error {
	utils.Info("Session", fmt.Sprintf("StopSession: key=%s", key))
	m.mu.Lock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("session %q not found", key)
	}

	// Cancel the session's cancellation root so every descendant
	// operation (backend run, dispatched agents, in-flight llmCall) is
	// torn down with the session. Done before the explicit backend.Cancel
	// below; the two are complementary (root cascade for in-process work,
	// backend.Cancel for the per-run watchdog / terminal-status contract).
	// See session_root_context.go.
	s.cancelSessionRoot("stop session")

	// Cancel active run
	if s.requestID != "" {
		m.backend.Cancel(s.requestID)
		s.requestID = ""
	}

	// Drop pending prompts
	s.promptQueue = nil

	// Kill child PIDs
	for pid := range s.childPIDs {
		killProcess(pid)
	}


	// Capture subsystems before deleting session
	extGroup := s.extGroup
	mcpConns := s.mcpConns
	telemCollector := s.telemetry
	sessionRecorder := s.recorder
	toolServer := s.toolServer
	fsWatcherRelease := s.fsWatcherRelease
	sm := s.sessionMemory

	delete(m.sessions, key)

	// If no remaining sessions use the same extension directory, purge all
	// runOnce entries for that extension. The debounce window only applies
	// while at least one session of the extension is alive. We check while
	// still holding the write lock so the count is authoritative.
	var purgeExtDir string
	if s.extGroup != nil && !s.extGroup.IsEmpty() {
		if hosts := s.extGroup.Hosts(); len(hosts) > 0 {
			extDir := hosts[0].ExtensionDir()
			if extDir != "" && m.extensionDirSessionCount(extDir) == 0 {
				purgeExtDir = extDir
			}
		}
	}

	m.mu.Unlock()

	if purgeExtDir != "" {
		m.runOnce.purgeExtension(purgeExtDir)
	}

	// Stop session memory background summarizer before other cleanup so
	// any in-flight goroutine drains cleanly.
	if sm != nil {
		sm.Stop()
	}

	// Cleanup outside lock
	if toolServer != nil {
		toolServer.Stop()
	}
	// Release the workspace watcher BEFORE firing session_end / closing the
	// extension group so any in-flight watcher callbacks drain into a
	// still-live group, and no late callback races with extGroup.Close().
	if fsWatcherRelease != nil {
		fsWatcherRelease()
		utils.Info("session", fmt.Sprintf("stopSession: released watcher key=%s", key))
	}
	if extGroup != nil && !extGroup.IsEmpty() {
		ctx := m.newExtContext(s, key)
		_ = extGroup.FireSessionEnd(ctx)
		// Remove every host from the async-trigger subsystems before
		// Close() takes them down. Avoids the scheduler tick loop
		// holding a stale host pointer.
		for _, h := range extGroup.Hosts() {
			m.unwireHostAsync(h)
		}
		extGroup.Close()
	}
	for _, conn := range mcpConns {
		_ = conn.Close()
	}
	if telemCollector != nil {
		_ = telemCollector.Flush()
	}
	if sessionRecorder != nil {
		_ = sessionRecorder.Close()
	}

	m.emit(key, types.EngineEvent{Type: "engine_dead"})
	return nil
}

// StopByPrefix stops all sessions whose key starts with the given prefix.
func (m *Manager) StopByPrefix(prefix string) {
	m.mu.RLock()
	var keys []string
	for k := range m.sessions {
		if len(k) >= len(prefix) && k[:len(prefix)] == prefix {
			keys = append(keys, k)
		}
	}
	m.mu.RUnlock()

	for _, k := range keys {
		_ = m.StopSession(k)
	}
}

// StopAll stops every active session.
func (m *Manager) StopAll() error {
	m.mu.RLock()
	keys := make([]string, 0, len(m.sessions))
	for k := range m.sessions {
		keys = append(keys, k)
	}
	m.mu.RUnlock()

	for _, k := range keys {
		_ = m.StopSession(k)
	}
	return nil
}

// Shutdown stops every active session and tears down the manager-level
// async subsystems (webhook listener, scheduler tick loop). Safe to
// call multiple times; safe to call when no subsystems have been
// started. Tests that load extensions via StartSession should
// register this with t.Cleanup so a leaked listener cannot bleed
// the default port across subsequent tests.
//
// Also terminates the per-Manager status-heartbeat goroutine started
// in NewManager. The stop is idempotent (sync.Once-guarded) so
// multi-call Shutdown is safe.
func (m *Manager) Shutdown() {
	// Stop the heartbeat before tearing down sessions so the goroutine
	// cannot observe a partially-shutdown Manager.
	m.heartbeatStopOnce.Do(func() {
		close(m.heartbeatStop)
	})

	_ = m.StopAll()
	m.asyncMu.Lock()
	srv := m.webhookServer
	sch := m.scheduler
	m.webhookServer = nil
	m.scheduler = nil
	m.asyncMu.Unlock()
	if srv != nil {
		srv.Stop()
	}
	if sch != nil {
		sch.Stop()
	}
}

// IsRunning reports whether the named session has an active run.
//
// Uses the same backend cross-check as currentSessionStatus so a stale
// requestID (run terminated abnormally without flowing through
// handleRunExit) does not produce a "running" answer indefinitely. The
// cross-check both reports correctly *and* clears the lingering field
// so a subsequent SendPrompt does not refuse with "session already
// running".
func (m *Manager) IsRunning(key string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[key]
	if !ok {
		return false
	}
	return m.currentSessionStatus(s) == "running"
}

// sessionState returns "running" or "idle" for the given session.
//
// This is a thin wrapper around currentSessionStatus that exists for
// backwards-compatibility with the StatusFields.State field shape. New
// callers should use currentSessionStatus directly so they get the
// authoritative state value (with the backend cross-check applied).
func (m *Manager) sessionState(s *engineSession) string {
	return m.currentSessionStatus(s)
}

// currentSessionStatus computes the authoritative "running" / "idle"
// state for a session by cross-checking the in-memory requestID against
// the backend's live-run set.
//
// Why the cross-check exists. The naive predicate "requestID != ''
// means running" is the original implementation and the reason an
// engine session can report "running" indefinitely: if a run terminates
// abnormally without flowing through handleRunExit / StopSession (e.g.
// extension panic, watchdog kill, host crash mid-stream), the backend
// drops the run from its live-run map but s.requestID stays populated.
// Every subsequent ReconcileState / engine_status emission then
// publishes "running" forever and downstream caches (desktop tab status,
// iOS pulse) cannot recover without operator intervention.
//
// The cross-check resolves this at the single computation site. If the
// in-memory requestID exists but the backend disclaims ownership of it,
// we treat the field as stale, clear it defensively, and report idle.
// A defensive log line fires so investigations can confirm the path is
// hot when it triggers.
//
// Caller contract. Must be invoked with m.mu held (read or write). The
// defensive clear writes to s.requestID; callers that hold only a read
// lock will not corrupt state because the assignment is to a field on
// a struct the read lock keeps pinned, and a parallel goroutine that
// holds the write lock is the only other writer (StopSession / the
// run-exit handler). Concurrent stale-clears converge on the same
// "empty string" value so a race produces no observable difference.
//
// Return values mirror StatusFields.State exactly so the function is a
// drop-in replacement for the prior sessionState body.
func (m *Manager) currentSessionStatus(s *engineSession) string {
	if s.requestID == "" {
		return "idle"
	}
	// requestID is set — confirm the backend actually still owns the
	// run. If not, the field has lingered after a non-graceful run
	// termination and we treat the session as idle.
	if m.backend != nil && !m.backend.IsRunning(s.requestID) {
		stale := s.requestID
		s.requestID = ""
		utils.Warn("Session", fmt.Sprintf(
			"currentSessionStatus: clearing stale requestID key=%s runID=%s (backend disclaims run); reporting state=idle",
			s.key, stale,
		))
		return "idle"
	}
	return "running"
}

// ClearConversationFile wipes the LLM-visible history on a stored conversation
// file by sessionId, without requiring a live engine session. It is the
// stateless counterpart of dispatchClear: it performs the same load → zero
// → save sequence but does not emit any events (no session exists to emit to)
// and does not re-fire session_start (no extension group is loaded).
//
// Fields wiped (matches dispatchClear exactly):
//   - Messages           — the flat LLM-visible message list
//   - LastInputTokens    — context-percent numerator
//   - LastInputTokensMsgCount — companion message-count counter
//
// Fields preserved: Entries, LeafID, TotalInputTokens, TotalOutputTokens,
// TotalCost, ID, System, Model, CreatedAt, Version, ParentID,
// WorkingDirectory — same rationale as dispatchClear (/clear is a checkpoint,
// not a delete).
//
// Returns nil on success. Returns an error if the conversation file cannot be
// loaded or saved; in that case no partial write occurs (Load/Save are atomic
// operations at the file level).
func (m *Manager) ClearConversationFile(sessionID string) error {
	utils.Log("Session", fmt.Sprintf("ClearConversationFile: clearing conversation sessionId=%s", sessionID))
	// Route through the shared clear core (preferKey empty → the core does a
	// reverse lookup over live sessions by conversationID). This guarantees
	// the file-only clear path carries identical semantics to the
	// live-session /clear: if a live session owns this conversation, its
	// retained AskUserQuestion / ExitPlanMode denials are cleared and the
	// shared clear signal is emitted so desktop and iOS dismiss the pending
	// card. If no live session owns it, the file is still wiped and there is
	// no in-memory card to dismiss (the consumer's restore-time rule handles
	// a later reopen).
	res, err := m.clearConversationCore(sessionID, "")
	if err != nil {
		utils.Log("Session", fmt.Sprintf("ClearConversationFile: sessionId=%s core failed: %v", sessionID, err))
		return err
	}
	if res.sessionKey != "" {
		utils.Log("Session", fmt.Sprintf("ClearConversationFile: sessionId=%s owned by live session key=%s deniedCleared=%d — emitting shared clear signal", sessionID, res.sessionKey, res.deniedCleared))
		m.emitClearSignal(res.sessionKey)
	} else {
		utils.Log("Session", fmt.Sprintf("ClearConversationFile: sessionId=%s wiped=%t (no live session owner, no signal to emit)", sessionID, res.wiped))
	}
	return nil
}

// ResourceBroker returns the resource broker for the session identified by key.
// Returns nil when no session is found for the key.
func (m *Manager) ResourceBroker(key string) *resource.Broker {
	m.mu.RLock()
	s, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok {
		return nil
	}
	return s.resourceBroker
}

// GlobalResourceBroker returns the Manager-level resource broker for
// workspace-scoped resources (items with no conversationId). This broker
// persists for the Manager's lifetime, not per-session.
func (m *Manager) GlobalResourceBroker() *resource.Broker {
	return m.globalBroker
}

// ReconcileState re-emits the current agent states and status for the given
// session so that a freshly-connected (or reconnected) client can catch up
// without waiting for the next organic state change.
//
// Engine contract: `engine_agent_state` is a complete snapshot. We emit
// unconditionally — even an empty `agents: []` snapshot is meaningful
// because consumers must replace their view with whatever the engine
// considers authoritative. Skipping the emission would leave reconnecting
// clients showing stale agent rows from a previous session. See
// docs/architecture/agent-state.md.
//
// `engine_status` follows the same snapshot rule. Beyond the existing
// context/cost/model fields, the snapshot must also carry any unresolved
// PermissionDenials retained from the most recent TaskCompleteEvent —
// otherwise a re-attaching consumer would observe an engine_status that
// silently drops the field while the session is still blocked on those
// denials. The session retains these via lastPermissionDenials,
// populated in event_translation.go and cleared when a new prompt
// dispatches (see prompt_dispatch.go).
func (m *Manager) ReconcileState(key string) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok {
		utils.Warn("Session", fmt.Sprintf("ReconcileState: session not found key=%s", key))
		return
	}

	// Re-emit agent states. Always emit, including the empty snapshot:
	// reconnecting clients need the authoritative "no agents" signal as
	// much as they need the "here are the agents" signal.
	snapshot := s.agents.MergedSnapshot()
	utils.Log("Session", fmt.Sprintf("agent_snapshot_emitted key=%s count=%d reason=reconcile", key, len(snapshot)))
	m.emit(key, types.EngineEvent{Type: "engine_agent_state", Agents: snapshot})

	// Re-emit status via the shared snapshot helper so the legacy
	// engine_status and the Phase 3 engine_session_status both ship
	// from one site. Phase 4 will collapse this when the legacy event
	// retires; today the helper guarantees both events carry the same
	// authoritative state computed by currentSessionStatus.
	m.emitStatusSnapshot(key, "reconcile")
}

