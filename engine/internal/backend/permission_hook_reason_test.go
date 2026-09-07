package backend

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/types"
)

// postPermissionRaw issues a PreToolUse hook request for an arbitrary tool and
// input, returning the full decoded hookSpecificOutput. The existing
// postPermission helper hardcodes a Bash payload and drops every field but the
// decision, which is exactly what these tests need to see.
func postPermissionRaw(t *testing.T, s *PermissionHookServer, token, tool string, input map[string]any) (decision, reason string) {
	t.Helper()
	body, err := json.Marshal(map[string]any{"tool_name": tool, "tool_input": input})
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	resp, err := http.Post(s.URL(token), "application/json", bytes.NewReader(body)) //nolint:noctx // local test server, no cancellation needed
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	var decoded struct {
		HookSpecificOutput struct {
			HookEventName            string `json:"hookEventName"`
			PermissionDecision       string `json:"permissionDecision"`
			PermissionDecisionReason string `json:"permissionDecisionReason"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal %q: %v", string(raw), err)
	}
	// Asserted on every response rather than in one test: the CLI discards a
	// hookSpecificOutput block whose event name is missing, and it does so
	// silently — the tool runs and the model is told it succeeded. A decision
	// without this field is a decision that never happened.
	if got := decoded.HookSpecificOutput.HookEventName; got != "PreToolUse" {
		t.Fatalf("hookEventName = %q, want PreToolUse — the CLI discards the block without it", got)
	}
	return decoded.HookSpecificOutput.PermissionDecision, decoded.HookSpecificOutput.PermissionDecisionReason
}

// TestPermissionResponse_DenyCarriesReason pins that a policy deny reaches the
// CLI with the reason that produced it. Before this change the response carried
// only permissionDecision, so the model saw a bare refusal with nothing to act
// on and retried the same call. Revert-check: dropping
// permissionDecisionReason from writePermissionResponse leaves reason empty and
// fails here.
func TestPermissionResponse_DenyCarriesReason(t *testing.T) {
	engine := permissions.NewEngine(&types.PermissionPolicy{Mode: "deny"})
	s, err := NewPermissionHookServer(engine)
	if err != nil {
		t.Fatalf("new server: %v", err)
	}
	t.Cleanup(s.Close)
	token := "tok-deny-reason"
	s.RegisterToken(token)

	decision, reason := postPermissionRaw(t, s, token, "Bash", map[string]any{"command": "rm -rf /"})
	if decision != "deny" {
		t.Fatalf("decision = %q, want deny", decision)
	}
	if reason == "" {
		t.Fatal("permissionDecisionReason is empty; a deny must tell the model why")
	}
}

// TestPermissionResponse_AllowOmitsEmptyReason pins that a decision with no
// reason to give does not ship an empty string. The safe-command allowlist has
// nothing to tell the model, and "permissionDecisionReason": "" is noise on the
// wire the CLI would have to interpret.
func TestPermissionResponse_AllowOmitsEmptyReason(t *testing.T) {
	s, token, _ := newTestPermissionServer(t)

	decision, reason := postPermissionRaw(t, s, token, "Bash", map[string]any{"command": "git status"})
	if decision != "allow" {
		t.Fatalf("decision = %q, want allow (safe-command allowlist)", decision)
	}
	if reason != "" {
		t.Fatalf("reason = %q, want empty for an allowlist allow", reason)
	}
}

// TestPermissionHook_BridgedNameIsLeftToItsOwnHandler pins the single-rail
// rule. An engine-bridged tool is policy-checked where it executes, in its MCP
// handler (session/prompt_cli_shell_tools.go); this hook must not evaluate it a
// second time. Two rails on one call means an "ask" policy prompts the operator
// twice for a single command and the audit trail records one decision twice.
//
// The assertion is that the request returns "allow" WITHOUT touching the ask
// path: the ask channel is left unloaded, so a hook that fell through to policy
// would block instead of answering.
func TestPermissionHook_BridgedNameIsLeftToItsOwnHandler(t *testing.T) {
	s, token, _ := newTestPermissionServer(t)

	// A command the safe-command allowlist would NOT wave through, so a pass
	// here can only come from the bridge short-circuit.
	decision, _ := postPermissionRaw(t, s, token, permissions.EngineMcpToolPrefix+"Bash", map[string]any{
		"command": "rm -rf /tmp/scratch",
	})
	if decision != "allow" {
		t.Fatalf("decision = %q, want allow: a bridged tool is decided at its own handler, not here", decision)
	}
}

// TestPermissionHook_AsyncGateRunsBeforeTheBridgeShortCircuit pins the ordering
// the short-circuit above must not break. The async gate is a capability
// refusal about the CLI's own tools and has to see every name; if the bridge
// check ran first it would still be irrelevant here (this is a native name),
// but if the gate were moved below the policy rails a background Bash would be
// waved through by the safe-command allowlist instead of refused.
//
// Revert-check: delete the asyncModeDenial call from handlePreToolUse and this
// goes red while every test in cli_async_gate_test.go stays green — those call
// the predicate directly and cannot see the wiring.
func TestPermissionHook_AsyncGateRunsBeforeTheBridgeShortCircuit(t *testing.T) {
	s, token, _ := newTestPermissionServer(t)

	decision, reason := postPermissionRaw(t, s, token, "Bash", map[string]any{
		"command":           "echo hi",
		"run_in_background": true,
	})
	if decision != "deny" {
		t.Fatalf("decision = %q, want deny: native background Bash cannot deliver its completion", decision)
	}
	if want := permissions.EngineMcpToolPrefix + "Bash"; !strings.Contains(reason, want) {
		t.Errorf("deny reason does not name the replacement %q: %q", want, reason)
	}
}

// TestPermissionHook_ForegroundBashStillReachesPolicy is the other arm. A gate
// that denied everything would satisfy the test above; this pins that ordinary
// foreground work is untouched and still decided by the policy rails.
func TestPermissionHook_ForegroundBashStillReachesPolicy(t *testing.T) {
	s, token, _ := newTestPermissionServer(t)

	decision, _ := postPermissionRaw(t, s, token, "Bash", map[string]any{"command": "git status"})
	if decision != "allow" {
		t.Fatalf("decision = %q, want allow: foreground Bash is not what the async gate refuses", decision)
	}
}

// TestEngineMcpToolPrefix_MatchesServerName pins the two constants that must
// agree but cannot see each other: permissions.EngineMcpToolPrefix (used to
// unwrap bridged names on the policy rails) and backend.McpServerName (used to
// build them). permissions sits below backend in the import graph, so the
// equality is asserted here rather than enforced by the type system. Renaming
// the MCP server without updating the prefix would silently stop every bridged
// tool name from normalizing.
func TestEngineMcpToolPrefix_MatchesServerName(t *testing.T) {
	want := "mcp__" + McpServerName + "__"
	if permissions.EngineMcpToolPrefix != want {
		t.Fatalf("permissions.EngineMcpToolPrefix = %q, want %q (derived from backend.McpServerName)", permissions.EngineMcpToolPrefix, want)
	}
}

// TestMcpBridgeParityFixture pins the bridge prefix across the language
// boundary. Go asserts its own two constants agree in the test above; this one
// publishes the agreed value to the shared fixture the desktop reads
// (assets/mcp-bridge-parity.json), so a rename of McpServerName cannot leave a
// client matching a name the engine no longer sends.
//
// The desktop's bench gate is the concrete stake: it refuses writes into an
// integration bench by tool name, and a bridged call it fails to recognise
// walks straight past the guard with nothing logged. That is the exact bypass
// commit "match the engine's bridged Bash name in the bench gate" closed; a
// hand-copied prefix would reopen it silently on the next rename.
//
// Revert-check: change McpServerName and this goes red, naming the fixture to
// update — instead of the desktop test staying green while its literal rots.
func TestMcpBridgeParityFixture(t *testing.T) {
	path := filepath.Join("..", "..", "..", "assets", "mcp-bridge-parity.json")
	raw, err := os.ReadFile(path) //nolint:gosec // fixed repo-relative test fixture
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var fixture struct {
		McpServerName       string `json:"mcpServerName"`
		EngineMcpToolPrefix string `json:"engineMcpToolPrefix"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("unmarshal %s: %v", path, err)
	}
	if fixture.McpServerName != McpServerName {
		t.Errorf("fixture mcpServerName = %q, want %q — update %s", fixture.McpServerName, McpServerName, path)
	}
	if fixture.EngineMcpToolPrefix != permissions.EngineMcpToolPrefix {
		t.Errorf("fixture engineMcpToolPrefix = %q, want %q — update %s", fixture.EngineMcpToolPrefix, permissions.EngineMcpToolPrefix, path)
	}
}
