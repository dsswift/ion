package session

import (
	"fmt"
	"sync"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/export"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
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
func (m *Manager) SendCommand(key, command, args string) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok {
		return
	}

	// Check extension commands first
	if s.extGroup != nil && !s.extGroup.IsEmpty() {
		cmds := s.extGroup.Commands()
		if cmd, exists := cmds[command]; exists {
			ctx := m.newExtContext(s, key)
			err := cmd.Execute(args, ctx)
			if err == nil {
				m.emit(key, types.EngineEvent{
					Type:         "engine_command_result",
					EventMessage: "command executed: " + command,
				})
			}
			return
		}
	}

	switch command {
	case "compact":
		if s.conversationID != "" {
			conv, err := conversation.Load(s.conversationID, "")
			if err == nil {
				conversation.Compact(conv, 10)
				_ = conversation.Save(conv, "")
				utils.Log("Session", fmt.Sprintf("compacted session %s", key))
			}
		}
	case "export":
		if s.conversationID != "" {
			conv, err := conversation.Load(s.conversationID, "")
			if err == nil {
				format := "markdown"
				if args != "" {
					format = args
				}
				output, err := export.ExportSession(conv, export.Options{Format: format})
				if err == nil {
					m.emit(key, types.EngineEvent{
						Type:         "engine_export",
						EventMessage: output,
					})
				} else {
					utils.Log("Session", fmt.Sprintf("export failed for %s: %s", key, err))
				}
			}
		}
	default:
		utils.Log("Session", fmt.Sprintf("unknown command %s/%s (args: %s)", key, command, args))
	}
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

	delete(m.sessions, key)
	m.mu.Unlock()

	// Cleanup outside lock
	if toolServer != nil {
		toolServer.Stop()
	}
	if extGroup != nil && !extGroup.IsEmpty() {
		ctx := m.newExtContext(s, key)
		extGroup.FireSessionEnd(ctx)
		extGroup.Close()
	}
	for _, conn := range mcpConns {
		conn.Close()
	}
	if telemCollector != nil {
		telemCollector.Flush()
	}
	if sessionRecorder != nil {
		sessionRecorder.Close()
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

// IsRunning reports whether the named session has an active run.
func (m *Manager) IsRunning(key string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.sessions[key]
	return ok && s.requestID != ""
}

