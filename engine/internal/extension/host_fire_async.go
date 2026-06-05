// FireAsync sends an `engine/fire_async` RPC to the subprocess so it
// invokes a previously-registered webhook or schedule handler. The
// caller provides:
//   - kind/id: identifies which registered handler to dispatch
//     (must match a current entry in the host's asyncreg).
//   - ctx: a fresh extension Context built by the session manager via
//     extcontext.NewExtContext for this fire. The host pushes ctx onto
//     the ctxStack for the duration of the call so ext/* RPCs from
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

	// Pin ctx onto the context stack so ext/* RPCs from inside the handler
	// (dispatchAgent / sendPrompt / emit / …) resolve normally. This
	// is the single piece that retires the cache-a-ctx workaround from
	// #132 — the handler runs under the same ctxStack discipline as
	// a real hook.
	h.ctxStack.Push(ctx)
	defer h.ctxStack.Pop()

	utils.Debug("extension", fmt.Sprintf("FireAsync: ext=%s kind=%s id=%q timeout=%s", h.name, kind, id, timeout))
	resp, err := h.callWithTimeout("engine/fire_async", envelope, timeout)
	if err != nil {
		utils.Log("extension", fmt.Sprintf("FireAsync: ext=%s kind=%s id=%q failed: %v", h.name, kind, id, err))
		return nil, err
	}
	utils.Debug("extension", fmt.Sprintf("FireAsync: ext=%s kind=%s id=%q returned %d bytes", h.name, kind, id, len(resp)))
	return resp, nil
}

// ResolveToken asks the subprocess to resolve the named token
// reference (the symbolic name an extension registered with the SDK
// at declaration time for a webhook auth or schedule enabled
// predicate). Sends an engine/resolve_token RPC and returns the
// resulting string.
//
// The subprocess looks the name up in its TokenRef registry and
// invokes the user's `() => string` callback. Errors propagate
// verbatim so the caller can log the resolution failure.
//
// Uses a short timeout (5s) since token resolution should be
// near-instant — extensions that need to fetch from a remote secret
// store should cache externally and return the cached value.
func (h *Host) ResolveToken(name string) (string, error) {
	if name == "" {
		return "", fmt.Errorf("ResolveToken: empty name")
	}
	if h.dead.Load() {
		return "", fmt.Errorf("ResolveToken: subprocess dead")
	}
	type req struct {
		Name string `json:"name"`
	}
	raw, err := h.callWithTimeout("engine/resolve_token", req{Name: name}, 5*time.Second)
	if err != nil {
		return "", err
	}
	if len(raw) == 0 || string(raw) == "null" {
		return "", nil
	}
	var resp struct {
		Value string `json:"value"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		// Plain string return — tolerate either shape.
		var s string
		if jerr := json.Unmarshal(raw, &s); jerr == nil {
			return s, nil
		}
		return "", fmt.Errorf("ResolveToken: parse: %w", err)
	}
	return resp.Value, nil
}

// ResolvePredicate asks the subprocess to evaluate the named
// `() => bool` predicate (used by schedule jobs' EnabledRefName).
// Returns the raw JSON-RPC response so the caller can decode either
// {enabled: bool} or a bare boolean. 5-second timeout.
func (h *Host) ResolvePredicate(name string) (json.RawMessage, error) {
	if name == "" {
		return nil, fmt.Errorf("ResolvePredicate: empty name")
	}
	if h.dead.Load() {
		return nil, fmt.Errorf("ResolvePredicate: subprocess dead")
	}
	type req struct {
		Name string `json:"name"`
	}
	raw, err := h.callWithTimeout("engine/resolve_predicate", req{Name: name}, 5*time.Second)
	if err != nil {
		return nil, err
	}
	return raw, nil
}
