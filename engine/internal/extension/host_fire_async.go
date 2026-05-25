// FireAsync sends an `engine/fire_async` RPC to the subprocess so it
// invokes a previously-registered webhook or schedule handler. The
// caller provides:
//   - kind/id: identifies which registered handler to dispatch
//     (must match a current entry in the host's asyncreg).
//   - ctx: a fresh extension Context built by the session manager via
//     extcontext.NewExtContext for this fire. The host pins ctx as
//     currentCtx for the duration of the call so ext/* RPCs from
//     inside the handler (dispatchAgent, sendPrompt, emit, …) resolve
//     normally.
//   - payload: kind-specific data (webhook: request envelope; schedule:
//     fire metadata or empty).
//   - timeout: per-fire timeout. Zero falls back to the host's
//     configured rpcTimeout.
//
// Returns the subprocess's marshaled response (webhook: {status, body,
// headers}; schedule: {ok}) or a non-nil error.
//
// Errors mean one of:
//   - subprocess is dead / died during the call
//   - timeout exceeded
//   - subprocess returned a JSON-RPC error
//
// FireAsync does NOT consult the registry — the caller is expected to
// have verified the (kind, id) is registered via ByID before invoking.
// This keeps the fire path off the registry's read lock when the
// registry is hot.

package extension

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/asyncreg"
	"github.com/dsswift/ion/engine/internal/utils"
)

// AsyncFirePayload is the envelope sent to the subprocess. The SDK
// runtime dispatches on (Kind, ID) to find the registered handler.
// SessionKey is included so the SDK runtime can correlate handlers
// running for different sessions (currently always the host's bound
// session, but future fan-in might cross sessions).
type AsyncFirePayload struct {
	Kind       string      `json:"kind"`
	ID         string      `json:"id"`
	SessionKey string      `json:"sessionKey"`
	Payload    interface{} `json:"payload,omitempty"`
}

// FireAsync sends engine/fire_async into the subprocess. See file
// header for behavior and error semantics.
func (h *Host) FireAsync(kind asyncreg.Kind, id string, ctx *Context, payload interface{}, timeout time.Duration) (json.RawMessage, error) {
	if h.dead.Load() {
		return nil, fmt.Errorf("extension subprocess is dead")
	}
	if timeout <= 0 {
		timeout = h.rpcTimeout
	}

	envelope := AsyncFirePayload{
		Kind:       string(kind),
		ID:         id,
		SessionKey: h.SessionKey(),
		Payload:    payload,
	}

	// Pin ctx as currentCtx so ext/* RPCs from inside the handler
	// (dispatchAgent / sendPrompt / emit / …) resolve normally. This
	// is the single piece that retires the cache-a-ctx workaround from
	// #132 — the handler runs under the same currentCtx discipline as
	// a real hook.
	prev := h.currentCtx.Load()
	h.currentCtx.Store(ctx)
	defer h.currentCtx.Store(prev)

	utils.Debug("extension", fmt.Sprintf("FireAsync: ext=%s kind=%s id=%q timeout=%s", h.name, kind, id, timeout))
	resp, err := h.callWithTimeout("engine/fire_async", envelope, timeout)
	if err != nil {
		utils.Log("extension", fmt.Sprintf("FireAsync: ext=%s kind=%s id=%q failed: %v", h.name, kind, id, err))
		return nil, err
	}
	utils.Debug("extension", fmt.Sprintf("FireAsync: ext=%s kind=%s id=%q returned %d bytes", h.name, kind, id, len(resp)))
	return resp, nil
}
