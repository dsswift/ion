package telemetry

import (
	"os"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestNormalizeConversationEventsConfig_Defaults pins the standalone
// defaulting contract (child 02 §2): nil Targets -> ["file"], empty FilePath
// with a file target -> the conversation-events path (not telemetry.jsonl),
// and FlushIntervalMs 0 -> 5000.
func TestNormalizeConversationEventsConfig_Defaults(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	resolvedHome, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("UserHomeDir: %v", err)
	}
	if resolvedHome != home {
		t.Skipf("HOME override not honoured on this platform (got %q, want %q)", resolvedHome, home)
	}

	cfg := normalizeConversationEventsConfig(types.ConversationEventsConfig{Enabled: true})

	if len(cfg.Targets) != 1 || cfg.Targets[0] != "file" {
		t.Errorf("Targets = %v, want [\"file\"]", cfg.Targets)
	}
	if strings.HasPrefix(cfg.FilePath, "~") {
		t.Errorf("FilePath = %q, want tilde-expanded", cfg.FilePath)
	}
	if !strings.HasSuffix(cfg.FilePath, "conversation-events.jsonl") {
		t.Errorf("FilePath = %q, want suffix conversation-events.jsonl (distinct from telemetry.jsonl)", cfg.FilePath)
	}
	if cfg.FlushIntervalMs != 5000 {
		t.Errorf("FlushIntervalMs = %d, want 5000", cfg.FlushIntervalMs)
	}
}

// TestNormalizeConversationEventsConfig_NeverReadsTelemetryConfig is the
// direct regression test for the "fully standalone, no inheritance" decision
// (manifest Round 3a): normalizeConversationEventsConfig takes only a
// ConversationEventsConfig value — it has no way to read TelemetryConfig at
// all, so this test constructs the config directly and confirms the
// defaulting result depends solely on its own fields.
func TestNormalizeConversationEventsConfig_NeverReadsTelemetryConfig(t *testing.T) {
	// If normalizeConversationEventsConfig ever gained a TelemetryConfig
	// parameter or global lookup, this call site would need to change to
	// compile — which is itself the regression signal. As written today, the
	// function signature proves the isolation: it accepts only
	// ConversationEventsConfig.
	cfg := normalizeConversationEventsConfig(types.ConversationEventsConfig{
		Enabled: true,
		Targets: []string{},
	})
	if cfg.Targets == nil || len(cfg.Targets) != 0 {
		t.Errorf("explicit empty Targets must remain empty (no telemetry.* fallback), got %v", cfg.Targets)
	}
}

// TestConversationEventsCollector_IndependentOfTelemetryEnabled is the direct
// regression test for the "fully standalone" decision: a conversation-events
// collector built with telemetry.enabled=false (or absent) must still be a
// functioning, non-no-op collector. Fails if any code path required
// telemetry.enabled first.
func TestConversationEventsCollector_IndependentOfTelemetryEnabled(t *testing.T) {
	// Deliberately no TelemetryConfig constructed anywhere in this test —
	// only ConversationEventsConfig, proving the collector needs nothing else.
	c := NewConversationEventsCollector(types.ConversationEventsConfig{
		Enabled: true,
		Targets: []string{}, // no file I/O; buffer-only for a unit test
	})

	c.Event("conversation.user_message", map[string]any{"conversation_id": "c1"}, nil)
	events := c.BufferedEvents()
	if len(events) != 1 {
		t.Fatalf("expected 1 buffered event from an enabled standalone collector, got %d", len(events))
	}
}

// TestConversationEventsCollector_DisabledIsNoOp confirms a disabled
// ConversationEventsConfig produces a genuinely no-op collector (mirrors
// Collector's existing disabled behavior for TelemetryConfig).
func TestConversationEventsCollector_DisabledIsNoOp(t *testing.T) {
	c := NewConversationEventsCollector(types.ConversationEventsConfig{Enabled: false})
	c.Event("conversation.user_message", map[string]any{"conversation_id": "c1"}, nil)
	if events := c.BufferedEvents(); len(events) != 0 {
		t.Errorf("expected 0 buffered events for disabled collector, got %d", len(events))
	}
}

// TestConversationEventsToTelemetryConfig_PassesThroughEventHubFields pins
// the adapter's obligation to forward the "eventhub" target fields
// unchanged (issue #378) — no new defaulting logic, since EventHub requires
// an explicit connection string with no sensible zero-value default.
func TestConversationEventsToTelemetryConfig_PassesThroughEventHubFields(t *testing.T) {
	cfg := conversationEventsToTelemetryConfig(types.ConversationEventsConfig{
		Enabled:                  true,
		Targets:                  []string{"eventhub"},
		EventHubConnectionString: "Endpoint=sb://example.servicebus.windows.net/;SharedAccessKeyName=k;SharedAccessKey=s",
		EventHubName:             "conversation-audit",
		EventHubRetryQueueMaxMB:  42,
	})

	if cfg.EventHubConnectionString != "Endpoint=sb://example.servicebus.windows.net/;SharedAccessKeyName=k;SharedAccessKey=s" {
		t.Errorf("EventHubConnectionString = %q, unchanged expected", cfg.EventHubConnectionString)
	}
	if cfg.EventHubName != "conversation-audit" {
		t.Errorf("EventHubName = %q, want conversation-audit", cfg.EventHubName)
	}
	if cfg.EventHubRetryQueueMaxMB != 42 {
		t.Errorf("EventHubRetryQueueMaxMB = %d, want 42", cfg.EventHubRetryQueueMaxMB)
	}
}

// TestTwoCollectors_NoCrossTalk confirms a general-telemetry Collector and a
// conversation-events Collector built with different HttpEndpoint values
// each retain their own configured endpoint — no aliasing, no shared state.
func TestTwoCollectors_NoCrossTalk(t *testing.T) {
	generalTelem := NewCollector(types.TelemetryConfig{
		Enabled:      true,
		Targets:      []string{"httpEndpoint"},
		HttpEndpoint: "https://telemetry.example/A",
	})
	convTelem := NewConversationEventsCollector(types.ConversationEventsConfig{
		Enabled:      true,
		Targets:      []string{"httpEndpoint"},
		HttpEndpoint: "https://telemetry.example/B",
	})

	if generalTelem.config.HttpEndpoint != "https://telemetry.example/A" {
		t.Errorf("general telemetry HttpEndpoint = %q, want unchanged A", generalTelem.config.HttpEndpoint)
	}
	if convTelem.config.HttpEndpoint != "https://telemetry.example/B" {
		t.Errorf("conversation events HttpEndpoint = %q, want unchanged B", convTelem.config.HttpEndpoint)
	}
	if generalTelem.config.HttpEndpoint == convTelem.config.HttpEndpoint {
		t.Fatal("collectors share an endpoint value; expected independent configuration")
	}

	// Emit on each; confirm no cross-talk in the buffers either.
	generalTelem.Event("llm.call", map[string]any{"model": "m"}, nil)
	convTelem.Event("conversation.user_message", map[string]any{"conversation_id": "c1"}, nil)

	genEvents := generalTelem.BufferedEvents()
	convEvents := convTelem.BufferedEvents()
	if len(genEvents) != 1 || genEvents[0].Name != "llm.call" {
		t.Errorf("general telemetry buffer = %v, want exactly [llm.call]", genEvents)
	}
	if len(convEvents) != 1 || convEvents[0].Name != "conversation.user_message" {
		t.Errorf("conversation events buffer = %v, want exactly [conversation.user_message]", convEvents)
	}
}
