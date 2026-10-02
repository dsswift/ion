package session

import (
	"errors"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/types"
)

// captureEngineErrors records every engine_error the manager emits.
func captureEngineErrors(mgr *Manager) func() []types.EngineEvent {
	var mu sync.Mutex
	var events []types.EngineEvent
	mgr.OnEvent(func(_ string, ev types.EngineEvent) {
		if ev.Type == "engine_error" {
			mu.Lock()
			events = append(events, ev)
			mu.Unlock()
		}
	})
	return func() []types.EngineEvent {
		mu.Lock()
		defer mu.Unlock()
		return append([]types.EngineEvent(nil), events...)
	}
}

// A refused model reports the same failure whether or not policy rewords it:
// the configured text replaces only the message.
func TestSendPrompt_ModelNotAllowedMessage(t *testing.T) {
	const defaultText = `model "blocked-model" not allowed by enterprise policy`
	cases := []struct {
		name     string
		messages map[string]string
		want     string
	}{
		{"default", nil, defaultText},
		{"other identifier configured", map[string]string{types.PolicyFailureToolBlocked: "ask IT"}, defaultText},
		{"blank override", map[string]string{types.PolicyFailureModelNotAllowed: ""}, defaultText},
		{"override", map[string]string{types.PolicyFailureModelNotAllowed: "Request access at the service desk."}, "Request access at the service desk."},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mb := newMockBackend()
			mgr := NewManager(mb)
			mgr.SetConfig(&types.EngineRuntimeConfig{Enterprise: &types.EnterpriseConfig{
				BlockedModels: []string{"blocked-model"},
				Messages:      tc.messages,
			}})
			if _, err := mgr.StartSession("k", defaultConfig()); err != nil {
				t.Fatalf("StartSession: %v", err)
			}
			engineErrors := captureEngineErrors(mgr)

			err := mgr.SendPrompt("k", "hello", &PromptOverrides{Model: "blocked-model"})

			var policyErr *types.PolicyError
			if !errors.As(err, &policyErr) || policyErr.Failure != types.PolicyFailureModelNotAllowed {
				t.Fatalf("SendPrompt error = %v, want a model_not_allowed PolicyError", err)
			}
			if err.Error() != tc.want {
				t.Fatalf("error text = %q, want %q", err.Error(), tc.want)
			}
			if policyErr.Cause == nil || policyErr.Cause.Error() != defaultText {
				t.Fatalf("cause = %v, want the engine default", policyErr.Cause)
			}
			if len(mb.startedKeys()) != 0 {
				t.Fatal("a refused model must not reach the backend")
			}
			events := engineErrors()
			if len(events) != 1 {
				t.Fatalf("engine_error count = %d, want 1", len(events))
			}
			if events[0].EventMessage != tc.want || events[0].PolicyFailure != types.PolicyFailureModelNotAllowed || events[0].ErrorCode != "" {
				t.Fatalf("engine_error = %+v", events[0])
			}
		})
	}
}

// The managed lock names its Policy Failure and keeps its error code. No
// policy resolved, so its text is the engine default.
func TestSendPrompt_ManagedPolicyAbsentCarriesPolicyFailure(t *testing.T) {
	mgr := NewManager(newMockBackend())
	if _, err := mgr.StartSession("k", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.SetConfig(managedConfig(true))
	engineErrors := captureEngineErrors(mgr)

	err := mgr.SendPrompt("k", "hello", nil)

	if !errors.Is(err, errManagedPolicyAbsent) || err.Error() != errManagedPolicyAbsent.Error() {
		t.Fatalf("SendPrompt error = %v, want errManagedPolicyAbsent", err)
	}
	events := engineErrors()
	if len(events) != 1 {
		t.Fatalf("engine_error count = %d, want 1", len(events))
	}
	got := events[0]
	if got.EventMessage != errManagedPolicyAbsent.Error() || got.ErrorCode != managedPolicyAbsentErrorCode || got.PolicyFailure != types.PolicyFailureManagedPolicyAbsent {
		t.Fatalf("engine_error = %+v", got)
	}
}

// A policy tool block always names its Policy Failure, blocks either way, and
// uses the policy's text when one is configured. The run config also carries
// what a run needs to name a provider that policy removed.
func TestBuildRunConfig_PolicyFailureWiring(t *testing.T) {
	for _, override := range []string{"", "Shell access is disabled here. Ask IT for an exception."} {
		apiBackend := backend.NewApiBackend()
		mgr := NewManager(apiBackend)
		cfg := enterpriseDenyBash()
		cfg.PolicyPrunedProviders = []string{"shadow"}
		want := "tool blocked by enterprise policy"
		if override != "" {
			cfg.Enterprise.Messages = map[string]string{types.PolicyFailureToolBlocked: override}
			want = override
		}
		mgr.SetConfig(cfg)
		s := newPlainTestSession("k")
		mgr.mu.Lock()
		mgr.sessions = map[string]*engineSession{"k": s}
		mgr.mu.Unlock()

		runCfg := mgr.buildRunConfig(s, "k", "req-1", apiBackend, nil, false, nil, nil, nil, "", nil)

		result, err := runCfg.Hooks.OnToolCall(backend.ToolCallInfo{ToolName: "Bash", ToolID: "t1"})
		if err != nil || result == nil || !result.Block {
			t.Fatalf("override %q: Bash was not blocked: %+v, %v", override, result, err)
		}
		if result.Reason != want || result.PolicyFailure != types.PolicyFailureToolBlocked {
			t.Fatalf("override %q: block = %+v", override, result)
		}
		if len(runCfg.PolicyPrunedProviders) != 1 || runCfg.PolicyPrunedProviders[0] != "shadow" {
			t.Fatalf("pruned providers = %v", runCfg.PolicyPrunedProviders)
		}
		if runCfg.PolicyMessages[types.PolicyFailureToolBlocked] != override {
			t.Fatalf("policy messages = %v", runCfg.PolicyMessages)
		}
		mgr.Shutdown()
	}
}

func TestTranslateToEngineEvent_CarriesPolicyFailure(t *testing.T) {
	errorEvent := translateToEngineEvent(types.NormalizedEvent{Data: &types.ErrorEvent{
		ErrorMessage: "m", ErrorCode: "invalid_model", PolicyFailure: types.PolicyFailureProviderNotAuthorized,
	}}, 0)
	if errorEvent.Type != "engine_error" || errorEvent.ErrorCode != "invalid_model" || errorEvent.PolicyFailure != types.PolicyFailureProviderNotAuthorized {
		t.Fatalf("engine_error = %+v", errorEvent)
	}
	toolEnd := translateToEngineEvent(types.NormalizedEvent{Data: &types.ToolResultEvent{
		ToolID: "t1", Content: "Blocked: x", IsError: true, PolicyFailure: types.PolicyFailureToolBlocked,
	}}, 0)
	if toolEnd.Type != "engine_tool_end" || toolEnd.PolicyFailure != types.PolicyFailureToolBlocked {
		t.Fatalf("engine_tool_end = %+v", toolEnd)
	}
}
