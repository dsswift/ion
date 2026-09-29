package session

// manager_mcp_probe_test.go — a sign-in or edit replaces a server's recorded
// connect error with the outcome of a fresh attempt, whether a live session
// reconnects or the probe runs.

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestProbeMcpServer_ClearsStaleErrorWhenTheServerAnswers(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	srv := mcpTestServer(t, "probe_tool")
	writeUserEngineConfig(t, `{"mcpServers":{"probed":{"type":"http","url":"`+srv.URL+`"}}}`)

	mgr := NewManager(newMockBackend())
	mgr.recordMcpConnectError("probed", errors.New("HTTP 401 before sign-in"))
	t.Cleanup(func() { mgr.clearMcpConnectError("probed") })

	if err := mgr.ProbeMcpServer("probed", ""); err != nil {
		t.Fatalf("ProbeMcpServer: %v", err)
	}
	if got := mcpConnectError("probed"); got != "" {
		t.Errorf("stale connect error survived a successful probe: %q", got)
	}
	for _, status := range mgr.McpServerStatuses("") {
		if status.Name == "probed" && status.LastError != "" {
			t.Errorf("snapshot still reports lastError %q", status.LastError)
		}
	}
}

func TestProbeMcpServer_RecordsTheCurrentFailure(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	refusing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	t.Cleanup(refusing.Close)
	writeUserEngineConfig(t, `{"mcpServers":{"refusing":{"type":"http","url":"`+refusing.URL+`"}}}`)

	mgr := NewManager(newMockBackend())
	t.Cleanup(func() { mgr.clearMcpConnectError("refusing") })

	if err := mgr.ProbeMcpServer("refusing", ""); err == nil {
		t.Fatal("expected the probe to fail against a server that refuses every request")
	}
	if mcpConnectError("refusing") == "" {
		t.Error("a failed probe must record its error for the snapshot")
	}
}

func TestReconnect_ClearsStaleConnectError(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	srv := mcpTestServer(t, "live_tool")
	writeUserEngineConfig(t, `{"mcpServers":{"live":{"type":"http","url":"`+srv.URL+`"}}}`)

	mgr := NewManager(newMockBackend())
	key := "live-session"
	if _, err := mgr.StartSession(key, types.EngineConfig{ProfileID: "test"}); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession(key) }) //nolint:errcheck // best-effort test teardown
	dispatchPrompt(t, mgr, key)

	mgr.recordMcpConnectError("live", errors.New("HTTP 401 before sign-in"))
	t.Cleanup(func() { mgr.clearMcpConnectError("live") })

	if reconnected := mgr.ReconnectMcpServer("live"); reconnected != 1 {
		t.Fatalf("reconnected = %d, want 1", reconnected)
	}
	if got := mcpConnectError("live"); got != "" {
		t.Errorf("stale connect error survived a successful reconnect: %q", got)
	}
}
