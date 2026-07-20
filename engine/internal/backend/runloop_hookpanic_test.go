package backend

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// hookPanicLogMu serializes tests installing the process-global logger sink.
var hookPanicLogMu sync.Mutex

// TestRunHookCtx_PanicRecovered_LogsStack pins that an extension hook panic is
// recovered AND logged (with a stack), instead of being silently swallowed by
// the bare `_ = recover()` this replaced. Without the log a hook that stops
// firing is invisible. On panic the inner goroutine returns without feeding the
// result channel, so the wrapper unblocks via context cancellation; the panic
// log fires synchronously in the deferred recover before that.
func TestRunHookCtx_PanicRecovered_LogsStack(t *testing.T) {
	hookPanicLogMu.Lock()
	defer hookPanicLogMu.Unlock()

	var mu sync.Mutex
	var sawPanicLog bool
	prev := utils.GetLevel()
	utils.SetLevel(utils.LevelDebug)
	utils.SetTestSink(func(_ utils.LogLevel, tag, msg string, fields map[string]any, _, _ string) {
		if tag == "backend.runloop" && msg == "extension hook panic recovered" {
			mu.Lock()
			if _, ok := fields["stack"]; ok {
				sawPanicLog = true
			}
			mu.Unlock()
		}
	})
	defer func() {
		utils.SetTestSink(nil)
		utils.SetLevel(prev)
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	// A hook that panics must not crash the test; runHookCtx recovers it and
	// returns ctx.Err() once the deadline fires (the panic path never sends).
	_, err := runHookCtx(ctx, func() int { panic("boom") })
	if err == nil {
		t.Fatal("expected ctx error after panic (result channel never fed)")
	}

	mu.Lock()
	defer mu.Unlock()
	if !sawPanicLog {
		t.Fatal("expected 'extension hook panic recovered' log with a stack")
	}
}
