// Async-trigger RPC handlers. Implements the four ext/{register,
// deregister}_{webhook,schedule} cases the SDK runtime uses for
// dynamic post-init registration. The init-handshake bulk shape is
// handled inside host_transpile.go's parseInitResult — these cases
// only handle runtime additions/removals.
//
// Each case follows the same pattern:
//   1. Parse the typed declaration out of params (validate at the SDK
//      type's own Validate method, not duplicated here).
//   2. Call the host's Register/Deregister helper, which fires the
//      lifecycle hook (veto-capable for register) and updates the
//      registry.
//   3. Respond with {ok: true, id} on success, or a -32000 error
//      carrying the veto/validation reason on failure.
//
// Logging covers every branch (success, validation error, veto, RPC
// parse error) per the engine logging policy.

package extension

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/dsswift/ion/engine/internal/asyncreg"
	"github.com/dsswift/ion/engine/internal/utils"
)

// handleAsyncRPC dispatches the four async-trigger RPC methods. Returns
// true when the method was handled (caller short-circuits its own
// dispatch); false leaves the caller to try other cases.
func (h *Host) handleAsyncRPC(method string, id int64, raw []byte) bool {
	switch method {
	case "ext/register_webhook":
		h.rpcRegisterWebhook(id, raw)
		return true
	case "ext/deregister_webhook":
		h.rpcDeregisterWebhook(id, raw)
		return true
	case "ext/register_schedule":
		h.rpcRegisterSchedule(id, raw)
		return true
	case "ext/deregister_schedule":
		h.rpcDeregisterSchedule(id, raw)
		return true
	}
	return false
}

func (h *Host) rpcRegisterWebhook(id int64, raw []byte) {
	var req struct {
		Params WebhookRoute `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		utils.Error("extension", fmt.Sprintf("ext/register_webhook: parse error: %v", err))
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}
	// Run the registration in a goroutine so the readLoop is free to
	// receive the subsequent hook/webhook_registered request the
	// engine sends as part of the veto pipeline. Without this the
	// veto fire blocks forever waiting for a hook response that can
	// only arrive over a readLoop that's already blocked.
	go func() {
		err := h.RegisterWebhookDecl(req.Params, asyncreg.OriginRuntime)
		if err != nil {
			code := asyncRPCErrorCode(err)
			utils.Log("extension", fmt.Sprintf("ext/register_webhook: ext=%s path=%q rejected: %v", h.name, req.Params.Path, err))
			h.sendResponse(id, nil, &jsonrpcError{Code: code, Message: err.Error()})
			return
		}
		utils.Log("extension", fmt.Sprintf("ext/register_webhook: ext=%s path=%q registered (origin=runtime)", h.name, req.Params.Path))
		resp, _ := json.Marshal(struct {
			OK bool   `json:"ok"`
			ID string `json:"id"`
		}{OK: true, ID: req.Params.Path})
		h.sendResponse(id, resp, nil)
	}()
}

func (h *Host) rpcDeregisterWebhook(id int64, raw []byte) {
	var req struct {
		Params struct {
			Path string `json:"path"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		utils.Error("extension", fmt.Sprintf("ext/deregister_webhook: parse error: %v", err))
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}
	if req.Params.Path == "" {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "path is required"})
		return
	}
	go func() {
		removed := h.DeregisterWebhookDecl(req.Params.Path)
		utils.Log("extension", fmt.Sprintf("ext/deregister_webhook: ext=%s path=%q removed=%t", h.name, req.Params.Path, removed))
		resp, _ := json.Marshal(struct {
			OK      bool `json:"ok"`
			Removed bool `json:"removed"`
		}{OK: true, Removed: removed})
		h.sendResponse(id, resp, nil)
	}()
}

func (h *Host) rpcRegisterSchedule(id int64, raw []byte) {
	var req struct {
		Params ScheduleJob `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		utils.Error("extension", fmt.Sprintf("ext/register_schedule: parse error: %v", err))
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}
	go func() {
		err := h.RegisterScheduleDecl(req.Params, asyncreg.OriginRuntime)
		if err != nil {
			code := asyncRPCErrorCode(err)
			utils.Log("extension", fmt.Sprintf("ext/register_schedule: ext=%s id=%q rejected: %v", h.name, req.Params.JobID, err))
			h.sendResponse(id, nil, &jsonrpcError{Code: code, Message: err.Error()})
			return
		}
		utils.Log("extension", fmt.Sprintf("ext/register_schedule: ext=%s id=%q registered (origin=runtime)", h.name, req.Params.JobID))
		resp, _ := json.Marshal(struct {
			OK bool   `json:"ok"`
			ID string `json:"id"`
		}{OK: true, ID: req.Params.JobID})
		h.sendResponse(id, resp, nil)
	}()
}

func (h *Host) rpcDeregisterSchedule(id int64, raw []byte) {
	var req struct {
		Params struct {
			ID string `json:"id"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		utils.Error("extension", fmt.Sprintf("ext/deregister_schedule: parse error: %v", err))
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}
	if req.Params.ID == "" {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "id is required"})
		return
	}
	go func() {
		removed := h.DeregisterScheduleDecl(req.Params.ID)
		utils.Log("extension", fmt.Sprintf("ext/deregister_schedule: ext=%s id=%q removed=%t", h.name, req.Params.ID, removed))
		resp, _ := json.Marshal(struct {
			OK      bool `json:"ok"`
			Removed bool `json:"removed"`
		}{OK: true, Removed: removed})
		h.sendResponse(id, resp, nil)
	}()
}

// asyncRPCErrorCode maps an internal registry error to a JSON-RPC
// error code. -32602 means "invalid params" (validation failures);
// -32000 is the generic "server error" used for veto and operational
// rejections (cap exceeded, duplicate).
func asyncRPCErrorCode(err error) int {
	switch {
	case errors.Is(err, asyncreg.ErrCapExceeded), errors.Is(err, asyncreg.ErrDuplicate), errors.Is(err, asyncreg.ErrEmptyID):
		return -32000
	default:
		// Validation errors from WebhookAuth.Validate / ScheduleJob.Validate
		// land here. Distinguishing them from vetoes would require a
		// sentinel — for now both map to -32000 since they share the
		// "registration declined" semantic from the caller's perspective.
		return -32000
	}
}
