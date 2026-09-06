package backend

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// PermissionHookServer handles Claude CLI PreToolUse hook requests.
// When the ClaudeCodeBackend spawns Claude CLI, Claude CLI can call PreToolUse hooks
// via HTTP. This server handles those requests and routes them through the
// Go permission engine.
// PermissionAskCallback is called when the permission engine returns "ask".
// It should emit a permission_request event so consumers can prompt the user
// and return a channel that resolves with the chosen option ID. The callback
// must also handle cleanup (unregistering) when the response arrives or times out.
type PermissionAskCallback func(token string, questionID string, toolName string, toolDesc string, toolInput map[string]any, options []types.PermissionOpt) chan string

type PermissionHookServer struct {
	listener   net.Listener
	server     *http.Server
	secret     string
	permEngine *permissions.Engine
	mu         sync.Mutex
	tokens     map[string]bool // active run tokens
	onAsk      PermissionAskCallback
	// timeouts carries the human-wait configuration. nil means "use the
	// indefinite-wait default" (the nil-safe accessors on *TimeoutsConfig
	// report an infinite human-wait for a nil receiver). Set via SetTimeouts
	// from the session manager, which holds the engine config.
	timeouts *types.TimeoutsConfig
}

// NewPermissionHookServer creates a hook server on a random local port.
func NewPermissionHookServer(permEng *permissions.Engine) (*PermissionHookServer, error) {
	// Generate app secret
	secretBytes := make([]byte, 16)
	if _, err := rand.Read(secretBytes); err != nil {
		return nil, fmt.Errorf("permission hook server: generate secret: %w", err)
	}
	secret := hex.EncodeToString(secretBytes)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("permission hook server: %w", err)
	}

	s := &PermissionHookServer{
		listener:   listener,
		secret:     secret,
		permEngine: permEng,
		tokens:     make(map[string]bool),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/hook/pre-tool-use/", s.handlePreToolUse)

	s.server = &http.Server{Handler: mux}
	go func() {
		// A Serve error other than the clean-shutdown sentinel means the
		// permission endpoint is dead and every permission check silently
		// fails; log so this is distinguishable from a normal Close.
		if err := s.server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			utils.LogWithFields(utils.LevelError, "backend.permission_hook", "serve exited unexpectedly", map[string]any{"port": s.Port(), "error": err.Error()})
		}
	}()

	utils.LogWithFields(utils.LevelInfo, "backend.permission_hook", "listening on port", map[string]any{
		"port": s.Port(),
	})

	return s, nil
}

// Port returns the listening port, or 0 if the listener is not a TCP listener.
func (s *PermissionHookServer) Port() int {
	if addr, ok := s.listener.Addr().(*net.TCPAddr); ok {
		return addr.Port
	}
	return 0
}

// URL returns the full hook URL for a given token.
func (s *PermissionHookServer) URL(token string) string {
	return fmt.Sprintf("http://127.0.0.1:%d/hook/pre-tool-use/%s/%s", s.Port(), s.secret, token)
}

// RegisterToken creates a token for a new run.
func (s *PermissionHookServer) RegisterToken(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tokens[token] = true
}

// UnregisterToken removes a token when a run completes.
func (s *PermissionHookServer) UnregisterToken(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.tokens, token)
}

// GenerateSettingsJSON creates a settings file content for --settings flag.
//
// # The shape is load-bearing and was wrong
//
// Each entry under "PreToolUse" is a MATCHER GROUP, not a hook. The group names
// which tools it applies to and carries a nested "hooks" array of the commands
// to run:
//
//	"PreToolUse": [ { "matcher": "*", "hooks": [ { "type": "command", ... } ] } ]
//
// This function used to put "type" and "command" directly on the group, with no
// nested array. The CLI read each group, looked for hooks to run, found none,
// and ran nothing — so this server listened on a port that never received a
// single request for the whole time it existed. Nothing failed and nothing was
// logged, because there was no failure: the CLI did exactly what a group with no
// hooks says to do. Every permission decision on a delegated-CLI run was
// therefore never consulted.
//
// The matcher is "*" because this server is the permission rail for the whole
// run, not a rule about one tool. A group scoped to a single tool would silently
// exempt every other tool from policy.
func (s *PermissionHookServer) GenerateSettingsJSON(token string) []byte {
	settings := map[string]interface{}{
		"hooks": map[string]interface{}{
			"PreToolUse": []map[string]interface{}{
				{
					"matcher": "*",
					"hooks": []map[string]interface{}{
						{
							"type":    "command",
							"command": fmt.Sprintf("curl -s -X POST %s -H 'Content-Type: application/json' -d @-", s.URL(token)),
						},
					},
				},
			},
		},
	}
	data, _ := json.MarshalIndent(settings, "", "  ") //nolint:errcheck // marshal of a fixed local struct cannot fail
	return data
}

// SetOnAsk registers a callback for permission requests that need user approval.
func (s *PermissionHookServer) SetOnAsk(fn PermissionAskCallback) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onAsk = fn
}

