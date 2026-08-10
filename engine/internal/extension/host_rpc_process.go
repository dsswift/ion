// host_rpc_process.go — process-registry, tool-suppression, and agent-spec ext/* handlers.
//
// Extracted verbatim from the handleExtRequest switch when that switch became
// the declared registry in host_rpc_registry.go. Behaviour is unchanged.

package extension

import (
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/types"
)

func (h *Host) rpcRegisterProcess(ctx *Context, id int64, raw []byte) {
	var req struct {
		Params struct {
			Name string `json:"name"`
			PID  int    `json:"pid"`
			Task string `json:"task"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "invalid params: " + err.Error()})
		return
	}
	if ctx != nil && ctx.RegisterProcess != nil {
		if err := ctx.RegisterProcess(req.Params.Name, req.Params.PID, req.Params.Task); err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
			return
		}
	}
	h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)
}

func (h *Host) rpcDeregisterProcess(ctx *Context, id int64, raw []byte) {
	var req struct {
		Params struct {
			Name string `json:"name"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "invalid params: " + err.Error()})
		return
	}
	if ctx != nil && ctx.DeregisterProcess != nil {
		ctx.DeregisterProcess(req.Params.Name)
	}
	h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)
}

func (h *Host) rpcListProcesses(ctx *Context, id int64, _ []byte) {
	var procs []ProcessInfo
	if ctx != nil && ctx.ListProcesses != nil {
		procs = ctx.ListProcesses()
	}
	if procs == nil {
		procs = []ProcessInfo{}
	}
	data, _ := json.Marshal(procs) //nolint:errcheck // marshal of a local RPC struct
	h.sendResponse(id, data, nil)
}

func (h *Host) rpcTerminateProcess(ctx *Context, id int64, raw []byte) {
	var req struct {
		Params struct {
			Name string `json:"name"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "invalid params: " + err.Error()})
		return
	}
	if ctx != nil && ctx.TerminateProcess != nil {
		if err := ctx.TerminateProcess(req.Params.Name); err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
			return
		}
	}
	h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)
}

func (h *Host) rpcCleanStaleProcesses(ctx *Context, id int64, _ []byte) {
	var count int
	if ctx != nil && ctx.CleanStaleProcesses != nil {
		count = ctx.CleanStaleProcesses()
	}
	data, _ := json.Marshal(map[string]int{"cleaned": count}) //nolint:errcheck // marshal of a local RPC struct
	h.sendResponse(id, data, nil)
}

func (h *Host) rpcSuppressTool(ctx *Context, id int64, raw []byte) {
	var req struct {
		Params struct {
			Name string `json:"name"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "invalid params: " + err.Error()})
		return
	}
	if ctx != nil && ctx.SuppressTool != nil {
		ctx.SuppressTool(req.Params.Name)
	}
	h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)
}

func (h *Host) rpcDiscoverAgents(ctx *Context, id int64, raw []byte) {
	var req struct {
		Params DiscoverAgentsOpts `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}
	if ctx != nil && ctx.DiscoverAgents != nil {
		result, err := ctx.DiscoverAgents(req.Params)
		if err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
			return
		}
		data, _ := json.Marshal(result) //nolint:errcheck // marshal of a local RPC struct
		h.sendResponse(id, json.RawMessage(data), nil)
	} else {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "agent discovery not available"})
	}
}

func (h *Host) rpcRegisterAgentSpec(ctx *Context, id int64, raw []byte) {
	var req struct {
		Params types.AgentSpec `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}
	if ctx == nil || ctx.RegisterAgentSpec == nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "agent spec registration not available"})
		return
	}
	if req.Params.Name == "" {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "spec.name is required"})
		return
	}
	ctx.RegisterAgentSpec(req.Params)
	h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)
}

func (h *Host) rpcDeregisterAgentSpec(ctx *Context, id int64, raw []byte) {
	var req struct {
		Params struct {
			Name string `json:"name"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}
	if ctx != nil && ctx.DeregisterAgentSpec != nil {
		ctx.DeregisterAgentSpec(req.Params.Name)
	}
	h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)
}
