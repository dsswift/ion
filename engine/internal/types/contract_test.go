package types

import (
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "update golden contracts.json")

// contractManifest is the on-disk JSON shape written to testdata/contracts.json.
type contractManifest struct {
	NormalizedEvents map[string][]string `json:"normalizedEvents"`
	EngineEvent      []string            `json:"engineEvent"`
	SharedTypes      map[string][]string `json:"sharedTypes"`
}

// jsonFieldNames returns the sorted JSON field names for a struct type,
// skipping fields tagged with `json:"-"`.
func jsonFieldNames(t reflect.Type) []string {
	for t.Kind() == reflect.Ptr {
		t = t.Elem()
	}
	var names []string
	for i := range t.NumField() {
		f := t.Field(i)
		tag := f.Tag.Get("json")
		if tag == "" || tag == "-" {
			continue
		}
		name := strings.Split(tag, ",")[0]
		if name == "" {
			continue
		}
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// normalizedEventVariants returns a map from event type string to the struct
// that implements it, covering every variant registered in UnmarshalJSON.
func normalizedEventVariants() map[string]NormalizedEventData {
	return map[string]NormalizedEventData{
		EventSessionInit:           &SessionInitEvent{},
		EventTextChunk:             &TextChunkEvent{},
		EventToolCall:              &ToolCallEvent{},
		EventToolCallUpdate:        &ToolCallUpdateEvent{},
		EventToolCallComplete:      &ToolCallCompleteEvent{},
		EventToolResult:            &ToolResultEvent{},
		EventTaskUpdate:            &TaskUpdateEvent{},
		EventTaskComplete:          &TaskCompleteEvent{},
		EventError:                 &ErrorEvent{},
		EventSessionDead:           &SessionDeadEvent{},
		EventRateLimit:             &RateLimitNormalizedEvent{},
		EventUsage:                 &UsageEvent{},
		EventPermissionRequest:     &PermissionRequestEvent{},
		EventPlanModeChanged:       &PlanModeChangedEvent{},
		EventPlanFileWritten:       &PlanFileWrittenEvent{},
		EventPlanProposal:          &PlanProposalEvent{},
		EventPlanModeAutoExit:      &PlanModeAutoExitEvent{},
		EventStreamReset:           &StreamResetEvent{},
		EventCompacting:            &CompactingEvent{},
		EventToolStalled:           &ToolStalledEvent{},
		EventSteerInjected:         &SteerInjectedEvent{},
		EventPromptInjected:        &PromptInjectedEvent{},
		EventModelFallback:         &ModelFallbackEvent{},
		EventCapabilityUnsupported: &CapabilityUnsupportedEvent{},
		EventRunStalled:            &RunStalledEvent{},
		EventTaskSuspend:           &TaskSuspendEvent{},
		EventPlanContent:           &PlanContentEvent{},
		EventThinkingBlockStart:    &ThinkingBlockStartEvent{},
		EventThinkingDelta:         &ThinkingDeltaEvent{},
		EventThinkingBlockEnd:      &ThinkingBlockEndEvent{},
		// Extension-surface events (WI-001: single-path collapse)
		EventMessageEnd:             &MessageEndEvent{},
		EventUserTurnPersisted:      &UserTurnPersistedEvent{},
		EventAgentState:             &AgentStateEvent{},
		EventHarnessMessage:         &HarnessMessageEvent{},
		EventWorkingMessage:         &WorkingMessageEvent{},
		EventNotify:                 &NotifyEvent{},
		EventDialog:                 &DialogEvent{},
		EventExtensionDied:          &ExtensionDiedEvent{},
		EventExtensionRespawned:     &ExtensionRespawnedEvent{},
		EventExtensionDeadPermanent: &ExtensionDeadPermanentEvent{},
		EventEventsDropped:          &EventsDroppedEvent{},
		EventContextBreakdown:       &ContextBreakdownEvent{},
		EventImageContent:           &ImageContentEvent{},
	}
}

func buildManifest() contractManifest {
	m := contractManifest{
		NormalizedEvents: make(map[string][]string),
		SharedTypes:      make(map[string][]string),
	}

	// NormalizedEvent variants
	for eventType, exemplar := range normalizedEventVariants() {
		m.NormalizedEvents[eventType] = jsonFieldNames(reflect.TypeOf(exemplar))
	}

	// EngineEvent (flat struct)
	m.EngineEvent = jsonFieldNames(reflect.TypeOf(EngineEvent{}))

	// Shared types used across language boundaries
	shared := map[string]reflect.Type{
		"StatusFields":        reflect.TypeOf(StatusFields{}),
		"SessionStatus":       reflect.TypeOf(SessionStatus{}),
		"EngineConfig":        reflect.TypeOf(EngineConfig{}),
		"MessageEndUsage":     reflect.TypeOf(MessageEndUsage{}),
		"PermissionOpt":       reflect.TypeOf(PermissionOpt{}),
		"McpServerInfo":       reflect.TypeOf(McpServerInfo{}),
		"UsageData":           reflect.TypeOf(UsageData{}),
		"AgentStateUpdate":    reflect.TypeOf(AgentStateUpdate{}),
		"ModelEntry":          reflect.TypeOf(ModelEntry{}),
		"ProviderEntry":       reflect.TypeOf(ProviderEntry{}),
		"ProviderCliStatus":   reflect.TypeOf(ProviderCliStatus{}),
		"ProviderLoginUpdate": reflect.TypeOf(ProviderLoginUpdate{}),
		// Slash-command registry. Emitted inside engine_command_registry events
		// so consumers can populate a routing-hint cache without parsing
		// engine internals. Snapshot semantics — see types.go comment.
		"EngineCommandListing": reflect.TypeOf(EngineCommandListing{}),
		// LlmContentBlock is the wire shape for every block carried inside
		// an LlmMessage. Tracked so cross-language mirrors stay in sync as
		// new block variants land (most recently the "compact_boundary"
		// variant — see internal/conversation/compact_boundary.go).
		"LlmContentBlock": reflect.TypeOf(LlmContentBlock{}),
		// ContextBreakdownPayload is the wire payload for
		// engine_context_breakdown; ContextBreakdownCategory is a nested row.
		// Tracked so cross-language mirrors carry the per-category context readout.
		"ContextBreakdownPayload":  reflect.TypeOf(ContextBreakdownPayload{}),
		"ContextBreakdownCategory": reflect.TypeOf(ContextBreakdownCategory{}),
		// ModelBreakdown is a per-model cost-breakdown row carried inside
		// ContextBreakdownPayload.ModelBreakdown. Tracked so cross-language
		// mirrors stay in sync.
		"ModelBreakdown": reflect.TypeOf(ModelBreakdown{}),
		// SessionMessage is the history-load row (load_session_history /
		// get_conversation responses). Tracked so its canonical row id and
		// error-flag fields stay mirrored in the desktop mapper and iOS model.
		"SessionMessage":           reflect.TypeOf(SessionMessage{}),
		"SessionMessageAttachment": reflect.TypeOf(SessionMessageAttachment{}),
		// ResourceLimits crosses the wire inside the get_enterprise_policy
		// response (D-007). Tracked so client mirrors enforce the same
		// session/agent caps the engine enforces.
		"ResourceLimits": reflect.TypeOf(ResourceLimits{}),
		// ExtensionAllowlistEntry is an element of EnterpriseConfig.ExtensionAllowlist
		// (feature 0011 / D-020, issue #308), carried inside the
		// get_enterprise_policy blob. Tracked so Go↔TS drift is caught by CI.
		"ExtensionAllowlistEntry": reflect.TypeOf(ExtensionAllowlistEntry{}),
	}
	for name, typ := range shared {
		m.SharedTypes[name] = jsonFieldNames(typ)
	}

	return m
}

func TestContractManifest(t *testing.T) {
	golden := filepath.Join("testdata", "contracts.json")
	manifest := buildManifest()

	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	// Ensure trailing newline for git friendliness
	data = append(data, '\n')

	if *update {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatalf("mkdir testdata: %v", err)
		}
		if err := os.WriteFile(golden, data, 0o644); err != nil {
			t.Fatalf("write golden: %v", err)
		}
		t.Logf("updated %s", golden)
		return
	}

	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatalf("read golden file (run with -update to create): %v", err)
	}

	if string(data) != string(want) {
		t.Errorf("contract manifest has drifted from %s\n"+
			"Run: cd engine && go test ./internal/types/ -run TestContractManifest -update\n"+
			"Then review the diff and update TS/Swift contract tests.",
			golden)
		t.Logf("got:\n%s", data)
	}
}
