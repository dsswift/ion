package backend

import "testing"

// TestCapabilities_Descriptors pins each backend's static capability
// descriptor — the contract the session layer's dispatch gate and
// resume-vs-bridge decision are built on. A descriptor change here is a
// behavior change at dispatch: it flips which prompts are declined and which
// runs resume natively, so every field is asserted explicitly.
func TestCapabilities_Descriptors(t *testing.T) {
	cases := []struct {
		name string
		caps BackendCapabilities
		want BackendCapabilities
	}{
		{
			name: "api",
			caps: NewApiBackend().Capabilities(),
			want: BackendCapabilities{
				Kind:         "api",
				ContextModel: ContextModelEngineOwned,
				PlanMode:     true,
				Steering:     true,
				Resume:       false,
			},
		},
		{
			name: "claude-code",
			caps: NewClaudeCodeBackend().Capabilities(),
			want: BackendCapabilities{
				Kind:             "claude-code",
				ContextModel:     ContextModelNativeSession,
				PlanMode:         true,
				Steering:         true,
				Resume:           true,
				ResumeHandleKind: ResumeHandleClaudeSessionUUID,
			},
		},
		{
			name: "codex",
			caps: NewCodexBackend().Capabilities(),
			want: BackendCapabilities{
				Kind:             "codex",
				ContextModel:     ContextModelNativeSession,
				PlanMode:         true,
				Steering:         true,
				Resume:           true,
				ResumeHandleKind: ResumeHandleCodexThreadID,
			},
		},
		{
			name: "grok",
			caps: NewGrokBackend().Capabilities(),
			want: BackendCapabilities{
				Kind:             "grok",
				ContextModel:     ContextModelNativeSession,
				PlanMode:         false, // grok advertises no plan/architect mode
				Steering:         false, // ACP has no steer channel
				Resume:           true,
				ResumeHandleKind: ResumeHandleAcpSessionID,
			},
		},
		{
			name: "cursor",
			caps: NewCursorBackend().Capabilities(),
			want: BackendCapabilities{
				Kind:             "cursor",
				ContextModel:     ContextModelNativeSession,
				PlanMode:         true, // cursor advertises a plan/architect mode
				Steering:         false,
				Resume:           true,
				ResumeHandleKind: ResumeHandleAcpSessionID,
			},
		},
	}
	for _, tc := range cases {
		if tc.caps != tc.want {
			t.Errorf("%s: Capabilities() = %+v, want %+v", tc.name, tc.caps, tc.want)
		}
	}
}

// TestCapabilities_HybridDelegatesPerModel pins the hybrid resolution seam:
// per-model capability lookups go through ResolveFor(model).Capabilities(),
// which is exactly what the session layer's resolvedBackend(model) does. A
// CLI-authed anthropic model reports claude-code's descriptor; without any
// credentials routing degrades to api and reports the api descriptor.
func TestCapabilities_HybridDelegatesPerModel(t *testing.T) {
	h := NewHybridBackend()
	// No key, no CLI auth: everything degrades to api.
	if got := h.ResolveFor("anything").Capabilities(); got.Kind != "api" {
		t.Errorf("no-credential hybrid resolution: Kind = %q, want api", got.Kind)
	}
	// The interface method answers for the default-routed inner.
	if got := h.Capabilities(); got.Kind != "api" {
		t.Errorf("hybrid Capabilities(): Kind = %q, want api (default-routed inner)", got.Kind)
	}
}
