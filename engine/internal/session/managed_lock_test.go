package session

import (
	"errors"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func managedConfig(policyAbsent bool) *types.EngineRuntimeConfig {
	return &types.EngineRuntimeConfig{
		Enterprise: &types.EnterpriseConfig{
			ManagedMode: &types.ManagedModeStatus{Managed: true, PolicyAbsent: policyAbsent},
		},
	}
}

func TestSendPrompt_ManagedWithoutPolicy_Refused(t *testing.T) {
	mgr := NewManager(newMockBackend())
	if _, err := mgr.StartSession("locked", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.SetConfig(managedConfig(true))

	var mu sync.Mutex
	var codes []string
	mgr.OnEvent(func(_ string, ev types.EngineEvent) {
		if ev.Type == "engine_error" {
			mu.Lock()
			codes = append(codes, ev.ErrorCode)
			mu.Unlock()
		}
	})

	err := mgr.SendPrompt("locked", "hello", nil)
	if !errors.Is(err, errManagedPolicyAbsent) {
		t.Fatalf("SendPrompt error = %v, want errManagedPolicyAbsent", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(codes) != 1 || codes[0] != managedPolicyAbsentErrorCode {
		t.Fatalf("engine_error codes = %v, want one %q", codes, managedPolicyAbsentErrorCode)
	}
}

func TestManagedLocked(t *testing.T) {
	cases := []struct {
		name string
		cfg  *types.EngineRuntimeConfig
		want bool
	}{
		{"no config", nil, false},
		{"unmanaged, no policy", &types.EngineRuntimeConfig{}, false},
		{"unmanaged, policy", &types.EngineRuntimeConfig{Enterprise: &types.EnterpriseConfig{}}, false},
		{"managed, policy present", managedConfig(false), false},
		{"managed, policy absent", managedConfig(true), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mgr := NewManager(newMockBackend())
			mgr.SetConfig(tc.cfg)
			if got := mgr.managedLocked(); got != tc.want {
				t.Fatalf("managedLocked() = %v, want %v", got, tc.want)
			}
			if err := mgr.rejectIfManagedLocked("k"); (err != nil) != tc.want {
				t.Fatalf("rejectIfManagedLocked() = %v, want refusal %v", err, tc.want)
			}
		})
	}
}
