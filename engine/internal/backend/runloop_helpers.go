package backend

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
)

// convSuffixCounter is a fallback used only when crypto/rand fails (it never
// has, but the disk could be full at exactly the wrong moment). Combined with
// the millisecond timestamp it still produces unique conversation IDs.
var convSuffixCounter uint64

// newConvSuffix returns a 12-hex-char random suffix. Callers prepend a
// millisecond timestamp; the combined id is the conversation file name.
// Two runs that begin in the same millisecond see different suffixes, so
// their conversation files cannot collide.
func newConvSuffix() string {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%012x", atomic.AddUint64(&convSuffixCounter, 1))
	}
	return hex.EncodeToString(b[:])
}

// compactThreshold is the default context usage percentage that triggers
// proactive compaction.
const compactThreshold = 80

// runHookCtx runs fn on a goroutine and races it against ctx cancellation.
// On cancel, returns ctx.Err() and discards the eventual result. The inner
// goroutine continues to completion (it has no way to be cancelled — that's
// why we need this wrapper) but its return value is dropped. Use to bound
// per-tool extension hooks (OnToolCall, OnPermissionRequest, etc.) that are
// implemented by extension subprocesses with no native ctx support.
func runHookCtx[T any](ctx context.Context, fn func() T) (T, error) {
	var zero T
	ch := make(chan T, 1)
	go func() {
		defer func() {
			// Hook callbacks are extension-supplied; recover panics so they
			// can't take down the run. Drop the result on panic.
			recover()
		}()
		ch <- fn()
	}()
	select {
	case v := <-ch:
		return v, nil
	case <-ctx.Done():
		return zero, ctx.Err()
	}
}

// defaultToolTimeout caps how long a single tool call may run. The cap is a
// belt-and-suspenders backstop against tools that ignore ctx; properly
// cooperating tools cancel via gCtx far sooner. Bash has its own much-longer
// inner timeout (long shell commands are legitimate); this cap applies to the
// surrounding goroutine, so a misbehaving Bash subprocess that ignores SIGTERM
// will still let executeTools return.
const defaultToolTimeout = 5 * time.Minute

// toolStallThreshold is how long a tool call runs before a ToolStalledEvent
// is emitted. This is a heuristic to surface tools that may be blocked by
// macOS TCC permission dialogs or stuck on slow operations. The event is
// informational -- it does NOT cancel the tool.
//
// Declared as a var (not const) so tests can shorten it without waiting 30s.
var toolStallThreshold = 30 * time.Second

// computeCost estimates the USD cost for a turn using the model registry.
func computeCost(model string, usage types.LlmUsage) float64 {
	info := providers.GetModelInfo(model)
	if info == nil {
		return 0
	}
	inputCost := float64(usage.InputTokens) / 1000.0 * info.CostPer1kInput
	outputCost := float64(usage.OutputTokens) / 1000.0 * info.CostPer1kOutput
	return inputCost + outputCost
}

// appendOrGrow ensures the slice is large enough for the given index.
func appendOrGrow(blocks []types.LlmContentBlock, idx int, block types.LlmContentBlock) []types.LlmContentBlock {
	for len(blocks) <= idx {
		blocks = append(blocks, types.LlmContentBlock{})
	}
	blocks[idx] = block
	return blocks
}

func intPtr(v int) *int       { return &v }
func strPtr(v string) *string { return &v }
