package extcontext

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestDispatchAgentSpanEmitted verifies that a foreground dispatch emits a
// dispatch.agent telemetry span (via SpanHandle.End) carrying the span id,
// agent, model, and dispatch depth. Goes red if the span start/end is removed
// from BuildDispatchAgentFunc.
func TestDispatchAgentSpanEmitted(t *testing.T) {
	col := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	acc := &depthTestAccessor{telem: col}

	dispatchFn := BuildDispatchAgentFunc(acc, nil, 0, "")
	// Foreground dispatch with no resolvable model: the child backend fails
	// fast (no provider), runChild completes, and the span ends. We assert the
	// span event landed regardless of the child's failure.
	_, _ = dispatchFn(extension.DispatchAgentOpts{WaitForCompletion: true,
		Name:  "span-agent",
		Task:  "do span work",
		Model: "no-such-model-for-span",
	})

	var found *telemetry.Event
	events := col.BufferedEvents()
	for i := range events {
		if events[i].Name == telemetry.DispatchAgent {
			found = &events[i]
			break
		}
	}
	if found == nil {
		t.Fatal("expected a dispatch.agent span event")
	}
	if found.Payload["agent"] != "span-agent" {
		t.Errorf("agent = %v, want span-agent", found.Payload["agent"])
	}
	if found.Payload["span_id"] == "" || found.Payload["span_id"] == nil {
		t.Errorf("span_id missing: %v", found.Payload["span_id"])
	}
	if _, ok := found.Payload["dispatch_depth"]; !ok {
		t.Error("dispatch_depth missing")
	}
	// SpanHandle.End stamps duration_ms and merges the End attrs (exit_code etc.).
	if _, ok := found.Payload["duration_ms"]; !ok {
		t.Error("duration_ms missing — span was not ended via SpanHandle.End")
	}
	if _, ok := found.Payload["exit_code"]; !ok {
		t.Error("exit_code missing — span End attrs not merged")
	}
	// conversation_id must appear on the start span so a sub-agent tree can be
	// associated with its parent conversation in forensics (telemetry query by
	// conversation_id).
	if found.Payload["conversation_id"] != "conv-depth" {
		t.Errorf("conversation_id = %v, want conv-depth", found.Payload["conversation_id"])
	}
}

// TestDispatchAgentSpanDisabledNoEvent verifies no dispatch.agent span is
// emitted when the session has no telemetry collector.
func TestDispatchAgentSpanDisabledNoEvent(t *testing.T) {
	acc := &depthTestAccessor{} // telem nil
	dispatchFn := BuildDispatchAgentFunc(acc, nil, 0, "")
	_, _ = dispatchFn(extension.DispatchAgentOpts{WaitForCompletion: true,
		Name:  "no-telem-agent",
		Task:  "work",
		Model: "no-such-model",
	})
	// Nothing to assert beyond "did not panic"; the accessor has no collector
	// so there is no buffer to inspect. The nil-guard in BuildDispatchAgentFunc
	// is what this exercises.
}

// TestDispatchAgentSpanExtensionAttributionCarried verifies that when the
// session accessor reports an extension name and version, the dispatch.agent
// span payload carries "extension" and "extension_version".
//
// RED on unfixed code: startDispatchSpan (pre-fix) never populated those keys,
// so these assertions would fail.
func TestDispatchAgentSpanExtensionAttributionCarried(t *testing.T) {
	col := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	acc := &extAttributionTestAccessor{
		depthTestAccessor: depthTestAccessor{telem: col},
		extName:           "ion-dev",
		extVer:            "4.0.0",
	}
	dispatchFn := BuildDispatchAgentFunc(acc, nil, 0, "")
	_, _ = dispatchFn(extension.DispatchAgentOpts{WaitForCompletion: true,
		Name:  "ext-span-agent",
		Task:  "attributed work",
		Model: "no-such-model",
	})

	var found *telemetry.Event
	for _, ev := range col.BufferedEvents() {
		ev := ev
		if ev.Name == telemetry.DispatchAgent {
			found = &ev
			break
		}
	}
	if found == nil {
		t.Fatal("expected a dispatch.agent span event")
	}
	if found.Payload["extension"] != "ion-dev" {
		t.Errorf("extension = %v, want ion-dev", found.Payload["extension"])
	}
	if found.Payload["extension_version"] != "4.0.0" {
		t.Errorf("extension_version = %v, want 4.0.0", found.Payload["extension_version"])
	}
}

