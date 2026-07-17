package backend

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// sunPathLimit is the smaller of the two platform sun_path limits
// (darwin=104, linux=108). Asserting against the smaller value keeps the
// test correct on both platforms without a build tag.
const sunPathLimit = 104

// readSocatArg parses the MCP config JSON written by McpConfigPath and
// returns the socat UNIX-CONNECT argument (the first entry in
// mcpServers.ion-extensions.args). Reading the arg from the written file
// avoids adding new surface just for the test.
func readSocatArg(t *testing.T, configPath string) string {
	t.Helper()
	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read config %q: %v", configPath, err)
	}
	var cfg struct {
		McpServers map[string]struct {
			Args []string `json:"args"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		t.Fatalf("unmarshal config: %v", err)
	}
	srv, ok := cfg.McpServers[McpServerName]
	if !ok {
		t.Fatalf("config missing mcpServers.%s", McpServerName)
	}
	if len(srv.Args) == 0 {
		t.Fatalf("config args empty")
	}
	return srv.Args[0]
}

// TestSocketPathSanitization verifies that session keys containing
// characters illegal or dangerous in a socket path (colon, comma, slash,
// space) never leak into the derived socket path or the socat argument,
// and that the derived path stays within the platform sun_path limit.
func TestSocketPathSanitization(t *testing.T) {
	cases := []struct {
		name string
		key  string
	}{
		{"colon", "a:b"},
		{"comma", "a,b"},
		{"slash", "a/b"},
		{"space", "a b"},
		{"long", strings.Repeat("x", 200)},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ts := NewToolServer(tc.key)

			sockPath := ts.SocketPath()

			// The basename (filename portion) must contain none of the
			// dangerous characters — the digest is [0-9a-f] only.
			base := sockPath
			if i := strings.LastIndex(sockPath, "/"); i >= 0 {
				base = sockPath[i+1:]
			}
			for _, bad := range []string{":", ",", "/", " "} {
				if strings.Contains(base, bad) {
					t.Errorf("socket basename %q contains forbidden %q", base, bad)
				}
			}

			// Full socket path must stay within the sun_path limit.
			if len(sockPath) >= sunPathLimit {
				t.Errorf("socket path len %d >= sun_path limit %d: %q", len(sockPath), sunPathLimit, sockPath)
			}

			// The socat UNIX-CONNECT arg must have no colon AFTER the
			// scheme prefix — socat parses a post-scheme colon as an
			// address-option delimiter, which is the root-cause bug.
			configPath, err := ts.McpConfigPath(tc.key)
			if err != nil {
				t.Fatalf("McpConfigPath: %v", err)
			}
			t.Cleanup(func() { _ = os.Remove(configPath) })

			arg := readSocatArg(t, configPath)
			const scheme = "UNIX-CONNECT:"
			if !strings.HasPrefix(arg, scheme) {
				t.Fatalf("socat arg %q missing scheme prefix %q", arg, scheme)
			}
			pathPart := strings.TrimPrefix(arg, scheme)
			if strings.Contains(pathPart, ":") {
				t.Errorf("socat arg path part %q contains a colon after scheme", pathPart)
			}
		})
	}
}

// TestStartWithColonKey verifies that a session key containing a colon
// binds successfully. Note the OS itself tolerates a colon in a unix
// socket filename, so this alone does not reproduce the bug — the
// colon's real damage is to socat's UNIX-CONNECT:<path> argument parsing,
// which is pinned by TestSocketPathSanitization's socat-arg assertion.
// This test guards the complementary invariant: the derived path is a
// valid, bindable socket path for a colon-bearing key.
func TestStartWithColonKey(t *testing.T) {
	ts := NewToolServer("tab-1:instance-2")
	if err := ts.Start(); err != nil {
		t.Fatalf("Start() with colon-bearing key failed: %v", err)
	}
	ts.Stop()
}

// TestSocketPathCollisionGuard ensures two distinct keys never collapse
// to the same socket path — the digest must preserve key distinctness.
func TestSocketPathCollisionGuard(t *testing.T) {
	a := NewToolServer("a:b").SocketPath()
	b := NewToolServer("a_b").SocketPath()
	if a == b {
		t.Errorf("distinct keys produced identical socket path %q", a)
	}
}
