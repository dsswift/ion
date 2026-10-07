package session

import (
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/utils"
)

// withPayloadTraceparent carries an extension prompt's trace context onto its
// run's overrides. Set only for a prompt sent from a schedule or webhook
// handler (extension.FireTraceparent), whose run then joins the fire's trace
// under the fire's root span; every other extension prompt leaves overrides
// as built and starts a trace of its own (newRunTrace).
func withPayloadTraceparent(overrides *PromptOverrides, payload extension.SendPromptPayload, key, origin string) *PromptOverrides {
	if payload.Traceparent == "" {
		return overrides
	}
	if overrides == nil {
		overrides = &PromptOverrides{}
	}
	overrides.Traceparent = payload.Traceparent
	utils.LogWithFields(utils.LevelInfo, "session", "extension prompt joins the fire trace", map[string]any{"key": key, "origin": origin, "traceparent": payload.Traceparent, "injection_kind": payload.Kind})
	return overrides
}
