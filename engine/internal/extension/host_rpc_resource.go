// Resource-subsystem RPC handlers for the extension host. Implements:
//   ext/declare_resource  -- subprocess declares a resource kind (engine side)
//   ext/publish_resource  -- subprocess publishes a delta (engine side)
//   resource/query        -- engine queries extension for snapshot items (subprocess side)
//   CommitPendingResourceDecls -- wires init-time declarations onto a broker
//
// Pattern mirrors host_rpc_async.go: parse params, get ctx, call the
// wired function, send success or -32000 error response.

package extension

import (
	"encoding/json"
	"fmt"

	"github.com/dsswift/ion/engine/internal/resource"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

func (h *Host) handleDeclareResource(id int64, raw []byte) {
	var req struct {
		Params DeclareResourceParams `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		utils.Log("extension", fmt.Sprintf("ext/declare_resource: parse error: %v", err))
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}

	ctx := h.ctxStack.Current()
	if ctx == nil || ctx.DeclareResource == nil {
		utils.Log("extension", "ext/declare_resource: no ctx or DeclareResource not wired; rejecting")
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "declareResource not available outside an active session"})
		return
	}

	decl := types.ResourceDeclaration{Kind: req.Params.Kind}
	if err := ctx.DeclareResource(decl); err != nil {
		utils.Log("extension", fmt.Sprintf("ext/declare_resource: ext=%s kind=%q rejected: %v", h.name, req.Params.Kind, err))
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
		return
	}

	utils.Log("extension", fmt.Sprintf("ext/declare_resource: ext=%s kind=%q registered", h.name, req.Params.Kind))
	resp, _ := json.Marshal(struct {
		OK   bool   `json:"ok"`
		Kind string `json:"kind"`
	}{OK: true, Kind: req.Params.Kind})
	h.sendResponse(id, resp, nil)
}

func (h *Host) handlePublishResource(id int64, raw []byte) {
	var req struct {
		Params PublishResourceParams `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		utils.Log("extension", fmt.Sprintf("ext/publish_resource: parse error: %v", err))
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}

	ctx := h.ctxStack.Current()
	var publishFn func(string, types.ResourceDelta) error
	if ctx != nil && ctx.PublishResource != nil {
		publishFn = ctx.PublishResource
	} else {
		// Fall back to persistent publish (for onComplete callbacks
		// from background dispatches that fire after the run exits).
		h.notifMu.RLock()
		pf := h.persistentPublishResource
		h.notifMu.RUnlock()
		publishFn = pf
	}
	if publishFn == nil {
		utils.Log("extension", "ext/publish_resource: no ctx and no persistent publish; rejecting")
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "publishResource not available"})
		return
	}

	delta := types.ResourceDelta{
		Op:   req.Params.Op,
		Item: req.Params.Item,
	}
	if err := publishFn(req.Params.Kind, delta); err != nil {
		utils.Log("extension", fmt.Sprintf("ext/publish_resource: ext=%s kind=%q op=%q failed: %v", h.name, req.Params.Kind, req.Params.Op, err))
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
		return
	}

	utils.Debug("extension", fmt.Sprintf("ext/publish_resource: ext=%s kind=%q op=%q published", h.name, req.Params.Kind, req.Params.Op))
	resp, _ := json.Marshal(struct {
		OK bool `json:"ok"`
	}{OK: true})
	h.sendResponse(id, resp, nil)
}

// CallResourceQuery sends a resource/query RPC to the extension subprocess
// and returns the items the extension's registered onQuery handler produces.
// Called by the broker when a client subscribes and needs the initial snapshot.
func (h *Host) CallResourceQuery(kind string, filter types.ResourceFilter) ([]types.ResourceItem, error) {
	params := struct {
		Kind   string               `json:"kind"`
		Filter types.ResourceFilter `json:"filter"`
	}{Kind: kind, Filter: filter}
	raw, err := h.call("resource/query", params)
	if err != nil {
		return nil, fmt.Errorf("resource/query kind=%s: %w", kind, err)
	}
	var items []types.ResourceItem
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, fmt.Errorf("resource/query kind=%s: decode response: %w", kind, err)
	}
	return items, nil
}

// CommitPendingResourceDecls walks the resource declarations stashed during
// the init handshake and registers each one on the given broker. The query
// handler for each kind is wired to call back into the extension subprocess
// via the resource/query RPC, so the broker can deliver snapshots when
// clients subscribe.
//
// Pattern mirrors CommitPendingAsyncDecls for webhooks and schedules.
// Returns a slice of per-kind errors so callers can log failures without
// aborting all registrations.
func (h *Host) CommitPendingResourceDecls(broker *resource.Broker) []error {
	decls := h.pendingInitResources
	if len(decls) == 0 {
		return nil
	}
	var errs []error
	for _, decl := range decls {
		fph := &resource.FuncProducerHost{}
		if err := broker.RegisterProducer(decl.Kind, fph, decl); err != nil {
			utils.Log("extension", fmt.Sprintf("CommitPendingResourceDecls: ext=%s kind=%q rejected: %v", h.name, decl.Kind, err))
			errs = append(errs, fmt.Errorf("resource %s: %w", decl.Kind, err))
			continue
		}
		// Wire the query handler: when a client subscribes the broker calls
		// this closure, which calls the extension subprocess via RPC.
		kind := decl.Kind // capture loop variable
		broker.SetQueryHandler(kind, func(filter types.ResourceFilter) ([]types.ResourceItem, error) {
			return h.CallResourceQuery(kind, filter)
		})
		utils.Log("extension", fmt.Sprintf("CommitPendingResourceDecls: ext=%s kind=%q registered with query handler", h.name, decl.Kind))
	}
	h.pendingInitResources = nil
	utils.Log("extension", fmt.Sprintf("CommitPendingResourceDecls: ext=%s committed=%d errors=%d",
		h.name, len(decls), len(errs)))
	return errs
}

