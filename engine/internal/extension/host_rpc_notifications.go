// host_rpc_notifications.go — handlers for extension-initiated JSON-RPC
// notifications (a method with no id, so no response is written).
//
// Extracted verbatim from the handleExtNotification switch when that switch
// became the declared registry in host_rpc_registry.go. Behaviour is unchanged.

package extension

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

func (h *Host) rpcEmit(ctx *Context, raw []byte) {
	var notif struct {
		Params types.EngineEvent `json:"params"`
	}
	if err := json.Unmarshal(raw, &notif); err != nil {
		utils.LogWithFields(utils.LevelInfo, "extension", "ext/emit parse error", map[string]any{"error": err})
		return
	}
	// Resolve emit function: prefer active context, fall back to persistent emit
	var emitFn func(types.EngineEvent)
	if ctx != nil && ctx.Emit != nil {
		emitFn = ctx.Emit
	} else {
		h.notifMu.RLock()
		emitFn = h.persistentEmit
		h.notifMu.RUnlock()
	}
	if emitFn == nil {
		return
	}
	// Validate engine_agent_state payloads before forwarding
	if notif.Params.Type == "engine_agent_state" {
		var warnings []string
		for i, agent := range notif.Params.Agents {
			if agent.Name == "" {
				warnings = append(warnings, fmt.Sprintf("agent[%d]: missing name", i))
			}
			if md := agent.Metadata; md != nil {
				if dn, ok := md["displayName"]; !ok || dn == nil || dn == "" {
					warnings = append(warnings, fmt.Sprintf("agent[%d] (%s): missing displayName in metadata", i, agent.Name))
				}
			}
		}
		if len(warnings) > 0 {
			msg := fmt.Sprintf("extension emitted malformed engine_agent_state: %s", strings.Join(warnings, "; "))
			utils.Warn("extension", msg)
			emitFn(types.EngineEvent{
				Type:         "engine_error",
				EventMessage: msg,
				ErrorCode:    "malformed_agent_state",
			})
		}
	}
	emitFn(notif.Params)
}

func (h *Host) rpcSendMessage(_ *Context, raw []byte) {
	var notif struct {
		Params struct {
			Text string `json:"text"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &notif); err != nil {
		utils.LogWithFields(utils.LevelInfo, "extension", "ext/send_message parse error", map[string]any{"error": err})
		return
	}
	h.notifMu.RLock()
	fn := h.onSendMessage
	h.notifMu.RUnlock()
	if fn != nil && notif.Params.Text != "" {
		// The ext/send_message notification shape carries text only (no
		// model / bash-allowlist fields), so the payload is text-only here.
		// Extensions that need per-prompt model or bash grants use the
		// ext/send_prompt request, which carries the full payload below.
		fn(SendPromptPayload{Text: notif.Params.Text})
	}
}

func (h *Host) rpcLogNotification(_ *Context, raw []byte) {
	// Native SDK logging channel. Routes structured log calls (and
	// redirected console.* output) through the JSON-RPC frame so
	// nothing ever lands on the subprocess's raw stdout. Structured
	// fields are preserved as the canonical `fields` object — never
	// concatenated into the message string.
	var notif struct {
		Params struct {
			Level   string         `json:"level"`
			Message string         `json:"message"`
			Fields  map[string]any `json:"fields,omitempty"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &notif); err != nil {
		utils.LogWithFields(utils.LevelInfo, "extension", "log notif parse error", map[string]any{"error": err})
		return
	}

	// Per the log schema, extension-component logs carry the extension
	// name as their tag.
	tag := h.name_()
	if tag == "" {
		tag = "ext"
	}

	// Resolve session/conversation IDs from the host's bound session
	// context so extension logs correlate with the engine session.
	sessionID, conversationID := h.getBoundIDs()

	fields := notif.Params.Fields
	if fields == nil {
		fields = map[string]any{}
	}

	lvl := utils.ParseLevel(notif.Params.Level)
	// LogExtension stamps component="extension" and the bound IDs, and
	// preserves fields verbatim.
	utils.LogExtension(lvl, tag, notif.Params.Message, fields, sessionID, conversationID)
}

func (h *Host) rpcLlmCallCancel(_ *Context, raw []byte) {
	// Per-call cancellation for ctx.llmCall({ signal }). The TS runtime
	// fires this fire-and-forget notification (no response) when the
	// caller's AbortSignal aborts, keyed by the in-flight ext/llm_call
	// RPC id. We look up the registered CancelFunc and invoke it; an
	// unknown id is a benign race with completion (logged, no-op).
	var notif struct {
		Params struct {
			RequestID int64 `json:"requestId"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &notif); err != nil {
		utils.LogWithFields(utils.LevelInfo, "extension", "ext/llm_call_cancel parse error", map[string]any{"error": err})
		return
	}
	cancelled := h.cancelInflightLLMCall(notif.Params.RequestID)
	utils.LogWithFields(utils.LevelDebug, "extension", "ext/llm_call_cancel", map[string]any{"run_id": notif.Params.RequestID, "cancelled": cancelled})
}
