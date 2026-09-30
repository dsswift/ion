package config

import (
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestNormalizeMcpServerConfig_SecretHeaders(t *testing.T) {
	ref := func(source string) map[string]types.McpSecretHeader {
		return map[string]types.McpSecretHeader{"X-Api-Key": {SecretReference: types.SecretReference{SecretRef: "gatewayKey", SecretSource: source}}}
	}
	valid := types.McpServerConfig{URL: "https://mcp.example.com", SecretHeaders: ref(types.SecretSourceApplicationConfig)}
	if err := NormalizeMcpServerConfig(&valid); err != nil {
		t.Fatalf("valid secret header refused: %v", err)
	}
	cases := map[string]types.McpServerConfig{
		"unknown source": {URL: "https://mcp.example.com", SecretHeaders: ref("vault")},
		"missing ref":    {URL: "https://mcp.example.com", SecretHeaders: map[string]types.McpSecretHeader{"X-Api-Key": {}}},
		"stdio":          {Command: "/usr/local/bin/server", SecretHeaders: ref("")},
	}
	for name, cfg := range cases {
		if err := NormalizeMcpServerConfig(&cfg); err == nil || !strings.Contains(err.Error(), "secretHeaders") {
			t.Fatalf("%s: want a secretHeaders error, got %v", name, err)
		}
	}
}
