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
func (s *PermissionHookServer) GenerateSettingsJSON(token string) []byte {
	settings := map[string]interface{}{
		"hooks": map[string]interface{}{
			"PreToolUse": []map[string]interface{}{
				{
					"type":    "command",
					"command": fmt.Sprintf("curl -s -X POST %s -H 'Content-Type: application/json' -d @-", s.URL(token)),
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

	// Check safe commands for Bash
	if req.ToolName == "Bash" || req.ToolName == "bash" {
		if cmd, ok := req.Input["command"].(string); ok {
			if permissions.IsSafeBashCommand(cmd) {
				writePermissionResponse(w, "allow")
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
			writePermissionResponse(w, result.Decision)
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
		writePermissionResponse(w, "allow")
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
		writePermissionResponse(w, "allow")
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
		// Map option IDs to hook decisions
		decision := "allow"
		switch optionID {
		case "deny":
			decision = "deny"
		case "allow", "allow_always":
			decision = "allow"
		}
		writePermissionResponse(w, decision)
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
		writePermissionResponse(w, decision)
	}
}

func writePermissionResponse(w http.ResponseWriter, decision string) {
	resp := map[string]interface{}{
		"hookSpecificOutput": map[string]interface{}{
			"permissionDecision": decision,
		},
	}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		// This is the sole channel carrying the allow/deny decision back to the
		// CLI. A failed write stalls the CLI on the tool with no explanation.
		utils.LogWithFields(utils.LevelInfo, "backend.permission_hook", "permission response write failed", map[string]any{"decision": decision, "error": err.Error()})
	}
}
