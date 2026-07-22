package main

import (
	"github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/utils"
)

// enforcementEventName maps a config-local enforcement action kind to its
// telemetry event name. The config package deliberately does not import
// telemetry (it is a pure function called at config load, before any collector
// exists), so the name mapping lives here at the drain site.
func enforcementEventName(kind config.EnforcementActionKind) string {
	switch kind {
	case config.EnforcementProviderPruned:
		return telemetry.EnforcementProviderPruned
	case config.EnforcementProviderPinned:
		return telemetry.EnforcementProviderPinned
	case config.EnforcementMcpPruned:
		return telemetry.EnforcementMcpPruned
	default:
		return "enforcement." + string(kind)
	}
}

// drainEnforcementActions drains the load-time enterprise enforcement recorder
// and emits one telemetry audit event per action (feature 0010 audit clause /
// D-018 rider #2). Nil-safe on the collector: when telemetry is disabled the
// recorder is still drained (so it does not grow across reloads) but nothing is
// emitted. Both branches are logged so the audit path is observable.
func drainEnforcementActions(collector *telemetry.Collector) {
	actions := config.DrainEnforcementActions()
	if len(actions) == 0 {
		utils.LogWithFields(utils.LevelDebug, "main", "no enterprise enforcement actions to drain", nil)
		return
	}
	if collector == nil {
		utils.LogWithFields(utils.LevelInfo, "main", "enterprise enforcement actions drained but telemetry disabled; no audit events emitted", map[string]any{"count": len(actions)})
		return
	}
	for _, a := range actions {
		payload := map[string]any{
			"subject": a.Subject,
			"source":  a.Source,
		}
		for k, v := range a.Fields {
			payload[k] = v
		}
		collector.Event(enforcementEventName(a.Kind), payload, nil)
	}
	utils.LogWithFields(utils.LevelInfo, "main", "emitted enterprise enforcement audit events", map[string]any{"count": len(actions)})
}
