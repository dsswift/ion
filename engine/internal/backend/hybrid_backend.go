package backend

import (
	"sync"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// HybridBackend implements RunBackend by owning a set of inner backends keyed
// by kind ("api", "claude-code", "codex", "grok", "cursor") and routing each
// individual run to the correct inner backend based on the resolved provider
// ID of the run's model and the operator's per-provider backend preferences.
//
// Routing (see EffectiveBackendForProvider in hybrid_routing.go):
//
//   - resolve the model's provider ID via providers.GetModelInfo
//   - if the operator pinned that provider to a backend kind
//     (providers.<id>.backend in engine.json), use it
//   - otherwise decide from live credentials: an available API key wins
//     ("api"); else an installed+authenticated delegated CLI wins (its kind);
//     else "api" (clean missing-key error), except CLI-only providers which
//     stay on their CLI so the error names the real problem
//
// The routing decision is made once per run, at StartRun / StartRunWithConfig
// time, and recorded in a per-run table. All subsequent Cancel / IsRunning /
// WriteToStdin / Steer calls look up the table instead of re-resolving the
// model — this guarantees consistency across the lifetime of a run even if the
// global model catalog mutates underneath us.
//
// Inner backends are constructed lazily on first route to their kind, so a
// process that never routes to codex does not spawn a codex app-server.
//
// Activation: set "backend": "hybrid" in ~/.ion/engine.json. The top-level
// "claude-code" and "api" values keep all-runs-one-backend semantics; "hybrid"
// is purely additive and opt-in.
//
// HybridBackend never blocks for user input, never persists user preferences,
// and never knows that a UI exists. Routing is a pure mechanical decision
// based on the resolved model. See docs/engine-grounding.md §2.
type HybridBackend struct {
	// prefs maps providerID → backend kind for operator-pinned providers.
	// Providers using the default rule are absent. Immutable after
	// construction (copied in), so it needs no lock.
	prefs map[string]string

	mu       sync.Mutex
	inner    map[string]RunBackend // kind → backend (lazily constructed)
	runs     map[string]RunBackend // requestID → inner backend
	runKinds map[string]string     // requestID → kind (for observability)
	resolver *auth.Resolver        // applied to every api-capable inner

	// keys is the routing view of the resolver (set alongside resolver in
	// SetAuthResolver; tests substitute a fake). Nil ⇒ "no key anywhere", so
	// routing falls through to the CLI-auth check. Guarded by h.mu.
	keys KeyHaver

	// cliAuthed reports whether the delegated CLI for a kind
	// ("claude-code"/"codex"/"grok"/"cursor") is installed AND authenticated
	// right now. Injected by the server from its live cliprobe.Registry via
	// SetCliAuthProbe. Nil ⇒ treated as "no CLI available" (routing degrades
	// safely to api). Guarded by h.mu.
	cliAuthed func(kind string) bool

	// Outer hooks registered by the server / session manager. The inner
	// backends fan out through us so we can prune the routing table on
	// exit before forwarding the manager's handler.
	hookMu       sync.RWMutex
	onNormalized func(string, types.NormalizedEvent)
	onExit       func(string, *int, *string, string)
	onError      func(string, error)
}

// NewHybridBackend constructs a HybridBackend using the default routing rule
// (no per-provider preferences). Callers should attach the process-wide auth
// resolver via SetAuthResolver before dispatching any runs.
func NewHybridBackend() *HybridBackend {
	return NewHybridBackendWithPrefs(nil)
}

// NewHybridBackendWithPrefs constructs a HybridBackend with the given
// provider→kind preferences (typically built from engine.json via
// config.ProviderBackendPrefs). A nil or empty map yields pure default-rule
// routing, identical to NewHybridBackend.
func NewHybridBackendWithPrefs(prefs map[string]string) *HybridBackend {
	copied := make(map[string]string, len(prefs))
	for k, v := range prefs {
		copied[k] = v
	}
	h := &HybridBackend{
		prefs:    copied,
		inner:    make(map[string]RunBackend),
		runs:     make(map[string]RunBackend),
		runKinds: make(map[string]string),
	}
	utils.LogWithFields(utils.LevelInfo, "backend.hybrid", "constructed", map[string]any{"pref_count": len(copied)})
	return h
}

// build constructs the inner backend for a kind, wires its fan-out callbacks,
// and applies the auth resolver to api-capable inners. Must be called with
// h.mu held. Unknown kinds (codex/grok/cursor before their backends land, or a
// typo that slipped past validation) fall back to the API backend with a WARN
// so the engine keeps serving.
func (h *HybridBackend) build(kind string) RunBackend {
	var b RunBackend
	switch kind {
	case "claude-code":
		b = NewClaudeCodeBackend()
	case "codex":
		b = NewCodexBackend()
	case "grok":
		b = NewGrokBackend()
	case "cursor":
		b = NewCursorBackend()
	case "api":
		b = h.newAPI()
	default:
		utils.LogWithFields(utils.LevelWarn, "backend.hybrid", "backend kind not available, falling back to api", map[string]any{"kind": kind})
		b = h.newAPI()
	}
	b.OnNormalized(h.fanOutNormalized)
	b.OnExit(h.fanOutExit)
	b.OnError(h.fanOutError)
	utils.LogWithFields(utils.LevelInfo, "backend.hybrid", "inner backend constructed", map[string]any{"kind": kind})
	return b
}

// newAPI constructs an *ApiBackend with the current auth resolver applied.
// Must be called with h.mu held.
func (h *HybridBackend) newAPI() *ApiBackend {
	api := NewApiBackend()
	if h.resolver != nil {
		api.SetAuthResolver(h.resolver)
	}
	return api
}

// get returns the inner backend for a kind, constructing it on first use.
func (h *HybridBackend) get(kind string) RunBackend {
	h.mu.Lock()
	defer h.mu.Unlock()
	if b, ok := h.inner[kind]; ok {
		return b
	}
	b := h.build(kind)
	h.inner[kind] = b
	return b
}

// kindFor lives in hybrid_routing.go alongside the shared credential-based
// decision helper (EffectiveBackendForProvider).

// effectiveKind maps a requested backend kind to the kind that actually has an
// implementation. Kinds whose backend has not landed yet (codex, grok, cursor
// before their respective commits) degrade to "api" so routing never spawns a
// duplicate stand-in under the requested key. This is the single list of
// buildable kinds; each new backend commit adds its kind here and a matching
// case in build.
func effectiveKind(requested string) string {
	switch requested {
	case "api", "claude-code", "codex", "grok", "cursor":
		return requested
	default:
		return "api"
	}
}

// resolveKind returns the effective kind for a model and logs a downgrade when
// the requested kind is not yet available.
func (h *HybridBackend) resolveKind(model string) string {
	requested := h.kindFor(model)
	eff := effectiveKind(requested)
	if eff != requested {
		utils.LogWithFields(utils.LevelWarn, "backend.hybrid", "requested backend kind unavailable, routing to api", map[string]any{
			"model":     model,
			"requested": requested,
			"effective": eff,
		})
	}
	return eff
}

// ResolveFor returns the inner backend that should handle a run for the given
// model, constructing it if necessary. This is the single routing entry point;
// the session package's resolvedBackend helper delegates here so routing logic
// lives in exactly one place.
func (h *HybridBackend) ResolveFor(model string) RunBackend {
	return h.get(h.resolveKind(model))
}

// SetAuthResolver stores the resolver and forwards it to every api-capable
// inner backend (existing and future). CLI-subscription inners
// (claude-code/codex/grok/cursor) do not consult the resolver.
func (h *HybridBackend) SetAuthResolver(r *auth.Resolver) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.resolver = r
	// Mirror into the routing seam. Assign nil explicitly rather than a typed
	// nil *auth.Resolver, which would make the interface non-nil and panic on
	// HasKey.
	if r != nil {
		h.keys = r
	} else {
		h.keys = nil
	}
	applied := 0
	for _, b := range h.inner {
		if api, ok := b.(*ApiBackend); ok {
			api.SetAuthResolver(r)
			applied++
		}
	}
	utils.LogWithFields(utils.LevelInfo, "backend.hybrid", "SetAuthResolver: stored and forwarded to api inners", map[string]any{
		"nil":     r == nil,
		"applied": applied,
	})
}

