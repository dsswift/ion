package session

import (
	"sync"

	"github.com/dsswift/ion/engine/internal/workspaces"
)

// Process-wide workspace checker.
//
// One instance per process rather than per Manager or per session: the checker
// reads the two workspace records under the ONE Ion home this process serves,
// and its internal cache is mtime-validated on every read — so sharing it is
// both safe (a registration made mid-session is visible to the very next tool
// call in every session) and what keeps the cost at a single stat per gated
// call instead of a cold re-parse per session.
var (
	wsCheckerOnce sync.Once
	wsChecker     *workspaces.Checker
)

// workspaceChecker returns the process-wide containment checker.
func (m *Manager) workspaceChecker() *workspaces.Checker {
	wsCheckerOnce.Do(func() {
		wsChecker = workspaces.NewChecker()
	})
	return wsChecker
}
