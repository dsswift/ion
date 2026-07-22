package network

import (
	"os"
	"strings"
	"testing"
)

// TestEnterpriseTransportCallSites pins the D-018 fix: the engine-owned outbound
// HTTP call sites that are NOT LLM provider streams must route through the
// enterprise-configured transport (network.GetHTTPClient), never
// http.DefaultClient — otherwise a proxied or custom-CA network breaks them.
// A future edit that reintroduces http.DefaultClient.Do at one of these sites
// goes red here.
func TestEnterpriseTransportCallSites(t *testing.T) {
	// Paths relative to this package directory (internal/network).
	files := []string{
		"../telemetry/telemetry.go",
		"../tools/web_search.go",
		"../tools/web_fetch.go",
		"../extension/http_request.go",
	}
	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("read %s: %v", f, err)
		}
		if strings.Contains(string(data), "http.DefaultClient") {
			t.Errorf("%s must not use http.DefaultClient — route through network.GetHTTPClient() so the enterprise proxy/CA transport applies (D-018)", f)
		}
	}
}