// InnerApi returns the inner *ApiBackend, constructing it if necessary. Used by
// the session package's watchdog / human-wait helpers, which only the
// ApiBackend implements.
func (h *HybridBackend) InnerApi() *ApiBackend { return h.get("api").(*ApiBackend) }

// InnerClaudeCode returns the inner *ClaudeCodeBackend, constructing it if
// necessary. Used by the session package's resolvedBackend helper for the
// Claude Code path. Returns nil if the "claude-code" inner had to fall back
// (should never happen — claude-code is always buildable).
func (h *HybridBackend) InnerClaudeCode() *ClaudeCodeBackend {
	if cc, ok := h.get("claude-code").(*ClaudeCodeBackend); ok {
		return cc
	}
	return nil
}

// StartRun records the routing decision and dispatches to the chosen inner
// backend. Callers who need per-run config should use StartRunWithConfig.
func (h *HybridBackend) StartRun(requestID string, options types.RunOptions) {
	kind := h.resolveKind(options.Model)
	inner := h.get(kind)
	h.recordRun(requestID, inner, kind, options.Model)
	inner.StartRun(requestID, options)
}

// StartRunWithConfig is the per-run-config dispatch path used by the session
// manager. For API-routed runs we forward the RunConfig to the inner
// ApiBackend.StartRunWithConfig so hooks, permission engine, MCP tools, agent
// spawner, and telemetry attach correctly. For subscription-routed runs
// (claude-code/codex/grok/cursor) we fall back to StartRun on the inner
// backend, which wires its own hooks via its subprocess protocol.
func (h *HybridBackend) StartRunWithConfig(requestID string, options types.RunOptions, cfg *RunConfig) {
	kind := h.resolveKind(options.Model)
	inner := h.get(kind)
	h.recordRun(requestID, inner, kind, options.Model)
	if api, ok := inner.(*ApiBackend); ok {
		utils.LogWithFields(utils.LevelInfo, "backend.hybrid", "StartRunWithConfig: forwarding to inner ApiBackend", map[string]any{
			"request_id": requestID,
			"kind":       kind,
			"cfg":        cfg != nil,
		})
		api.StartRunWithConfig(requestID, options, cfg)
		return
	}
	utils.LogWithFields(utils.LevelInfo, "backend.hybrid", "StartRunWithConfig: subscription-routed, falling back to StartRun (cfg ignored)", map[string]any{
		"request_id": requestID,
		"kind":       kind,
	})
	inner.StartRun(requestID, options)
}

