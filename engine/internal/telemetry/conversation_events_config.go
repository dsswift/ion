package telemetry

import (
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// conversation_events_config.go normalizes ConversationEventsConfig and
// adapts it into a types.TelemetryConfig-shaped value so the existing
// NewCollector constructor (unchanged) can build the second, fully
// independent Collector instance conversation.* telemetry emits through
// (issue #378, frozen contracts A/B). Kept in its own file — rather than
// telemetry.go — to keep that file under the 800-line file-size cap.

// normalizeConversationEventsConfig applies ConversationEventsConfig's own
// defaults, following normalizeTelemetryConfig's exact pattern (same file,
// same package) but with independently-chosen values. No field is ever read
// from or inherited from TelemetryConfig — the operator's "fully standalone"
// decision (manifest Round 3a) means an empty ConversationEventsConfig field
// defaults on its own terms, never by falling back to the general telemetry
// config.
//
//   - If Enabled and Targets is nil, defaults to ["file"] (same nil-vs-empty
//     distinction as normalizeTelemetryConfig: an explicit empty slice means
//     "no sinks" and is left unchanged).
//   - If "file" is among the (possibly-defaulted) targets and FilePath is
//     empty, defaults to ~/.ion/conversation-events.jsonl — a distinct file
//     from telemetry.jsonl, per the standalone-destination decision.
//   - If FlushIntervalMs is zero, defaults to 5000 ms, mirroring telemetry's
//     own default cadence.
//   - When Enabled is false, the config is returned unchanged — the
//     conversation-events collector is a no-op anyway.
func normalizeConversationEventsConfig(cfg types.ConversationEventsConfig) types.ConversationEventsConfig {
	if !cfg.Enabled {
		return cfg
	}
	if cfg.Targets == nil {
		cfg.Targets = []string{"file"}
	}
	if cfg.FilePath == "" {
		for _, t := range cfg.Targets {
			if t == "file" {
				cfg.FilePath = utils.ExpandHomePath("~/.ion/conversation-events.jsonl")
				break
			}
		}
	}
	if cfg.FlushIntervalMs == 0 {
		cfg.FlushIntervalMs = 5000
	}
	return cfg
}

// conversationEventsToTelemetryConfig field-by-field adapts a
// ConversationEventsConfig into the types.TelemetryConfig shape NewCollector
// requires. This is an explicit adapter rather than reusing TelemetryConfig
// as ConversationEventsConfig's storage type — the two types are
// intentionally distinct on EngineRuntimeConfig, and NewCollector's
// signature is unchanged. PrivacyLevel is never set: conversation.* is a
// security/audit stream by design, not a metrics stream, so it has no
// privacy-level tier to gate — ConversationEmitter's emit sites never call
// Collector.PrivacyLevel() at all.
func conversationEventsToTelemetryConfig(cfg types.ConversationEventsConfig) types.TelemetryConfig {
	return types.TelemetryConfig{
		Enabled:                     cfg.Enabled,
		Targets:                     cfg.Targets,
		HttpEndpoint:                cfg.HttpEndpoint,
		HttpHeaders:                 cfg.HttpHeaders,
		FilePath:                    cfg.FilePath,
		BatchSize:                   cfg.BatchSize,
		FlushIntervalMs:             cfg.FlushIntervalMs,
		Otel:                        cfg.Otel,
		MaxSizeMB:                   cfg.MaxSizeMB,
		MaxFiles:                    cfg.MaxFiles,
		HttpRetryQueueMaxMB:         cfg.HttpRetryQueueMaxMB,
		EventHubConnectionString:    cfg.EventHubConnectionString,
		EventHubName:                cfg.EventHubName,
		EventHubNamespace:           cfg.EventHubNamespace,
		EventHubTokenScope:          cfg.EventHubTokenScope,
		EventHubTokenAudience:       cfg.EventHubTokenAudience,
		EventHubRetryQueueMaxMB:     cfg.EventHubRetryQueueMaxMB,
		RetryQueueSoftWarnMB:        cfg.RetryQueueSoftWarnMB,
		RetryQueueStuckAfterMinutes: cfg.RetryQueueStuckAfterMinutes,
		EventHubMaxMessageBytes:     cfg.EventHubMaxMessageBytes,
		OversizeEventPolicy:         cfg.OversizeEventPolicy,
	}
}

// NewConversationEventsCollector builds the second, independent *Collector
// instance conversation.* telemetry emits through. It normalizes cfg with
// its own defaults (never TelemetryConfig's) and reuses NewCollector
// unchanged via the field-by-field adapter above, so the two Collector
// instances share no state: separate Enabled, separate buffer, separate
// flush loop, separate targets — each is its own NewCollector(...) result,
// with no aliasing.
func NewConversationEventsCollector(cfg types.ConversationEventsConfig) *Collector {
	normalized := normalizeConversationEventsConfig(cfg)
	return NewCollector(conversationEventsToTelemetryConfig(normalized))
}
