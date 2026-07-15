package session

import (
	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/utils"
)

// wirePermissionDecisionTelemetry registers an audit callback on the session's
// permission engine that emits a permission.decision telemetry event for every
// permission Check. This is the trust/autonomy observability seam (family 4a):
// each decision carries the deciding layer (which rail decided), the decision
// latency, the tool, the verdict, the reason/tier/rule, and a bounded preview
// of the input.
//
// Emission is nil-safe end to end: when telemetry is disabled the collector's
// Event method is a no-op, and the callback itself guards on a nil collector so
// no work is done. Registered once at session start, after both the permission
// engine and telemetry collector are constructed.
func (m *Manager) wirePermissionDecisionTelemetry(s *engineSession) {
	if s == nil || s.permEngine == nil {
		return
	}
	// Capture the session so the callback reads the collector lazily. The
	// collector is created just before this call and never reassigned, so a
	// direct capture is safe.
	sess := s
	s.permEngine.OnAudit(func(entry permissions.AuditEntry) {
		telem := sess.telemetry
		if telem == nil {
			return
		}
		payload := map[string]any{
			// R11: event name is carried by Event.Name; payload.kind removed.
			"tool":           entry.Tool,
			"decision":       entry.Decision,
			"deciding_layer": entry.Layer,
			// Sub-millisecond precision: the fast permission rails resolve in
			// microseconds, and entry.LatencyMs floors those to 0. Emit the
			// float millisecond from the full-resolution duration so the
			// decision-latency panel is non-blank for fast decisions. This is a
			// payload-map value (no typed decoder, not in contracts.json), so
			// the int→float change is a precision fix, not a contract change.
			"decision_latency_ms": float64(entry.Latency.Microseconds()) / 1000.0,
			"intent_reason":       entry.Reason,
			"tier":                entry.Tier,
			"rule":                entry.Rule,
			"input_preview":       previewString(entry.Input, 200),
			"audit_session_id":    entry.SessionID,
		}
		ctx := map[string]any{
			"session_id":      sess.key,
			"conversation_id": sess.conversationID,
		}
		telem.Event(telemetry.PermissionDecision, payload, ctx)
		utils.LogWithFields(utils.LevelDebug, "session", "permission.decision telemetry emitted tool= decision= layer=", map[string]any{"tool": entry.Tool, "decision": entry.Decision, "layer": entry.Layer})
	})
}

// previewString trims s to at most maxLen bytes for a bounded telemetry
// preview. Byte-based truncation is acceptable for a diagnostic preview.
func previewString(s string, maxLen int) string {
	if len(s) > maxLen {
		return s[:maxLen]
	}
	return s
}