// RewireResourceDecls is called after an extension respawn. It wires the new
// subprocess's query handlers onto an already-populated broker (where the
// producer was registered during the original spawn) and re-delivers snapshots
// to any subscriber that previously received an empty snapshot because the
// initial query failed (e.g. the subprocess died during its first init).
//
// Unlike CommitPendingResourceDecls, this does NOT call RegisterProducer —
// the producer entry already exists in the broker from the first spawn.
// Calling RegisterProducer again would return "already registered" and
// skip the handler update. This method skips that step and goes straight
// to the query-handler rewire + resnapshot.
func (h *Host) RewireResourceDecls(broker *resource.Broker) {
	decls := h.pendingInitResources
	if len(decls) == 0 {
		return
	}
	for _, decl := range decls {
		kind := decl.Kind // capture for closure
		utils.Log("extension", fmt.Sprintf("RewireResourceDecls: ext=%s kind=%q rewiring after respawn", h.name, kind))
		broker.RewireQueryHandlerAndResnapshot(kind, func(filter types.ResourceFilter) ([]types.ResourceItem, error) {
			return h.CallResourceQuery(kind, filter)
		})
	}
	h.pendingInitResources = nil
	utils.Log("extension", fmt.Sprintf("RewireResourceDecls: ext=%s rewired=%d kinds", h.name, len(decls)))
}

// handleNotify handles ext/notify: an extension calls ctx.notify() and the
// engine routes the notification through the relay's push channel.
func (h *Host) handleNotify(id int64, raw []byte) {
	var req struct {
		Params types.NotifyOpts `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		utils.Log("extension", fmt.Sprintf("ext/notify: parse error: %v", err))
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}

	ctx := h.ctxStack.Current()
	if ctx == nil || ctx.Notify == nil {
		utils.Debug("extension", "ext/notify: no ctx or Notify not wired")
		h.sendResponse(id, nil, &jsonrpcError{Code: -32603, Message: "notification subsystem not available"})
		return
	}

	if err := ctx.Notify(req.Params); err != nil {
		utils.Log("extension", fmt.Sprintf("ext/notify: ext=%s err=%v", h.name, err))
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
		return
	}

	utils.Debug("extension", fmt.Sprintf("ext/notify: ext=%s kind=%s title=%q", h.name, req.Params.Kind, req.Params.Title))
	h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)
}

// handleListSessions handles ext/list_sessions.
func (h *Host) handleListSessions(id int64, raw []byte) {
	ctx := h.ctxStack.Current()
	if ctx == nil || ctx.ListSessions == nil {
		utils.Debug("extension", "ext/list_sessions: no ctx or not wired")
		h.sendResponse(id, nil, &jsonrpcError{Code: -32603, Message: "session list not available"})
		return
	}

	entries, err := ctx.ListSessions()
	if err != nil {
		utils.Log("extension", fmt.Sprintf("ext/list_sessions: error: %v", err))
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
		return
	}

	data, err := json.Marshal(entries)
	if err != nil {
		utils.Error("extension", fmt.Sprintf("ext/list_sessions: marshal error: %v", err))
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "marshal error"})
		return
	}

	utils.Debug("extension", fmt.Sprintf("ext/list_sessions: ext=%s returning %d sessions", h.name, len(entries)))
	h.sendResponse(id, data, nil)
}

// handleSendToSession handles ext/send_to_session.
func (h *Host) handleSendToSession(id int64, raw []byte) {
	var req struct {
		Params struct {
			TargetKey string                 `json:"targetKey"`
			Kind      string                 `json:"kind"`
			Payload   map[string]interface{} `json:"payload"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		utils.Error("extension", fmt.Sprintf("ext/send_to_session: parse error: %v", err))
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "invalid params"})
		return
	}

	ctx := h.ctxStack.Current()
	if ctx == nil || ctx.SendToSession == nil {
		utils.Debug("extension", "ext/send_to_session: no ctx or not wired")
		h.sendResponse(id, nil, &jsonrpcError{Code: -32603, Message: "cross-session messaging not available"})
		return
	}

	if err := ctx.SendToSession(req.Params.TargetKey, req.Params.Kind, req.Params.Payload); err != nil {
		utils.Log("extension", fmt.Sprintf("ext/send_to_session: target=%s kind=%s error: %v", req.Params.TargetKey, req.Params.Kind, err))
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
		return
	}

	utils.Debug("extension", fmt.Sprintf("ext/send_to_session: ext=%s target=%s kind=%s", h.name, req.Params.TargetKey, req.Params.Kind))
	h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)
}
