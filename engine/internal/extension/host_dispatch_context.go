package extension

import (
	"encoding/json"

	ioncontext "github.com/dsswift/ion/engine/internal/context"
)

// host_dispatch_context.go holds the Host's session-scoped dispatch-context
// policy state (level 3 of the four-level context cascade) and the read-only
// context walker exposed to extensions. Both are wired to JSON-RPC methods in
// host_rpc.go alongside the existing session-scoped SDK surface (tool
// suppression).

// WalkContextFilesRequest is the payload for the ext/walk_context_files RPC.
// All override flags are tri-state pointers: nil = use the built-in default.
type WalkContextFilesRequest struct {
	Cwd            string `json:"cwd,omitempty"`
	IncludeGlobal  *bool  `json:"includeGlobal,omitempty"`
	IncludeProject *bool  `json:"includeProject,omitempty"`
	ClaudeCompat   *bool  `json:"claudeCompat,omitempty"`
}

// walkContextFilesForExtension runs the pure context walker with the request's
// flags applied over the Ion preset. Returns the discovered files as-is
// (Path/Content/Source/Level) for JSON serialization back to the extension.
// Defaults: include both layers, compat off — matching the built-in level-1
// dispatch default.
func walkContextFilesForExtension(req WalkContextFilesRequest) []ioncontext.DiscoveredContext {
	if req.Cwd == "" {
		return nil
	}
	includeGlobal := true
	if req.IncludeGlobal != nil {
		includeGlobal = *req.IncludeGlobal
	}
	includeProject := true
	if req.IncludeProject != nil {
		includeProject = *req.IncludeProject
	}
	compat := false
	if req.ClaudeCompat != nil {
		compat = *req.ClaudeCompat
	}

	policy := ioncontext.ResolvedPolicy{
		IncludeGlobalContext:  includeGlobal,
		IncludeProjectContext: includeProject,
		ClaudeCompat:          compat,
	}
	_, files := ioncontext.BuildContextPrompt(req.Cwd, "ext-walk", policy)
	return files
}

// SetDispatchContextDefaults stores the session-level default context policy
// (level 3 of the dispatch context cascade). A nil policy clears the default.
func (h *Host) SetDispatchContextDefaults(policy *ContextPolicy) {
	h.dispatchCtxMu.Lock()
	defer h.dispatchCtxMu.Unlock()
	h.dispatchContextDefaults = policy
}

// GetDispatchContextDefaults returns the session-level default context policy,
// or nil when the extension has not set one.
func (h *Host) GetDispatchContextDefaults() *ContextPolicy {
	h.dispatchCtxMu.RLock()
	defer h.dispatchCtxMu.RUnlock()
	return h.dispatchContextDefaults
}

// handleSetDispatchContextDefaults services the ext/set_dispatch_context_defaults
// RPC (level 3 of the dispatch context cascade). Extracted from host_rpc.go's
// dispatch switch to keep that file under the 800-line cap.
func (h *Host) handleSetDispatchContextDefaults(id int64, raw []byte) {
	var req struct {
		Params ContextPolicy `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "invalid params: " + err.Error()})
		return
	}
	policy := req.Params
	h.SetDispatchContextDefaults(&policy)
	h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)
}

// handleWalkContextFiles services the ext/walk_context_files RPC: a read-only
// exposure of the context walker so extensions can compose custom context in
// before_agent_start. No injection side effect. Extracted from host_rpc.go to
// keep that file under the 800-line cap.
func (h *Host) handleWalkContextFiles(id int64, raw []byte) {
	var req struct {
		Params WalkContextFilesRequest `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "invalid params: " + err.Error()})
		return
	}
	files := walkContextFilesForExtension(req.Params)
	data, _ := json.Marshal(files) //nolint:errcheck // marshal of a local slice
	h.sendResponse(id, json.RawMessage(data), nil)
}
