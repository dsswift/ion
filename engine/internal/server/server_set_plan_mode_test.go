package server

import (
	"reflect"
	"testing"
	"time"
)

// End-to-end wire-dispatch tests for the tri-valued semantics of
// `set_plan_mode.planModeAllowedBashCommands`. Goes through the full
// JSON-decode → dispatch → manager-state path so the guard
// (server.go:441 — `cmd.PlanModeAllowedBashCommands != nil`) is
// exercised against actual wire input rather than mocked struct values.
//
// Each test:
//   1. Starts a session.
//   2. Seeds an initial allowlist via a preliminary set_plan_mode call
//      (when needed to verify "no change" / "clear" branches).
//   3. Sends the tri-valued case under test.
//   4. Inspects the resulting session state via
//      Manager.TestGetPlanModeBashAllowlist (see session/testing_helpers.go).

func assertAllowlist(t *testing.T, srv *Server, key string, want []string) {
	t.Helper()
	got, ok := srv.SessionManager().TestGetPlanModeBashAllowlist(key)
	if !ok {
		t.Fatalf("session %q not found", key)
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("allowlist for %q: got %#v, want %#v", key, got, want)
	}
}

func TestSetPlanMode_TriValued_NilLeavesAllowlistUnchanged(t *testing.T) {
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)

	conn := dialServer(t, srv)
	defer conn.Close()

	const key = "tri-nil"
	startSession(t, conn, key, "req-start")

	// Seed an existing allowlist.
	sendJSON(t, conn, map[string]interface{}{
		"cmd":                         "set_plan_mode",
		"key":                         key,
		"enabled":                     true,
		"planModeAllowedBashCommands": []string{"gh", "git diff"},
		"requestId":                   "req-seed",
	})
	_ = readLines(t, conn, 3, 1*time.Second)

	// Now send a set_plan_mode WITHOUT the bash field. Expectation:
	// server-dispatch guard skips SetPlanModeBashAllowlist; allowlist
	// is preserved.
	sendJSON(t, conn, map[string]interface{}{
		"cmd":       "set_plan_mode",
		"key":       key,
		"enabled":   true,
		"requestId": "req-omit",
	})
	_ = readLines(t, conn, 3, 1*time.Second)

	assertAllowlist(t, srv, key, []string{"gh", "git diff"})
}

func TestSetPlanMode_TriValued_ExplicitEmptyClears(t *testing.T) {
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)

	conn := dialServer(t, srv)
	defer conn.Close()

	const key = "tri-clear"
	startSession(t, conn, key, "req-start")

	// Seed an existing allowlist.
	sendJSON(t, conn, map[string]interface{}{
		"cmd":                         "set_plan_mode",
		"key":                         key,
		"enabled":                     true,
		"planModeAllowedBashCommands": []string{"gh"},
		"requestId":                   "req-seed",
	})
	_ = readLines(t, conn, 3, 1*time.Second)

	// Now send an explicit empty slice. Expectation: allowlist cleared
	// to []. The JSON `[]` decodes to a non-nil empty Go slice; the
	// server guard passes it through to SetPlanModeBashAllowlist; the
	// session's allowlist is replaced with an empty slice.
	sendJSON(t, conn, map[string]interface{}{
		"cmd":                         "set_plan_mode",
		"key":                         key,
		"enabled":                     true,
		"planModeAllowedBashCommands": []string{},
		"requestId":                   "req-clear",
	})
	_ = readLines(t, conn, 3, 1*time.Second)

	assertAllowlist(t, srv, key, []string{})
}

func TestSetPlanMode_TriValued_NonEmptyReplaces(t *testing.T) {
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)

	conn := dialServer(t, srv)
	defer conn.Close()

	const key = "tri-replace"
	startSession(t, conn, key, "req-start")

	sendJSON(t, conn, map[string]interface{}{
		"cmd":                         "set_plan_mode",
		"key":                         key,
		"enabled":                     true,
		"planModeAllowedBashCommands": []string{"gh", "git log"},
		"requestId":                   "req-replace",
	})
	_ = readLines(t, conn, 3, 1*time.Second)

	assertAllowlist(t, srv, key, []string{"gh", "git log"})
}
