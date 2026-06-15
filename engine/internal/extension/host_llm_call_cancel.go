package extension

import (
	"context"
	"fmt"

	"github.com/dsswift/ion/engine/internal/utils"
)

// host_llm_call_cancel.go — per-RPC cancellation for ctx.llmCall().
//
// The TS SDK threads an optional AbortSignal into ctx.llmCall({ signal }).
// AbortSignal is not JSON-serializable, so the runtime consumes it locally
// and, on abort, fires a fire-and-forget ext/llm_call_cancel notification
// keyed by the in-flight RPC id. The engine side keeps a map from RPC id to
// the CancelFunc of the context that drives that call (see
// Host.inflightLLMCalls) and invokes it when the cancel notification lands.
//
// This is the per-call leaf of the unified cancellation tree: a session-wide
// abort cancels every call via the session root (RunOptions.ParentCtx →
// llmCall derives from sa.RootContext()), while this path cancels exactly
// one call by id. Both converge on cancelling the same derived context.

// registerInflightLLMCall records the CancelFunc for an in-flight ext/llm_call
// keyed by its RPC id. Must be paired with completeInflightLLMCall (typically
// via defer) so the map does not leak entries for completed calls.
func (h *Host) registerInflightLLMCall(id int64, cancel context.CancelFunc) {
	h.inflightLLMMu.Lock()
	if h.inflightLLMCalls == nil {
		h.inflightLLMCalls = make(map[int64]context.CancelFunc)
	}
	h.inflightLLMCalls[id] = cancel
	n := len(h.inflightLLMCalls)
	h.inflightLLMMu.Unlock()
	utils.Debug("extension", fmt.Sprintf("registerInflightLLMCall: id=%d inflight=%d", id, n))
}

// completeInflightLLMCall removes the CancelFunc for a finished ext/llm_call.
// Idempotent: a call that was already cancelled (and thus possibly already
// removed) is a no-op. Always called when the call goroutine returns so the
// map tracks only genuinely in-flight calls.
func (h *Host) completeInflightLLMCall(id int64) {
	h.inflightLLMMu.Lock()
	_, existed := h.inflightLLMCalls[id]
	delete(h.inflightLLMCalls, id)
	n := len(h.inflightLLMCalls)
	h.inflightLLMMu.Unlock()
	utils.Debug("extension", fmt.Sprintf("completeInflightLLMCall: id=%d existed=%t inflight=%d", id, existed, n))
}

// cancelInflightLLMCall cancels a specific in-flight ext/llm_call by RPC id.
// Returns true when a matching call was found and its context cancelled,
// false when the id is unknown (the call already completed or never existed —
// a benign race with completion). The map entry is left for
// completeInflightLLMCall to remove on the call goroutine's return, so cancel
// and complete cannot double-delete.
func (h *Host) cancelInflightLLMCall(id int64) bool {
	h.inflightLLMMu.Lock()
	cancel, ok := h.inflightLLMCalls[id]
	h.inflightLLMMu.Unlock()
	if !ok {
		utils.Debug("extension", fmt.Sprintf("cancelInflightLLMCall: id=%d not found (already completed?)", id))
		return false
	}
	utils.Info("extension", fmt.Sprintf("cancelInflightLLMCall: cancelling in-flight llm_call id=%d", id))
	cancel()
	return true
}