// recordRun is the single place that mutates the routing table on entry. It
// records the chosen inner backend and its kind, and emits a routing log line
// that makes the decision visible in ~/.ion/engine.jsonl.
func (h *HybridBackend) recordRun(requestID string, inner RunBackend, kind, model string) {
	h.mu.Lock()
	h.runs[requestID] = inner
	h.runKinds[requestID] = kind
	size := len(h.runs)
	h.mu.Unlock()
	providerID := "<unknown>"
	if info := providers.GetModelInfo(model); info != nil {
		providerID = info.ProviderID
	}
	utils.LogWithFields(utils.LevelInfo, "backend.hybrid", "StartRun routed", map[string]any{
		"request_id":  requestID,
		"model":       model,
		"provider_id": providerID,
		"kind":        kind,
		"size":        size,
	})
}

// lookup returns the inner backend and kind recorded for a requestID, or (nil,
// "") if no such run is registered.
func (h *HybridBackend) lookup(requestID string) (RunBackend, string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.runs[requestID], h.runKinds[requestID]
}

// Cancel routes to the recorded inner backend. Returns false when the
// requestID is not in the routing table; the miss is logged so unexpected
// cancel calls are observable.
func (h *HybridBackend) Cancel(requestID string) bool {
	inner, kind := h.lookup(requestID)
	if inner == nil {
		utils.LogWithFields(utils.LevelInfo, "backend.hybrid", "Cancel: not in routing table", map[string]any{
			"request_id": requestID,
		})
		return false
	}
	utils.LogWithFields(utils.LevelInfo, "backend.hybrid", "Cancel routed", map[string]any{
		"request_id": requestID,
		"kind":       kind,
	})
	return inner.Cancel(requestID)
}

// IsRunning routes to the recorded inner backend. Returns false when the
// requestID is unknown (not started under this hybrid, or already exited and
// pruned from the table).
func (h *HybridBackend) IsRunning(requestID string) bool {
	inner, _ := h.lookup(requestID)
	if inner == nil {
		return false
	}
	return inner.IsRunning(requestID)
}

// WriteToStdin routes to the recorded inner backend.
func (h *HybridBackend) WriteToStdin(requestID string, msg interface{}) error {
	inner, _ := h.lookup(requestID)
	if inner == nil {
		utils.LogWithFields(utils.LevelInfo, "backend.hybrid", "WriteToStdin: not in routing table", map[string]any{
			"request_id": requestID,
		})
		return nil
	}
	return inner.WriteToStdin(requestID, msg)
}

// Steer satisfies a local `steerable` interface in the session package.
// Returns true if the run was steered via the API path. Returns false for
// non-API-routed runs so the caller can fall back to the stdin pipe path.
// Steer is not part of the RunBackend interface; it is additive.
func (h *HybridBackend) Steer(requestID, message string) bool {
	inner, kind := h.lookup(requestID)
	api, ok := inner.(*ApiBackend)
	if !ok {
		utils.LogWithFields(utils.LevelInfo, "backend.hybrid", "Steer: not API-routed, falling back", map[string]any{
			"request_id": requestID,
			"kind":       kind,
		})
		return false
	}
	return api.Steer(requestID, message)
}

