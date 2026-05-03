package session

import (
	"github.com/dsswift/ion/engine/internal/backend"
)

// newChildBackend returns a fresh RunBackend of the same kind as the
// Manager's parent backend. All child-agent dispatch paths must use this
// instead of calling NewApiBackend()/NewCliBackend() directly, so that
// backend: "cli" sessions produce CLI children.
func (m *Manager) newChildBackend() backend.RunBackend {
	if _, ok := m.backend.(*backend.CliBackend); ok {
		return backend.NewCliBackend()
	}
	return backend.NewApiBackend()
}
