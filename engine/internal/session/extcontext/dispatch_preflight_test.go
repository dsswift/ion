package extcontext

import (
	"context"
	"encoding/json"
	"fmt"
	"syscall"
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/procres"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// stubDispatchProbe replaces the spawn probe for one test.
func stubDispatchProbe(t *testing.T, probe func(context.Context) error) {
	t.Helper()
	orig := probeDispatchSpawn
	probeDispatchSpawn = probe
	t.Cleanup(func() { probeDispatchSpawn = orig })
}

// The regression for a process driven to EMFILE: a new dispatch to the same
// agent name is refused before anything starts, with a machine-readable
// resource_exhausted result, and the same agent dispatches normally again once
// the process can spawn.
func TestDispatchPreflight_ExhaustedProcessRefusesThenRecovers(t *testing.T) {
	col := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	acc := &depthTestAccessor{telem: col}
	registry := NewDispatchRegistry()
	dispatchFn := BuildDispatchAgentFunc(acc, registry, 0, "")
	opts := extension.DispatchAgentOpts{WaitForCompletion: true, Name: "persistent-agent", Task: "unrelated task", Model: "no-such-model-for-preflight"}

	stubDispatchProbe(t, func(context.Context) error {
		return fmt.Errorf("fork/exec /bin/bash: %w", syscall.EMFILE)
	})
	result, err := dispatchFn(opts)
	if err != nil {
		t.Fatalf("refusal returned an error, want a result: %v", err)
	}
	if result.ErrorCode != extension.DispatchErrorCodeResourceExhausted {
		t.Fatalf("ErrorCode = %q, want %q", result.ErrorCode, extension.DispatchErrorCodeResourceExhausted)
	}
	if result.ResourceExhausted == nil || result.ResourceExhausted.Resource != procres.ResourceFileDescriptors {
		t.Fatalf("ResourceExhausted = %+v, want resource %q", result.ResourceExhausted, procres.ResourceFileDescriptors)
	}
	if result.ExitCode != 1 || result.DispatchID != "" {
		t.Errorf("ExitCode = %d, DispatchID = %q; want 1 and no dispatch id", result.ExitCode, result.DispatchID)
	}
	if registry.Count() != 0 {
		t.Errorf("registry holds %d dispatches after a refusal, want 0", registry.Count())
	}
	for _, e := range col.BufferedEvents() {
		if e.Name == telemetry.DispatchAgent {
			t.Fatal("a refused dispatch opened a dispatch.agent span: the task was started")
		}
	}

	stubDispatchProbe(t, func(context.Context) error { return nil })
	result, _ = dispatchFn(opts) //nolint:errcheck // the child fails downstream with no provider; only the preflight outcome is under test
	if result != nil && result.ErrorCode != "" {
		t.Fatalf("ErrorCode = %q after the process recovered, want a launched dispatch", result.ErrorCode)
	}
	var span *telemetry.Event
	events := col.BufferedEvents()
	for i := range events {
		if events[i].Name == telemetry.DispatchAgent {
			span = &events[i]
		}
	}
	if span == nil {
		t.Fatal("the recovered dispatch opened no dispatch.agent span: it was not launched")
	}
	if procres.ReadDescriptors().Open != procres.Unknown {
		for _, key := range []string{"fd_open", "fd_open_start", "fd_limit", "fd_delta"} {
			if _, ok := span.Payload[key]; !ok {
				t.Errorf("dispatch.agent span is missing %s", key)
			}
		}
	}
}

// A probe failure that is not resource exhaustion must not refuse a dispatch.
func TestDispatchPreflight_NonResourceFailureAllows(t *testing.T) {
	stubDispatchProbe(t, func(context.Context) error {
		return fmt.Errorf("exec: %w", syscall.ENOENT)
	})
	if refused := preflightDispatchResources(&depthTestAccessor{}, "agent", 1, ""); refused != nil {
		t.Fatalf("refused on a non-resource probe failure: %+v", refused)
	}
}

// The refusal crosses the extension RPC boundary as JSON; pin its field names.
func TestDispatchPreflight_RefusalWireShape(t *testing.T) {
	stubDispatchProbe(t, func(context.Context) error { return syscall.EAGAIN })
	refused := preflightDispatchResources(&depthTestAccessor{}, "agent", 2, "parent-1")
	if refused == nil {
		t.Fatal("no refusal for an exhausted process table")
	}
	raw, err := json.Marshal(refused)
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	if wire["errorCode"] != "resource_exhausted" {
		t.Errorf("errorCode = %v, want resource_exhausted", wire["errorCode"])
	}
	detail, ok := wire["resourceExhausted"].(map[string]any)
	if !ok {
		t.Fatalf("resourceExhausted = %v, want an object", wire["resourceExhausted"])
	}
	if detail["resource"] != procres.ResourceProcesses || detail["message"] == "" {
		t.Errorf("resourceExhausted = %v", detail)
	}
}
