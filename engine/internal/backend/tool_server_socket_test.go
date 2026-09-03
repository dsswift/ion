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

// readBridgeSocketArg parses the MCP config JSON written by McpConfigPath and
// returns the socket path the self-exec bridge is pointed at (the argv element
// after "--socket"). Reading it from the written file avoids adding new surface
// just for the test.
func readBridgeSocketArg(t *testing.T, configPath string) string {
	t.Helper()
	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read config %q: %v", configPath, err)
	}
	var cfg struct {
		McpServers map[string]struct {
			Command string   `json:"command"`
			Args    []string `json:"args"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		t.Fatalf("unmarshal config: %v", err)
	}
	srv, ok := cfg.McpServers[McpServerName]
	if !ok {
		t.Fatalf("config missing mcpServers.%s", McpServerName)
	}
	// The bridge must never be socat again: that dependency was the whole bug.
	if srv.Command == "socat" {
		t.Fatalf("config command is socat; expected the self-exec ion mcp-bridge")
	}
	for i, a := range srv.Args {
		if a == "--socket" && i+1 < len(srv.Args) {
			return srv.Args[i+1]
		}
	}
	t.Fatalf("config args %v missing --socket <path>", srv.Args)
	return ""
}

// TestSocketPathSanitization verifies that session keys containing
// characters illegal or dangerous in a socket path (colon, comma, slash,
// space) never leak into the derived socket path or the bridge argument,
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

			// The bridge receives the socket path as a discrete argv element
			// (`--socket <path>`), so the sanitized digest — not the raw key —
			// is what reaches it, and it matches the actual listening socket.
			configPath, err := ts.McpConfigPath(tc.key)
			if err != nil {
				t.Fatalf("McpConfigPath: %v", err)
			}
			t.Cleanup(func() { _ = os.Remove(configPath) })

			arg := readBridgeSocketArg(t, configPath)
			if arg != ts.SocketPath() {
				t.Errorf("bridge --socket arg %q != tool-server socket %q", arg, ts.SocketPath())
			}
			for _, bad := range []string{":", ",", " "} {
				// The filename (digest) portion carries no raw-key characters.
				argBase := arg
				if i := strings.LastIndex(arg, "/"); i >= 0 {
					argBase = arg[i+1:]
				}
				if strings.Contains(argBase, bad) {
					t.Errorf("bridge socket filename %q contains forbidden %q", argBase, bad)
				}
			}
		})
	}
}

// TestStartWithColonKey verifies that a session key containing a colon
// binds successfully. The derived path is a hashed digest, so the colon
// never reaches the filesystem; this test guards that the digest yields a
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