// TestDispatchAgentSpanExtensionAttributionAbsent verifies that the
// dispatch.agent span does NOT carry "extension" or "extension_version" when
// the session has no extension identity. Old lines group as "unattributed".
//
// RED on unfixed code that always stamps the keys.
func TestDispatchAgentSpanExtensionAttributionAbsent(t *testing.T) {
	col := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	acc := &depthTestAccessor{telem: col} // ExtensionName/ExtensionVersion return ""
	dispatchFn := BuildDispatchAgentFunc(acc, nil, 0, "")
	_, _ = dispatchFn(extension.DispatchAgentOpts{WaitForCompletion: true,
		Name:  "unattributed-agent",
		Task:  "work",
		Model: "no-such-model",
	})

	var found *telemetry.Event
	for _, ev := range col.BufferedEvents() {
		ev := ev
		if ev.Name == telemetry.DispatchAgent {
			found = &ev
			break
		}
	}
	if found == nil {
		t.Fatal("expected a dispatch.agent span event")
	}
	if _, ok := found.Payload["extension"]; ok {
		t.Errorf("extension must be absent for non-extension dispatches; got %v", found.Payload["extension"])
	}
	if _, ok := found.Payload["extension_version"]; ok {
		t.Errorf("extension_version must be absent for non-extension dispatches; got %v", found.Payload["extension_version"])
	}
}

// extAttributionTestAccessor is a SessionAccessor test double that surfaces
// extension name and version so TestDispatchAgentSpanExtensionAttributionCarried
// can verify the extension fields reach the dispatch.agent span payload.
// It embeds depthTestAccessor (which satisfies the full SessionAccessor
// interface) and overrides only the two extension-attribution methods.
type extAttributionTestAccessor struct {
	depthTestAccessor
	extName string
	extVer  string
}

func (a *extAttributionTestAccessor) ExtensionName() string    { return a.extName }
func (a *extAttributionTestAccessor) ExtensionVersion() string { return a.extVer }

func (a *extAttributionTestAccessor) AppContext() map[string]string { return nil }

// principalTestAccessor is a SessionAccessor test double that surfaces a
// stamped SessionPrincipal, so TestDispatchAgentSpanUserAttributionCarried
// can verify the dispatch.agent span's Event.User carries it.
type principalTestAccessor struct {
	depthTestAccessor
	principal *types.SessionPrincipal
}

func (a *principalTestAccessor) Principal() *types.SessionPrincipal { return a.principal }

// TestDispatchAgentSpanUserAttributionCarried pins the origin fix for a
// dispatch.agent event shipping with no user at all on a deployment where
// the server's own OIDC door authenticates the session's principal but the
// engine has no process-wide operator identity of its own (every Atlas
// instance pod: server.json's oidc/allowedSubjects authenticate the person,
// engine.json carries no auth.identityProvider). startDispatchSpan
// (pre-fix) called the bare two-arg Collector.StartSpan, which always
// passes a nil ctx, so telemetry.identityForEvent had nothing but the
// (here, empty) process-wide fallback to read -- unlike every other
// telemetry event type, which stamps the session's own principal into ctx.
//
// RED on unfixed code: Event.User would be "" even though the session has
// an attributed principal.
func TestDispatchAgentSpanUserAttributionCarried(t *testing.T) {
	col := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	acc := &principalTestAccessor{
		depthTestAccessor: depthTestAccessor{telem: col},
		principal:         &types.SessionPrincipal{Subject: "entra-oid-123", DisplayName: "JDoe@example.com"},
	}
	dispatchFn := BuildDispatchAgentFunc(acc, nil, 0, "")
	_, _ = dispatchFn(extension.DispatchAgentOpts{WaitForCompletion: true,
		Name:  "attributed-user-agent",
		Task:  "work",
		Model: "no-such-model",
	})

	var found *telemetry.Event
	for _, ev := range col.BufferedEvents() {
		ev := ev
		if ev.Name == telemetry.DispatchAgent {
			found = &ev
			break
		}
	}
	if found == nil {
		t.Fatal("expected a dispatch.agent span event")
	}
	if found.User != "JDoe@example.com" {
		t.Errorf("User = %q, want %q", found.User, "JDoe@example.com")
	}
}

// TestDispatchAgentSpanUserAttributionAbsentIsSafe verifies an unattributed
// session (Principal() nil, the common case: no session principal and no
// process-wide operator identity) produces an empty Event.User rather than
// panicking -- SessionPrincipal.AttributionForTelemetry is a nil-receiver-safe
// method, and startDispatchSpan relies on that.
func TestDispatchAgentSpanUserAttributionAbsentIsSafe(t *testing.T) {
	col := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	acc := &depthTestAccessor{telem: col} // Principal() returns nil
	dispatchFn := BuildDispatchAgentFunc(acc, nil, 0, "")
	_, _ = dispatchFn(extension.DispatchAgentOpts{WaitForCompletion: true,
		Name:  "unattributed-user-agent",
		Task:  "work",
		Model: "no-such-model",
	})

	var found *telemetry.Event
	for _, ev := range col.BufferedEvents() {
		ev := ev
		if ev.Name == telemetry.DispatchAgent {
			found = &ev
			break
		}
	}
	if found == nil {
		t.Fatal("expected a dispatch.agent span event")
	}
	if found.User != "" {
		t.Errorf("User = %q, want empty for an unattributed session", found.User)
	}
}
