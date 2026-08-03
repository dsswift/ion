package session

import "github.com/dsswift/ion/engine/internal/workspaces"

// workspaceChecker returns the shared checker owned by the workspace package.
func (m *Manager) workspaceChecker() *workspaces.Checker {
	return workspaces.SharedChecker()
}
