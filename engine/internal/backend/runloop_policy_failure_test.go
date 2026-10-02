package backend

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestNoProviderMessage(t *testing.T) {
	const override = "This gateway is not approved. Use the corporate gateway."
	pruned := []string{"shadow"}
	cases := []struct {
		name        string
		cfg         *RunConfig
		model       string
		wantMessage string
		wantFailure string
	}{
		{"no run config", nil, "shadow/model-a", `no provider found for model "shadow/model-a"`, ""},
		{"unqualified model", &RunConfig{PolicyPrunedProviders: pruned}, "model-a", `no provider found for model "model-a"`, ""},
		{"qualified by a provider policy did not remove", &RunConfig{PolicyPrunedProviders: pruned}, "other/model-a", `no provider found for model "other/model-a"`, ""},
		{"removed provider, default text", &RunConfig{PolicyPrunedProviders: pruned}, "shadow/model-a", `no provider found for model "shadow/model-a"`, types.PolicyFailureProviderNotAuthorized},
		{"removed provider, override", &RunConfig{PolicyPrunedProviders: pruned, PolicyMessages: map[string]string{types.PolicyFailureProviderNotAuthorized: override}}, "shadow/model-a", override, types.PolicyFailureProviderNotAuthorized},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			message, failure := noProviderMessage(&activeRun{requestID: "r", cfg: tc.cfg}, tc.model)
			if message != tc.wantMessage || failure != tc.wantFailure {
				t.Fatalf("got (%q, %q), want (%q, %q)", message, failure, tc.wantMessage, tc.wantFailure)
			}
		})
	}
}
