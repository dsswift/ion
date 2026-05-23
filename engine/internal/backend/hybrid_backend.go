package backend

import (
	"fmt"
	"sync"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// HybridBackend implements RunBackend by wrapping both a *CliBackend and a
// *ApiBackend and routing each individual run to the correct inner backend
// based on the resolved provider ID of the run's model.
//
// Routing rule:
//
//   - providers.GetModelInfo(model).ProviderID == "anthropic" → *CliBackend
//     (the Claude Code subscription path, no API key required)
//   - everything else, including unregistered models → *ApiBackend
//     (the native HTTP provider path, uses provider API keys)
//
// The routing decision is made once per run, at StartRun / StartRunWithConfig
// time, and recorded in a per-run table. All subsequent Cancel / IsRunning /
// WriteToStdin / Steer calls look up the table instead of re-resolving the
// model — this guarantees consistency across the lifetime of a run even if
// the global model catalog mutates underneath us.
//
// Activation: set "backend": "hybrid" in ~/.ion/engine.json. The existing
// "cli" and "api" values continue to behave exactly as today; "hybrid" is
// purely additive and opt-in.
//
// HybridBackend never blocks for user input, never persists user preferences,
// and never knows that a UI exists. Routing is a pure mechanical decision
// based on the resolved model. See docs/engine-grounding.md §2.
type HybridBackend struct {
	cli *CliBackend
	api *ApiBackend

	mu   sync.RWMutex
	runs map[string]RunBackend // requestID → inner backend (h.cli or h.api)

	// Outer hooks registered by the server / session manager. The inner
	// backends fan out through us so we can prune the routing table on
	// exit before forwarding the manager's handler.
	hookMu       sync.RWMutex
	onNormalized func(string, types.NormalizedEvent)
	onExit       func(string, *int, *string, string)
	onError      func(string, error)
}

// NewHybridBackend constructs a HybridBackend with fresh inner CLI and API
// backends. Callers should attach the process-wide auth resolver via
// SetAuthResolver before dispatching any runs.
func NewHybridBackend() *HybridBackend {
	h := &HybridBackend{
		cli:  NewCliBackend(),
		api:  NewApiBackend(),
		runs: make(map[string]RunBackend),
	}
	// Wire the inner backends' callbacks to our fan-out methods. This
	// chokepoint is what lets us prune the routing table on OnExit before
	// the manager's handler runs.
	h.cli.OnNormalized(h.fanOutNormalized)
	h.api.OnNormalized(h.fanOutNormalized)
	h.cli.OnExit(h.fanOutExit)
	h.api.OnExit(h.fanOutExit)
	h.cli.OnError(h.fanOutError)
	h.api.OnError(h.fanOutError)
	utils.Log("Hybrid", "NewHybridBackend: constructed (inner cli + api callbacks wired)")
	return h
}

// SetAuthResolver forwards the auth resolver to the inner *ApiBackend. The
// CLI path is subscription-based and never touches the resolver, so it
// receives no notification here.
func (h *HybridBackend) SetAuthResolver(r *auth.Resolver) {
	utils.Log("Hybrid", fmt.Sprintf("SetAuthResolver: forwarding to inner ApiBackend (nil=%t)", r == nil))
	h.api.SetAuthResolver(r)
}

// InnerApi returns the inner *ApiBackend. Used by the session package's
// resolvedBackend helper so existing call sites that need API-only methods
// (StartRunWithConfig, GetContextUsage, SearchHistory) can reach them.
func (h *HybridBackend) InnerApi() *ApiBackend { return h.api }

// InnerCli returns the inner *CliBackend. Used by the session package's
// resolvedBackend helper so existing call sites that need to detect CLI
// behavior continue to work.
func (h *HybridBackend) InnerCli() *CliBackend { return h.cli }

// chooseFor returns the inner backend that should handle a run for the
// given model. The lookup goes through the canonical model→provider
// resolver (providers.GetModelInfo); unknown models default to ApiBackend
// so the user sees a clean provider error rather than the misleading
// "model not available" surface CLI would emit.
func (h *HybridBackend) chooseFor(model string) RunBackend {
	info := providers.GetModelInfo(model)
	if info != nil && info.ProviderID == "anthropic" {
		return h.cli
	}
	return h.api
}

// StartRun records the routing decision and dispatches to the chosen inner
// backend. CLI-routed runs go through CliBackend.StartRun directly; API-
// routed runs go through ApiBackend.StartRun (no per-run config). Callers
// who need per-run config should use StartRunWithConfig.
func (h *HybridBackend) StartRun(requestID string, options types.RunOptions) {
	inner := h.chooseFor(options.Model)
	h.recordRun(requestID, inner, options.Model)
	inner.StartRun(requestID, options)
}

// StartRunWithConfig is the per-run-config dispatch path used by the
// session manager. For API-routed runs we forward the RunConfig to the
// inner ApiBackend.StartRunWithConfig so hooks, permission engine, MCP
// tools, agent spawner, and telemetry attach correctly. For CLI-routed
// runs we fall back to StartRun on the inner CliBackend (which wires its
// own hooks via subprocess flags and ignores per-run config).
func (h *HybridBackend) StartRunWithConfig(requestID string, options types.RunOptions, cfg *RunConfig) {
	inner := h.chooseFor(options.Model)
	h.recordRun(requestID, inner, options.Model)
	if api, ok := inner.(*ApiBackend); ok {
		utils.Log("Hybrid", fmt.Sprintf("StartRunWithConfig: requestID=%s forwarding to inner ApiBackend (cfg=%t)", requestID, cfg != nil))
		api.StartRunWithConfig(requestID, options, cfg)
		return
	}
	utils.Log("Hybrid", fmt.Sprintf("StartRunWithConfig: requestID=%s CLI-routed, falling back to StartRun (cfg ignored)", requestID))
	inner.StartRun(requestID, options)
}

// recordRun is the single place that mutates the routing table on entry.
// It records the chosen inner backend and emits a routing log line that
// makes the decision visible in ~/.ion/engine.log.
func (h *HybridBackend) recordRun(requestID string, inner RunBackend, model string) {
	h.mu.Lock()
	h.runs[requestID] = inner
	size := len(h.runs)
	h.mu.Unlock()
	kind := "api"
	if inner == h.cli {
		kind = "cli"
	}
	providerID := "<unknown>"
	if info := providers.GetModelInfo(model); info != nil {
		providerID = info.ProviderID
	}
	utils.Log("Hybrid", fmt.Sprintf(
		"StartRun: requestID=%s model=%s providerID=%s → %s (table size=%d)",
		requestID, model, providerID, kind, size))
}

// lookup returns the inner backend recorded for a requestID, or nil if no
// such run is registered (e.g. Cancel called for an unknown ID).
func (h *HybridBackend) lookup(requestID string) RunBackend {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.runs[requestID]
}

// Cancel routes to the recorded inner backend. Returns false when the
// requestID is not in the routing table; the miss is logged so unexpected
// cancel calls are observable.
func (h *HybridBackend) Cancel(requestID string) bool {
	inner := h.lookup(requestID)
	if inner == nil {
		utils.Log("Hybrid", fmt.Sprintf("Cancel: requestID=%s not in routing table", requestID))
		return false
	}
	kind := "api"
	if inner == h.cli {
		kind = "cli"
	}
	utils.Log("Hybrid", fmt.Sprintf("Cancel: requestID=%s → %s", requestID, kind))
	return inner.Cancel(requestID)
}

// IsRunning routes to the recorded inner backend. Returns false when the
// requestID is unknown (not started under this hybrid, or already exited
// and pruned from the table).
func (h *HybridBackend) IsRunning(requestID string) bool {
	inner := h.lookup(requestID)
	if inner == nil {
		return false
	}
	return inner.IsRunning(requestID)
}

// WriteToStdin routes to the recorded inner backend. CLI-routed runs use
// the stdin pipe; API-routed runs are a no-op (the inner ApiBackend's
// WriteToStdin is a no-op by design — see api_backend.go).
func (h *HybridBackend) WriteToStdin(requestID string, msg interface{}) error {
	inner := h.lookup(requestID)
	if inner == nil {
		utils.Log("Hybrid", fmt.Sprintf("WriteToStdin: requestID=%s not in routing table", requestID))
		return nil
	}
	return inner.WriteToStdin(requestID, msg)
}

// Steer satisfies a local `steerable` interface in the session package.
// Returns true if the run was steered via the API path (inner ApiBackend.Steer
// returned true). Returns false for CLI-routed runs so the caller can fall
// back to the stdin pipe path. Steer is not part of the RunBackend interface;
// it is an additive method to keep the contract surface stable.
func (h *HybridBackend) Steer(requestID, message string) bool {
	inner := h.lookup(requestID)
	api, ok := inner.(*ApiBackend)
	if !ok {
		utils.Log("Hybrid", fmt.Sprintf("Steer: requestID=%s not API-routed (inner=%T), falling back", requestID, inner))
		return false
	}
	return api.Steer(requestID, message)
}

// FlushConversations forwards to both inner backends. ApiBackend persists
// in-flight conversations; CliBackend is a no-op (the subprocess persists
// its own).
func (h *HybridBackend) FlushConversations() {
	h.api.FlushConversations()
	h.cli.FlushConversations()
}

// OnNormalized stores the outer normalized-event handler. Inner backends
// invoke fanOutNormalized which forwards to this handler.
func (h *HybridBackend) OnNormalized(fn func(string, types.NormalizedEvent)) {
	h.hookMu.Lock()
	defer h.hookMu.Unlock()
	h.onNormalized = fn
}

// OnError stores the outer error handler.
func (h *HybridBackend) OnError(fn func(string, error)) {
	h.hookMu.Lock()
	defer h.hookMu.Unlock()
	h.onError = fn
}

// OnExit stores the outer exit handler. The inner backends invoke
// fanOutExit, which prunes the routing table and then forwards to this
// handler.
func (h *HybridBackend) OnExit(fn func(string, *int, *string, string)) {
	h.hookMu.Lock()
	defer h.hookMu.Unlock()
	h.onExit = fn
}

// fanOutNormalized is registered on both inner backends. It forwards
// normalized events to the outer handler set via OnNormalized.
func (h *HybridBackend) fanOutNormalized(runID string, ev types.NormalizedEvent) {
	h.hookMu.RLock()
	fn := h.onNormalized
	h.hookMu.RUnlock()
	if fn != nil {
		fn(runID, ev)
	}
}

// fanOutError is registered on both inner backends. It forwards run errors
// to the outer handler set via OnError.
func (h *HybridBackend) fanOutError(runID string, err error) {
	h.hookMu.RLock()
	fn := h.onError
	h.hookMu.RUnlock()
	if fn != nil {
		fn(runID, err)
	}
}

// fanOutExit is registered on both inner backends. It prunes the routing
// table for the exiting run before forwarding to the outer handler set
// via OnExit. The prune happens unconditionally so the table never leaks
// — even if the manager has not registered an OnExit handler.
func (h *HybridBackend) fanOutExit(runID string, code *int, signal *string, sessionID string) {
	h.mu.Lock()
	_, existed := h.runs[runID]
	delete(h.runs, runID)
	size := len(h.runs)
	h.mu.Unlock()
	utils.Log("Hybrid", fmt.Sprintf("OnExit: requestID=%s removed=%t routing table size=%d", runID, existed, size))

	h.hookMu.RLock()
	fn := h.onExit
	h.hookMu.RUnlock()
	if fn != nil {
		fn(runID, code, signal, sessionID)
	}
}

// NewChild produces a fresh HybridBackend for ion_agent child dispatches.
// The child's inner *ApiBackend inherits the parent's auth resolver so
// non-Claude child runs (gpt-*, gemini-*, ollama) can resolve provider
// credentials. Without this propagation, child agents dispatched under
// hybrid would fail silently for non-Claude models.
//
// The child has its own independent routing table and its own inner
// CliBackend / ApiBackend instances; it does not share state with the
// parent. This mirrors how newChildBackend behaves for plain Cli/Api
// backends.
func (h *HybridBackend) NewChild() *HybridBackend {
	child := NewHybridBackend()
	resolver := h.api.AuthResolver()
	if resolver != nil {
		child.api.SetAuthResolver(resolver)
	}
	utils.Log("Hybrid", fmt.Sprintf("NewChild: created child hybrid backend authResolver=%t", resolver != nil))
	return child
}
