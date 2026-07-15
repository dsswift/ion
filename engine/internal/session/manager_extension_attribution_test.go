package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestExtensionAttribution_RunCompleteCarriesExtension verifies that a
// run.complete event emitted for an extension-hosted session carries
// "extension" and "extension_version" in its telemetry context when
// extensionName and extensionVersion are set on the session.
//
// EMISSION-ONLY coverage: this test sets s.extensionName / s.extensionVersion
// directly on the session struct. It does NOT cover how those fields get
// populated in a real extension-hosted session — that is pinned by
// extension_attribution_population_test.go (which caught the production bug
// where population never happened and ctx.extension was NULL on every event).
//
// RED on unfixed code: correlationCtx (pre-fix) never included "extension" or
// "extension_version", so e.Context["extension"] would be nil and the
// assertion would fail.
func TestExtensionAttribution_RunCompleteCarriesExtension(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("ext-attr-run", defaultConfig())

	collector := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	const wantName = "my-extension"
	const wantVersion = "2.3.4"
	mgr.mu.Lock()
	s := mgr.sessions["ext-attr-run"]
	s.requestID = "run-ext-attr"
	s.telemetry = collector
	s.lastModel = "claude-sonnet-4-6"
	s.conversationID = "conv-ext-attr"
	s.extensionName = wantName
	s.extensionVersion = wantVersion
	mgr.mu.Unlock()

	mgr.handleNormalizedEvent("run-ext-attr", types.NormalizedEvent{
		Data: &types.TaskCompleteEvent{
			Result:     "done",
			CostUsd:    0.05,
			DurationMs: 1000,
			NumTurns:   1,
			Usage:      types.UsageData{InputTokens: intPtr(100), OutputTokens: intPtr(50)},
		},
	})

	events := drainTelemetry(t, collector)
	runComplete := filterByName(events, telemetry.RunComplete)
	if len(runComplete) != 1 {
		t.Fatalf("expected 1 run.complete event, got %d", len(runComplete))
	}
	e := runComplete[0]
	assertCtxStr(t, e.Context, "extension", wantName)
	assertCtxStr(t, e.Context, "extension_version", wantVersion)
}

// TestExtensionAttribution_RunCompleteOmitsExtensionWhenNone verifies that a
// run.complete event for a non-extension-hosted session does NOT carry
// "extension" or "extension_version" keys. Old lines must stay clean so
// Grafana groups them as "unattributed" rather than assigning a spurious label.
//
// RED on unfixed code that always stamps the fields: the assertions would fail
// if the implementation unconditionally included the keys.
func TestExtensionAttribution_RunCompleteOmitsExtensionWhenNone(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("no-ext-run", defaultConfig())

	collector := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	mgr.mu.Lock()
	s := mgr.sessions["no-ext-run"]
	s.requestID = "run-no-ext"
	s.telemetry = collector
	s.lastModel = "claude-sonnet-4-6"
	// extensionName and extensionVersion intentionally empty (non-extension session)
	mgr.mu.Unlock()

	mgr.handleNormalizedEvent("run-no-ext", types.NormalizedEvent{
		Data: &types.TaskCompleteEvent{
			Result:     "done",
			CostUsd:    0.01,
			DurationMs: 500,
			NumTurns:   1,
			Usage:      types.UsageData{InputTokens: intPtr(50), OutputTokens: intPtr(20)},
		},
	})

	events := drainTelemetry(t, collector)
	runComplete := filterByName(events, telemetry.RunComplete)
	if len(runComplete) != 1 {
		t.Fatalf("expected 1 run.complete event, got %d", len(runComplete))
	}
	e := runComplete[0]
	if _, ok := e.Context["extension"]; ok {
		t.Errorf("run.complete context must not carry 'extension' for non-extension sessions; got %v", e.Context["extension"])
	}
	if _, ok := e.Context["extension_version"]; ok {
		t.Errorf("run.complete context must not carry 'extension_version' for non-extension sessions; got %v", e.Context["extension_version"])
	}
}

// TestExtensionAttribution_CacheSavingsCarriesExtension verifies that the
// cache.savings event also carries extension attribution when extension-hosted.
//
// RED on unfixed code: emitCacheSavings used the old 5-arg signature
// (which emitted via correlationCtx, never including extension fields),
// so e.Context["extension"] would be absent.
func TestExtensionAttribution_CacheSavingsCarriesExtension(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("ext-cache-attr", defaultConfig())

	collector := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	const wantName = "cache-ext"
	const wantVersion = "1.0.0"
	mgr.mu.Lock()
	s := mgr.sessions["ext-cache-attr"]
	s.requestID = "run-ext-cache"
	s.telemetry = collector
	s.lastModel = "claude-sonnet-4-6"
	s.conversationID = "conv-ext-cache"
	s.extensionName = wantName
	s.extensionVersion = wantVersion
	mgr.mu.Unlock()

	mgr.handleNormalizedEvent("run-ext-cache", types.NormalizedEvent{
		Data: &types.TaskCompleteEvent{
			Result:     "done",
			CostUsd:    0.05,
			DurationMs: 1000,
			NumTurns:   1,
			Usage: types.UsageData{
				InputTokens:          intPtr(500),
				OutputTokens:         intPtr(100),
				CacheReadInputTokens: intPtr(800),
			},
		},
	})

	events := drainTelemetry(t, collector)
	cacheSavings := filterByName(events, telemetry.CacheSavings)
	if len(cacheSavings) != 1 {
		t.Fatalf("expected 1 cache.savings event, got %d (all events: %+v)", len(cacheSavings), events)
	}
	e := cacheSavings[0]
	assertCtxStr(t, e.Context, "extension", wantName)
	assertCtxStr(t, e.Context, "extension_version", wantVersion)
}
