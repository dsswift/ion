package main

import (
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// installOtelExportAuth registers the credential every OTLP export block
// names in its tokenProvider (telemetry.otel and conversationEvents.otel), so
// their trace and metrics exports mint bearer tokens from it. It shares r with
// log egress, so an entry named by both is built once. Must run after the
// identity provider is configured and before the first export.
func installOtelExportAuth(cfg *types.EngineRuntimeConfig, r *tokenSourceResolver) {
	type otelBlock struct {
		field string
		otel  *types.OtelConfig
	}
	var blocks []otelBlock
	if cfg.Telemetry != nil {
		blocks = append(blocks, otelBlock{"telemetry.otel.tokenProvider", cfg.Telemetry.Otel})
	}
	if cfg.ConversationEvents != nil {
		blocks = append(blocks, otelBlock{"conversationEvents.otel.tokenProvider", cfg.ConversationEvents.Otel})
	}
	for _, b := range blocks {
		if b.otel == nil || b.otel.TokenProvider == "" {
			utils.LogWithFields(utils.LevelDebug, "main", "otlp export token provider unset; exports mint from the identity provider", map[string]any{"field": b.field})
			continue
		}
		src := r.resolve(b.field, b.otel.TokenProvider)
		telemetry.SetOtelTokenSource(b.otel.TokenProvider, telemetry.OtelTokenSource{
			Name: src.name, Kind: src.kind, Provider: src.provider,
		})
		utils.LogWithFields(utils.LevelInfo, "main", "otlp export token provider installed", map[string]any{
			"field": b.field, "token_provider": b.otel.TokenProvider, "provider": src.name, "kind": src.kind,
		})
	}
}
