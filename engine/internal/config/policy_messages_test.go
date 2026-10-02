package config

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestPolicyMessage(t *testing.T) {
	messages := map[string]string{"model_not_allowed": "Ask the service desk.", "tool_blocked": ""}
	cases := []struct {
		name     string
		messages map[string]string
		id       string
		want     string
	}{
		{"override", messages, "model_not_allowed", "Ask the service desk."},
		{"no entry", messages, "extension_blocked", "default"},
		{"blank entry", messages, "tool_blocked", "default"},
		{"no policy", nil, "model_not_allowed", "default"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := PolicyMessage(tc.messages, tc.id, "default"); got != tc.want {
				t.Fatalf("PolicyMessage = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestNewPolicyErrorKeepsTheCause(t *testing.T) {
	sentinel := errors.New("engine default")
	err := NewPolicyError(map[string]string{"tool_blocked": "Ask IT."}, "tool_blocked", sentinel)
	if err.Error() != "Ask IT." || !errors.Is(err, sentinel) {
		t.Fatalf("error = %q, wraps sentinel = %v", err.Error(), errors.Is(err, sentinel))
	}
	if got := PolicyFailureOf(err); got != "tool_blocked" {
		t.Fatalf("PolicyFailureOf = %q", got)
	}
	if got := PolicyFailureOf(sentinel); got != "" {
		t.Fatalf("PolicyFailureOf(plain error) = %q, want empty", got)
	}
}

func TestPolicyFailureIDsAreUnique(t *testing.T) {
	seen := map[string]bool{}
	for _, id := range types.PolicyFailureIDs {
		if id == "" || seen[id] {
			t.Fatalf("identifier %q is blank or repeated", id)
		}
		seen[id] = true
	}
}

// A drop-in replaces the messages it names and leaves the rest standing.
func TestMergeEnterprisePartialMergesMessagesPerIdentifier(t *testing.T) {
	base := &types.EnterpriseConfig{Messages: map[string]string{"model_not_allowed": "base model", "tool_blocked": "base tool"}}
	overlay := &types.EnterpriseConfig{Messages: map[string]string{"tool_blocked": "overlay tool", "client_defined": "kept"}}

	merged := mergeEnterprisePartial(base, overlay)

	want := map[string]string{"model_not_allowed": "base model", "tool_blocked": "overlay tool", "client_defined": "kept"}
	if !reflect.DeepEqual(merged.Messages, want) {
		t.Fatalf("messages = %v, want %v", merged.Messages, want)
	}
	if base.Messages["tool_blocked"] != "base tool" {
		t.Fatal("the merge mutated its base")
	}
	if got := mergeEnterprisePartial(base, &types.EnterpriseConfig{}).Messages; !reflect.DeepEqual(got, base.Messages) {
		t.Fatalf("an overlay with no messages changed them: %v", got)
	}
}

func TestEnforceEnterpriseRecordsPrunedProviders(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{Providers: map[string]types.ProviderConfig{"corp": {}, "zeta": {}, "alpha": {}}}

	enforced := EnforceEnterprise(cfg, &types.EnterpriseConfig{AllowedProviders: []string{"corp"}})
	if want := []string{"alpha", "zeta"}; !reflect.DeepEqual(enforced.PolicyPrunedProviders, want) {
		t.Fatalf("pruned = %v, want %v", enforced.PolicyPrunedProviders, want)
	}

	unrestricted := EnforceEnterprise(cfg, &types.EnterpriseConfig{})
	if len(unrestricted.PolicyPrunedProviders) != 0 {
		t.Fatalf("pruned without an allowlist = %v", unrestricted.PolicyPrunedProviders)
	}
}

func TestPolicyRefusalsCarryTheConfiguredMessage(t *testing.T) {
	seedEngineConfig(t, `{}`)
	entPath := filepath.Join(t.TempDir(), "enterprise.json")
	policy := `{"mcpDenylist":["forbidden"],"newConversationDefaults":{"profileName":"missing","profileLocked":true},"messages":{"mcp_server_blocked":"MCP servers are managed centrally.","profile_locked":"Your profile is not installed yet."}}`
	if err := os.WriteFile(entPath, []byte(policy), 0o600); err != nil {
		t.Fatalf("write enterprise config: %v", err)
	}
	t.Setenv("ION_ENTERPRISE_CONFIG", entPath)

	err := CheckMcpServerAllowed("forbidden", types.McpServerConfig{Type: "http", URL: "https://example.test/mcp"})
	if err == nil || err.Error() != "MCP servers are managed centrally." || PolicyFailureOf(err) != types.PolicyFailureMcpServerBlocked {
		t.Fatalf("mcp refusal = %v (failure %q)", err, PolicyFailureOf(err))
	}
	if err := CheckMcpServerAllowed("fine", types.McpServerConfig{Type: "http", URL: "https://example.test/mcp"}); err != nil {
		t.Fatalf("an allowed server was refused: %v", err)
	}

	_, err = ApplyNewConversationDefaults(types.EngineConfig{WorkingDirectory: t.TempDir()})
	if err == nil || err.Error() != "Your profile is not installed yet." || PolicyFailureOf(err) != types.PolicyFailureProfileLocked {
		t.Fatalf("profile refusal = %v (failure %q)", err, PolicyFailureOf(err))
	}
}
