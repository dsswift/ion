package session

import (
	"fmt"
	"sync"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
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

	// Async-trigger subsystems. Lazily allocated on first
	// ensureAsyncSubsystems call. Shared across every session managed
	// by this Manager so the engine never binds two webhook listeners
	// on the same port. asyncMu guards just these fields to keep the
	// main m.mu uncontended for the most-frequent reads.
	asyncMu       sync.Mutex
	webhookServer *webhooks.Server
	scheduler     *scheduling.Scheduler

	// watchers deduplicates filesystem watchers across sessions that
	// share the same working directory. Without this, N sessions on
	// one repo tree consume N * dirs kqueue FDs, exhausting the
	// per-process file descriptor limit.
	watchers *watcherPool
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


// NewManager creates a Manager wired to the given backend.
// It registers normalized/exit/error listeners on the backend so that
// events are translated and forwarded through OnEvent.
func NewManager(b backend.RunBackend) *Manager {
	m := &Manager{
		sessions: make(map[string]*engineSession),
		backend:  b,
		watchers: newWatcherPool(),
	}

	b.OnNormalized(m.handleNormalizedEvent)
	b.OnExit(m.handleRunExit)
	b.OnError(m.handleRunError)

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
	fn := m.onEvent
	m.mu.RUnlock()
	if fn != nil {
		fn(key, event)
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
	m.mu.Unlock()

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
func (m *Manager) Shutdown() {
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
func (m *Manager) IsRunning(key string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.sessions[key]
	return ok && s.requestID != ""
}

// sessionState returns "running" or "idle" for the given session.
func (m *Manager) sessionState(s *engineSession) string {
	if s.requestID != "" {
		return "running"
	}
	return "idle"
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
	utils.Log("Session", fmt.Sprintf("ClearConversationFile: loading conversation sessionId=%s", sessionID))
	conv, err := conversation.Load(sessionID, "")
	if err != nil {
		utils.Log("Session", fmt.Sprintf("ClearConversationFile: load failed sessionId=%s err=%v", sessionID, err))
		return fmt.Errorf("load conversation %q: %w", sessionID, err)
	}

	conv.Messages = nil
	conv.LastInputTokens = 0
	conv.LastInputTokensMsgCount = 0

	if err := conversation.Save(conv, ""); err != nil {
		utils.Log("Session", fmt.Sprintf("ClearConversationFile: save failed sessionId=%s err=%v", sessionID, err))
		return fmt.Errorf("save conversation %q: %w", sessionID, err)
	}

	utils.Log("Session", fmt.Sprintf("ClearConversationFile: id=%s cleared Messages (was %d entries) — .tree.jsonl preserved", sessionID, len(conv.Entries)))
	return nil
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

	// Re-emit status. Read retained fields under the session lock so we
	// observe a coherent snapshot (denials + cost + context together).
	m.mu.RLock()
	pendingDenials := s.lastPermissionDenials
	lastPct := s.lastContextPct
	lastWindow := s.lastContextWindow
	lastModel := s.lastModel
	lastCost := s.lastTotalCost
	sessionState := m.sessionState(s)
	m.mu.RUnlock()

	utils.Log("Session", fmt.Sprintf("reconcile_status_emitted key=%s state=%s pendingDenials=%d model=%s contextPct=%d", key, sessionState, len(pendingDenials), lastModel, lastPct))
	m.emit(key, types.EngineEvent{
		Type: "engine_status",
		Fields: &types.StatusFields{
			State:             sessionState,
			ContextPercent:    lastPct,
			ContextWindow:     lastWindow,
			Model:             lastModel,
			TotalCostUsd:      lastCost,
			PermissionDenials: pendingDenials,
		},
	})
}