// SetTimeouts installs the human-wait configuration. nil (or an unset
// ElicitationMs) means wait indefinitely for the user's permission decision —
// the shipped default. A finite human-wait makes the dialog resolve to the
// configured fail-action (PermissionTimeoutAction, default "deny") on expiry.
func (s *PermissionHookServer) SetTimeouts(t *types.TimeoutsConfig) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.timeouts = t
}

// Close shuts down the hook server.
func (s *PermissionHookServer) Close() {
	s.server.Close() //nolint:errcheck // server shutdown
}

func (s *PermissionHookServer) handlePreToolUse(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Parse path: /hook/pre-tool-use/{secret}/{token}
	pathParts := strings.Split(strings.TrimPrefix(r.URL.Path, "/hook/pre-tool-use/"), "/")
	if len(pathParts) != 2 {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return
	}

	reqSecret := pathParts[0]
	reqToken := pathParts[1]

	// Validate secret
	if reqSecret != s.secret {
		utils.LogWithFields(utils.LevelInfo, "backend.permission_hook", "rejected: secret mismatch", map[string]any{"path": r.URL.Path})
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	// Validate token
	s.mu.Lock()
	validToken := s.tokens[reqToken]
	s.mu.Unlock()

	if !validToken {
		utils.LogWithFields(utils.LevelInfo, "backend.permission_hook", "rejected: unknown token", map[string]any{})
		http.Error(w, "unknown token", http.StatusForbidden)
		return
	}

	var req struct {
		ToolName string         `json:"tool_name"`
		Input    map[string]any `json:"tool_input"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.LogWithFields(utils.LevelInfo, "backend.permission_hook", "rejected: body decode failed", map[string]any{"error": err.Error()})
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	// Entry log. Every inbound hook request is recorded before any decision is
	// taken, so the log answers "did the CLI call this hook at all" — a question
	// the previous rejection-only logging could not answer, because every allow
	// path returned silently and an absent log was indistinguishable from a
	// subprocess that never invoked the hook.
	utils.LogWithFields(utils.LevelDebug, "backend.permission_hook", "pre-tool-use request received", map[string]any{
		"tool":       req.ToolName,
		"token":      reqToken,
		"input_keys": len(req.Input),
	})

	// Async-mode gate, ahead of policy. This is a capability refusal, not a
	// permission decision: the mode cannot work on this backend regardless of
	// what any rule says, and the reason names the engine tool that can do the
	// job. See cli_async_gate.go.
	if reason, denied := asyncModeDenial(req.ToolName, req.Input); denied {
		s.respond(w, req.ToolName, "deny", "async mode unavailable on this backend", reason)
		return
	}

	// Engine-bridged tools are policy-checked where they execute, in their own
	// MCP handler (session/prompt_cli_shell_tools.go). Evaluating them here as
	// well would put one call through two rails: on an "ask" policy the operator
	// is prompted twice for a single command, and the audit trail records one
	// decision twice.
	//
	// The handler owns the decision rather than this hook because it is the rail
	// that still exists when this server does not — a failed settings-file write
	// leaves the permission engine live and this hook absent. Short-circuiting
	// AFTER the async gate above is deliberate: the gate is a capability refusal
	// about the CLI's own tools and must keep running for every name.
	if strings.HasPrefix(req.ToolName, permissions.EngineMcpToolPrefix) {
		s.respond(w, req.ToolName, "allow", "engine-bridged tool: policy applied at its own handler", "")
		return
	}

	// Check safe commands for Bash
	if permissions.IsBashToolName(req.ToolName) {
		if cmd, ok := req.Input["command"].(string); ok {
			if permissions.IsSafeBashCommand(cmd) {
				s.respond(w, req.ToolName, "allow", "safe-command allowlist", "")
				return
			}
		}
	}

	// Route through permission engine
	if s.permEngine != nil {
		result := s.permEngine.Check(permissions.CheckInfo{
			Tool:  req.ToolName,
			Input: req.Input,
		})
		if result.Decision != "ask" {
			s.respond(w, req.ToolName, result.Decision, "permission engine rule", result.Reason)
			return
		}
	}

	// Decision is "ask" (or no permission engine) -- forward to the consumer
	// callback so the user can be prompted.
	s.mu.Lock()
	askFn := s.onAsk
	s.mu.Unlock()

	if askFn == nil {
		// No callback registered -- default allow
		s.respond(w, req.ToolName, "allow", "no ask callback registered", "")
		return
	}

	// Generate question ID
	qidBytes := make([]byte, 8)
	rand.Read(qidBytes)
	questionID := hex.EncodeToString(qidBytes)

	// Default permission options
	options := []types.PermissionOpt{
		{ID: "allow", Label: "Allow"},
		{ID: "deny", Label: "Deny"},
		{ID: "allow_always", Label: "Allow always"},
	}

	ch := askFn(reqToken, questionID, req.ToolName, "", req.Input, options)
	if ch == nil {
		s.respond(w, req.ToolName, "allow", "ask callback declined to prompt", "")
		return
	}

	// Resolve the human-wait timeout for this permission dialog. Default is
	// indefinite: a permission prompt waits for the user to decide and must
	// not silently fail closed on a wall-clock deadline when the human simply
	// stepped away. A configured finite human-wait installs a timer whose
	// expiry applies the configured fail-action (default "deny").
	s.mu.Lock()
	timeouts := s.timeouts
	s.mu.Unlock()
	var timerCh <-chan time.Time
	if d, finite := timeouts.HumanWait(); finite {
		timer := time.NewTimer(d)
		defer timer.Stop()
		timerCh = timer.C
		utils.LogWithFields(utils.LevelInfo, "backend.permission_hook", "finite human-wait for (fail-)", map[string]any{
			"d":           d,
			"question_id": questionID,
			"action":      timeouts.PermissionTimeoutAction(),
		})
	} else {
		utils.LogWithFields(utils.LevelInfo, "backend.permission_hook", "indefinite human-wait for (waiting for user decision)", map[string]any{
			"question_id": questionID,
		})
	}

	// Block until response, request-context cancellation, or (only when a
	// finite human-wait is configured) the timeout. r.Context() fires when
	// the Claude CLI subprocess that issued this hook request goes away, so
	// an indefinite wait can never truly wedge: if the run is cancelled the
	// subprocess dies and this handler unblocks.
	select {
	case optionID := <-ch:
		// Map option IDs to hook decisions. A deny carries its reason to the
		// model: a bare refusal says nothing about whether retrying could ever
		// work, so the model retries it.
		decision, reason := "allow", ""
		switch optionID {
		case "deny":
			decision, reason = "deny", "The operator declined this call. Do not retry it; ask what to do instead."
		case "allow", "allow_always":
			decision = "allow"
		}
		s.respond(w, req.ToolName, decision, "user decision", reason)
	case <-r.Context().Done():
		// Subprocess/connection gone — the run is being torn down. Do not
		// write a decision; there is no longer anyone to receive it.
		utils.LogWithFields(utils.LevelInfo, "backend.permission_hook", "permission request abandoned (request context cancelled)", map[string]any{
			"question_id": questionID,
		})
	case <-timerCh:
		decision := timeouts.PermissionTimeoutAction()
		utils.LogWithFields(utils.LevelInfo, "backend.permission_hook", "permission request timed out, applying fail", map[string]any{
			"action":      decision,
			"question_id": questionID,
		})
		reason := ""
		if decision == "deny" {
			reason = "The approval request timed out with no operator response. Do not retry it immediately; say that the call needs approval."
		}
		s.respond(w, req.ToolName, decision, "human-wait timeout fail-action", reason)
	}
}

// respond logs the decision and the rail that produced it, then writes the
// response. Every terminating branch of handlePreToolUse goes through here, so
// the log carries one line per inbound request and one per outcome — the pairing
// that makes a hook invocation reconstructible from the log alone.
//
// layer names the internal rail ("safe-command allowlist", "permission engine
// rule", "user decision", ...) and is for the operator. reason is the
// model-facing text and travels to the CLI on the wire; it is empty for the
// paths that have nothing useful to tell the model.
func (s *PermissionHookServer) respond(w http.ResponseWriter, tool, decision, layer, reason string) {
	utils.LogWithFields(utils.LevelInfo, "backend.permission_hook", "pre-tool-use decision", map[string]any{
		"tool":     tool,
		"decision": decision,
		"layer":    layer,
		"reason":   reason,
	})
	writePermissionResponse(w, decision, reason)
}

// writePermissionResponse encodes the CLI's PreToolUse hook response.
//
// permissionDecisionReason is what the CLI surfaces to the model on a deny. A
// bare refusal with no reason just gets retried, so a deny that knows why it
// denied says so. It is omitted entirely when empty rather than sent as "".
func writePermissionResponse(w http.ResponseWriter, decision, reason string) {
	hookOutput := map[string]interface{}{
		// hookEventName is REQUIRED, not decoration. The CLI matches the
		// hookSpecificOutput block against the event it fired for; a block
		// without it is discarded and the tool runs as if no hook had answered.
		// Verified against claude 2.1.259: an identical deny is honored with this
		// field and silently ignored without it — the command executes and the
		// model is told it succeeded.
		"hookEventName":      "PreToolUse",
		"permissionDecision": decision,
	}
	if reason != "" {
		hookOutput["permissionDecisionReason"] = reason
	}
	resp := map[string]interface{}{
		"hookSpecificOutput": hookOutput,
	}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		// This is the sole channel carrying the allow/deny decision back to the
		// CLI. A failed write stalls the CLI on the tool with no explanation.
		utils.LogWithFields(utils.LevelInfo, "backend.permission_hook", "permission response write failed", map[string]any{"decision": decision, "error": err.Error()})
	}
}
