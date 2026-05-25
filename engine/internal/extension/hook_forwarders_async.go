// Hook forwarder for the four async-trigger lifecycle hooks. Mirrors
// the registerBlockForwarder pattern but returns *AsyncRegistration-
// Veto so the FireWebhookRegistered / FireScheduleRegistered wrappers
// can decode the veto decision correctly.

package extension

import (
	"encoding/json"
	"fmt"

	"github.com/dsswift/ion/engine/internal/utils"
)

// registerAsyncRegistrationVetoForwarder registers a forwarder for
// webhook_registered or schedule_registered. The subprocess hook
// returns {block: bool, reason: string} (matching the AsyncRegistration-
// Veto shape on the wire); we decode it and return a typed pointer so
// the FireXxx wrappers' switch-on-type sees the right variant.
//
// On any decoding error or absent return value, we treat as "no veto"
// (nil result). Errors from the subprocess RPC log but never block —
// a broken hook should not be allowed to silently block every
// registration.
func (h *Host) registerAsyncRegistrationVetoForwarder(hook string) {
	h.sdk.On(hook, func(ctx *Context, payload interface{}) (interface{}, error) {
		raw, err := h.callHook("hook/"+hook, ctx, payload)
		if err != nil {
			logHookErr(hook, err)
			var stack string
			if he, ok := err.(*hookError); ok {
				stack = he.Stack
			}
			emitHookError(ctx, hook, err, stack)
			return nil, nil
		}
		emitHookEvents(ctx, raw)
		if len(raw) == 0 || string(raw) == "null" {
			return nil, nil
		}
		var result struct {
			Block  bool   `json:"block"`
			Reason string `json:"reason"`
		}
		if err := json.Unmarshal(raw, &result); err != nil {
			utils.Log("extension", fmt.Sprintf("hook/%s: bad result: %v", hook, err))
			return nil, nil
		}
		if !result.Block {
			return nil, nil
		}
		return &AsyncRegistrationVeto{Block: true, Reason: result.Reason}, nil
	})
}
