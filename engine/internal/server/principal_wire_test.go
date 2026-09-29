package server

// principal_wire_test.go — end-to-end tests for the manifest C2 wire
// additions to get_host_info (installId), get_enterprise_policy
// (policyHash), and list_sessions (principalSubject / includeUnowned
// filtering).

import (
	"encoding/json"
	"net"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestGetHostInfo_CarriesInstallID verifies get_host_info's reply includes a
// non-empty installId (manifest C2), read from ~/.ion/install_id.
func TestGetHostInfo_CarriesInstallID(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)

	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]interface{}{
		"cmd":       "get_host_info",
		"requestId": "req-host-info",
	})

	lines := readLines(t, conn, 3, 2*time.Second)
	result := findResult(t, lines)
	if result == nil {
		t.Fatalf("no result received; lines=%v", lines)
	}
	if !result.OK {
		t.Fatalf("expected ok=true, got ok=false: %s", result.Error)
	}

	raw, err := json.Marshal(result.Data)
	if err != nil {
		t.Fatalf("marshal result.Data: %v", err)
	}
	var data map[string]interface{}
	if err := json.Unmarshal(raw, &data); err != nil {
		t.Fatalf("unmarshal result.Data: %v", err)
	}
	installID, _ := data["installId"].(string)
	if installID == "" {
		t.Fatal("get_host_info reply has no installId")
	}
}

// TestGetEnterprisePolicy_PolicyHashStableAndChanges verifies policyHash is
// stable across two calls with an unchanged policy and changes when the
// policy does (manifest C2).
func TestGetEnterprisePolicy_PolicyHashStableAndChanges(t *testing.T) {
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)
	srv.SetConfig(&types.EngineRuntimeConfig{
		Enterprise: &types.EnterpriseConfig{
			AllowedModels: []string{"model-a"},
		},
	})

	getHash := func(reqID string) string {
		conn := dialServer(t, srv)
		defer conn.Close()
		sendJSON(t, conn, map[string]interface{}{"cmd": "get_enterprise_policy", "requestId": reqID})
		lines := readLines(t, conn, 3, 2*time.Second)
		result := findResult(t, lines)
		if result == nil {
			t.Fatalf("no result received; lines=%v", lines)
		}
		raw, err := json.Marshal(result.Data)
		if err != nil {
			t.Fatalf("marshal result.Data: %v", err)
		}
		var data map[string]interface{}
		if err := json.Unmarshal(raw, &data); err != nil {
			t.Fatalf("unmarshal result.Data: %v", err)
		}
		hash, _ := data["policyHash"].(string)
		if hash == "" {
			t.Fatal("get_enterprise_policy reply has no policyHash")
		}
		return hash
	}

	first := getHash("req-hash-1")
	second := getHash("req-hash-2")
	if first != second {
		t.Errorf("policyHash changed across two calls with an unchanged policy: %q vs %q", first, second)
	}

	srv.SetConfig(&types.EngineRuntimeConfig{
		Enterprise: &types.EnterpriseConfig{
			AllowedModels: []string{"model-a", "model-b"},
		},
	})
	third := getHash("req-hash-3")
	if third == first {
		t.Error("policyHash did not change when the policy changed")
	}
}

// startSessionWithPrincipal is startSession (server_test.go) plus a
// manifest C1/C2 principal on the start_session command.
func startSessionWithPrincipal(t *testing.T, conn net.Conn, key, requestID, subject string) {
	t.Helper()
	sendJSON(t, conn, map[string]interface{}{
		"cmd": "start_session",
		"key": key,
		"config": map[string]interface{}{
			"workingDirectory": "/tmp",
		},
		"principal": map[string]interface{}{
			"subject":  subject,
			"provider": "os",
			"kind":     "local",
		},
		"requestId": requestID,
	})
	lines := readLines(t, conn, 8, 2*time.Second)
	r := findResult(t, lines)
	if r == nil {
		t.Fatalf("startSessionWithPrincipal %q: no result received; lines=%v", key, lines)
	}
	if !r.OK {
		t.Fatalf("startSessionWithPrincipal %q: server returned error: %s", key, r.Error)
	}
}

// TestListSessions_FiltersByPrincipalSubjectOverWire drives the real
// dispatch path end to end: two sessions started with different
// principals, a third started with none, and list_sessions filtered by
// principalSubject (with and without includeUnowned) returns exactly the
// expected keys.
func TestListSessions_FiltersByPrincipalSubjectOverWire(t *testing.T) {
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)

	conn := dialServer(t, srv)
	defer conn.Close()

	startSessionWithPrincipal(t, conn, "wire-alice", "req-a", "local:alice")
	startSessionWithPrincipal(t, conn, "wire-bob", "req-b", "local:bob")
	startSession(t, conn, "wire-unowned", "req-u")

	listFiltered := func(subject string, includeUnowned bool) []protocol.SessionInfo {
		sendJSON(t, conn, map[string]interface{}{
			"cmd":              "list_sessions",
			"principalSubject": subject,
			"includeUnowned":   includeUnowned,
			"requestId":        "req-list-" + subject,
		})
		lines := readLines(t, conn, 8, 2*time.Second)
		r := findResult(t, lines)
		if r == nil {
			t.Fatalf("no result frame for list_sessions; lines=%v", lines)
		}
		dataJSON, err := json.Marshal(r.Data)
		if err != nil {
			t.Fatalf("marshal result.Data: %v", err)
		}
		var sessions []protocol.SessionInfo
		if err := json.Unmarshal(dataJSON, &sessions); err != nil {
			t.Fatalf("unmarshal sessions data: %v", err)
		}
		return sessions
	}

	onlyAlice := listFiltered("local:alice", false)
	var aliceKeys []string
	for _, s := range onlyAlice {
		aliceKeys = append(aliceKeys, s.Key)
	}
	if len(aliceKeys) != 1 || aliceKeys[0] != "wire-alice" {
		t.Errorf("filter by local:alice = %v, want [wire-alice]", aliceKeys)
	}

	aliceWithUnowned := listFiltered("local:alice", true)
	var withUnownedKeys []string
	for _, s := range aliceWithUnowned {
		withUnownedKeys = append(withUnownedKeys, s.Key)
	}
	if len(withUnownedKeys) != 2 {
		t.Errorf("filter by local:alice+includeUnowned = %v, want 2 entries (alice + unowned)", withUnownedKeys)
	}
}
