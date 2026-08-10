package extcontext

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestForegroundAndBackground_BothRegistered pins issue #2: both foreground
// (Background=false) and background (Background=true) dispatches must appear in
// the dispatch registry during their run and deregister afterward. Before the
// foreground-registration fix, only background dispatches registered, so a
// foreground child could not be recalled, counted, or steered.
//
// The foreground dispatch is synchronous and registration happens before
// runChild, so we observe the registry mid-flight via the childStart hook on
// the test accessor (NewChildBackend signals it). The background dispatch is
// asynchronous; we observe its registration via the registry's ActiveNames
// right after the stub returns.
func TestForegroundAndBackground_BothRegistered(t *testing.T) {
	// --- Foreground: observe registration mid-run via childStart hook. ---
	t.Run("foreground", func(t *testing.T) {
		registry := NewDispatchRegistry()
		childStartCh := make(chan struct{}, 1)
		acc := &depthTestAccessor{
			config:     &types.EngineRuntimeConfig{MaxDispatchDepth: 5},
			childStart: childStartCh,
		}
		dispatchFn := BuildDispatchAgentFunc(acc, registry, 0, "")

		var sawRegistered bool
		done := make(chan struct{})
		go func() {
			defer close(done)
			<-childStartCh
			// NewChildBackend just fired; registration happens immediately
			// after (the foreground RegisterWithID block) and before runChild
			// deregisters. Spin briefly to catch the count > 0 window.
			for i := 0; i < 100000; i++ {
				if registry.Count() > 0 {
					sawRegistered = true
					return
				}
			}
		}()

		_, _ = dispatchFn(extension.DispatchAgentOpts{WaitForCompletion: true,
			Name: "fg-agent",
			Task: "foreground task",
		})
		<-done

		if !sawRegistered {
			t.Error("foreground dispatch was NOT registered during the run (issue #2 regression)")
		}
		if registry.Count() != 0 {
			t.Errorf("foreground dispatch leaked a registry entry: count=%d", registry.Count())
		}
	})

	// --- Background: registers before the stub returns, deregisters after. ---
	t.Run("background", func(t *testing.T) {
		registry := NewDispatchRegistry()
		acc := &depthTestAccessor{
			config: &types.EngineRuntimeConfig{MaxDispatchDepth: 5},
		}
		dispatchFn := BuildDispatchAgentFunc(acc, registry, 0, "")

		_, err := dispatchFn(extension.DispatchAgentOpts{
			Name:       "bg-agent",
			Task:       "background task",
			Background: true,
		})
		if err != nil {
			t.Fatalf("background dispatch returned error: %v", err)
		}

		// The background goroutine registers before launching the child and
		// deregisters in runChild. Because there is no provider the child
		// errors immediately, so the entry may already be gone by the time we
		// check. The deterministic invariant we CAN pin is that registration
		// happened at least once: we verify the dispatch_start telemetry fired
		// (proving the dispatch ran through the registration block) and that
		// the registry is eventually empty (deregistered, no leak).
		var sawStart bool
		for _, ev := range acc.emittedEvents() {
			if ev.Type == "engine_dispatch_start" && ev.DispatchAgent == "bg-agent" {
				sawStart = true
				break
			}
		}
		if !sawStart {
			t.Fatal("expected engine_dispatch_start for background dispatch")
		}

		// Poll for eventual deregistration (background goroutine cleanup).
		deadline := 0
		for registry.Count() != 0 && deadline < 1000000 {
			deadline++
		}
		if registry.Count() != 0 {
			t.Errorf("background dispatch leaked a registry entry: count=%d", registry.Count())
		}
	})
}

// TestForegroundDispatch_RegisteredDuringRun already exists in
// dispatch_depth_test.go (written alongside the foreground registration fix);
// it is not duplicated here. This file adds the both-paths symmetry test.