// SteerWithReason mirrors Steer but returns the typed backend verdict so the
// session layer can distinguish "no run" from "channel full". For a non-API-
// routed run it returns SteerResultNoRun, which the session layer treats as
// "not API-steerable, fall back to the stdin pipe".
func (h *HybridBackend) SteerWithReason(requestID, message string) SteerResult {
	inner, kind := h.lookup(requestID)
	api, ok := inner.(*ApiBackend)
	if !ok {
		utils.LogWithFields(utils.LevelInfo, "backend.hybrid", "SteerWithReason: not API-routed, falling back to stdin", map[string]any{
			"request_id": requestID,
			"kind":       kind,
		})
		return SteerResultNoRun
	}
	return api.SteerWithReason(requestID, message)
}

// FlushConversations forwards to every constructed inner backend. ApiBackend
// persists in-flight conversations; subscription inners are no-ops (their
// subprocess persists its own).
func (h *HybridBackend) FlushConversations() {
	h.mu.Lock()
	inners := make([]RunBackend, 0, len(h.inner))
	for _, b := range h.inner {
		inners = append(inners, b)
	}
	h.mu.Unlock()
	for _, b := range inners {
		b.FlushConversations()
	}
}

// OnNormalized stores the outer normalized-event handler. Inner backends invoke
// fanOutNormalized which forwards to this handler.
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

// OnExit stores the outer exit handler. The inner backends invoke fanOutExit,
// which prunes the routing table and then forwards to this handler.
func (h *HybridBackend) OnExit(fn func(string, *int, *string, string)) {
	h.hookMu.Lock()
	defer h.hookMu.Unlock()
	h.onExit = fn
}

// fanOutNormalized forwards normalized events from any inner backend to the
// outer handler set via OnNormalized.
func (h *HybridBackend) fanOutNormalized(runID string, ev types.NormalizedEvent) {
	h.hookMu.RLock()
	fn := h.onNormalized
	h.hookMu.RUnlock()
	if fn != nil {
		fn(runID, ev)
	}
}

// fanOutError forwards run errors from any inner backend to the outer handler
// set via OnError.
func (h *HybridBackend) fanOutError(runID string, err error) {
	h.hookMu.RLock()
	fn := h.onError
	h.hookMu.RUnlock()
	if fn != nil {
		fn(runID, err)
	}
}

// fanOutExit prunes the routing table for the exiting run before forwarding to
// the outer handler set via OnExit. The prune happens unconditionally so the
// table never leaks — even if the manager has not registered an OnExit handler.
func (h *HybridBackend) fanOutExit(runID string, code *int, signal *string, sessionID string) {
	h.mu.Lock()
	_, existed := h.runs[runID]
	delete(h.runs, runID)
	delete(h.runKinds, runID)
	size := len(h.runs)
	h.mu.Unlock()
	utils.LogWithFields(utils.LevelInfo, "backend.hybrid", "OnExit: routing table pruned", map[string]any{
		"request_id": runID,
		"removed":    existed,
		"size":       size,
	})

	h.hookMu.RLock()
	fn := h.onExit
	h.hookMu.RUnlock()
	if fn != nil {
		fn(runID, code, signal, sessionID)
	}
}

// NewChild produces a fresh HybridBackend for ion_agent child dispatches. The
// child inherits the parent's provider preferences and auth resolver so
// non-Claude child runs (gpt-*, gemini-*, ollama) can resolve provider
// credentials and honor the same per-provider routing. The child has its own
// independent routing table and inner backends; it does not share state with
// the parent.
func (h *HybridBackend) NewChild() *HybridBackend {
	child := NewHybridBackendWithPrefs(h.prefs)
	h.mu.Lock()
	resolver := h.resolver
	cliAuthed := h.cliAuthed
	h.mu.Unlock()
	if resolver != nil {
		child.SetAuthResolver(resolver)
	}
	// Propagate the live CLI-auth probe so child agent dispatches route by the
	// same credential view as the parent.
	if cliAuthed != nil {
		child.SetCliAuthProbe(cliAuthed)
	}
	utils.LogWithFields(utils.LevelInfo, "backend.hybrid", "NewChild: created child hybrid backend", map[string]any{
		"auth_resolver":  resolver != nil,
		"cli_auth_probe": cliAuthed != nil,
		"pref_count":     len(h.prefs),
	})
	return child
}
