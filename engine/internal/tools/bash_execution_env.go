package tools

import (
	"context"

	"github.com/dsswift/ion/engine/internal/utils"
)

// bashExecutionEnv carries the owning session into local Bash descendants.
// External tools can use the session identity to associate their own work with
// the source conversation without the engine needing to know how a client
// presents that work.
func bashExecutionEnv(ctx context.Context) map[string]string {
	sessionID := utils.SessionIDFromContext(ctx)
	if sessionID == "" {
		return nil
	}
	return map[string]string{"ION_SESSION_ID": sessionID}
}
