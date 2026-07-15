package backend

import (
	"context"

	"github.com/dsswift/ion/engine/internal/utils"
)

// installAmbientLogging installs ctx as the ambient logging context for the
// calling goroutine and returns a cleanup function that clears it. It is the
// single-line seam used at the top of runLoop:
//
//	defer installAmbientLogging(ctx)()
//
// The install runs immediately (evaluating the outer call) so every subsequent
// utils.Log/Debug/Info/Warn/Error call on this goroutine automatically stamps
// session_id, conversation_id, and trace_id from ctx — without touching the
// ~200 individual call sites. The returned cleanup is deferred so the ambient
// entry is removed when the goroutine exits, keeping the underlying sync.Map
// from growing unboundedly.
//
// This lives in its own file (rather than inline in runLoop) to keep
// runloop.go under the file-size cap while preserving the one-goroutine,
// one-ambient-context invariant.
func installAmbientLogging(ctx context.Context) func() {
	utils.SetAmbientCtx(ctx)
	return utils.ClearAmbientCtx
}
