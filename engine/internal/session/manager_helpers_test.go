package session

import (
	"sync"

	"github.com/dsswift/ion/engine/internal/types"
)

// ---------------------------------------------------------------------------
// Mock backend
// ---------------------------------------------------------------------------

type mockBackend struct {
	mu           sync.Mutex
	started      map[string]types.RunOptions
	cancelled    []string
	onNorm       func(string, types.NormalizedEvent)
	onExitF      func(string, *int, *string, string)
	onErrF       func(string, error)
}

func newMockBackend() *mockBackend {
	return &mockBackend{started: make(map[string]types.RunOptions)}
}

func (m *mockBackend) StartRun(requestID string, opts types.RunOptions) {
	m.mu.Lock()
	m.started[requestID] = opts
	m.mu.Unlock()
}

func (m *mockBackend) Cancel(requestID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.started[requestID]; ok {
		m.cancelled = append(m.cancelled, requestID)
		return true
	}
	return false
}

func (m *mockBackend) IsRunning(requestID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.started[requestID]
	return ok
}

func (m *mockBackend) WriteToStdin(_ string, _ interface{}) error { return nil }

func (m *mockBackend) FlushConversations() {}

func (m *mockBackend) OnNormalized(fn func(string, types.NormalizedEvent)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onNorm = fn
}

func (m *mockBackend) OnExit(fn func(string, *int, *string, string)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onExitF = fn
}

func (m *mockBackend) OnError(fn func(string, error)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onErrF = fn
}

func (m *mockBackend) emitNormalized(runID string, event types.NormalizedEvent) {
	m.mu.Lock()
	fn := m.onNorm
	m.mu.Unlock()
	if fn != nil {
		fn(runID, event)
	}
}

func (m *mockBackend) emitExit(runID string, code *int, signal *string, sessionID string) {
	m.mu.Lock()
	fn := m.onExitF
	m.mu.Unlock()
	if fn != nil {
		fn(runID, code, signal, sessionID)
	}
}

func (m *mockBackend) emitError(runID string, err error) {
	m.mu.Lock()
	fn := m.onErrF
	m.mu.Unlock()
	if fn != nil {
		fn(runID, err)
	}
}

func (m *mockBackend) startedKeys() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	keys := make([]string, 0, len(m.started))
	for k := range m.started {
		keys = append(keys, k)
	}
	return keys
}

func (m *mockBackend) getStarted(requestID string) (types.RunOptions, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	opts, ok := m.started[requestID]
	return opts, ok
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func defaultConfig() types.EngineConfig {
	return types.EngineConfig{
		ProfileID:        "test",
		WorkingDirectory: "/tmp",
	}
}

func intPtr(v int) *int { return &v }

// eventCollector captures events emitted by the manager.
type eventCollector struct {
	mu     sync.Mutex
	events []keyedEvent
}

type keyedEvent struct {
	key   string
	event types.EngineEvent
}

func newEventCollector(mgr *Manager) *eventCollector {
	ec := &eventCollector{}
	mgr.OnEvent(func(key string, event types.EngineEvent) {
		ec.mu.Lock()
		ec.events = append(ec.events, keyedEvent{key: key, event: event})
		ec.mu.Unlock()
	})
	return ec
}

func (ec *eventCollector) byType(t string) []keyedEvent {
	ec.mu.Lock()
	defer ec.mu.Unlock()
	var out []keyedEvent
	for _, e := range ec.events {
		if e.event.Type == t {
			out = append(out, e)
		}
	}
	return out
}

func (ec *eventCollector) count() int {
	ec.mu.Lock()
	defer ec.mu.Unlock()
	return len(ec.events)
}

// ---------------------------------------------------------------------------
// StartSession tests
// ---------------------------------------------------------------------------
