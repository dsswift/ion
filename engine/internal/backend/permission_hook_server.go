package backend

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"

	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/utils"
)

// PermissionHookServer handles Claude CLI PreToolUse hook requests.
// When the CliBackend spawns Claude CLI, Claude CLI can call PreToolUse hooks
// via HTTP. This server handles those requests and routes them through the
// Go permission engine.
type PermissionHookServer struct {
	listener   net.Listener
	server     *http.Server
	secret     string
	permEngine *permissions.Engine
	mu         sync.Mutex
	tokens     map[string]bool // active run tokens
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
	go s.server.Serve(listener)

	utils.Log("PermissionHookServer", fmt.Sprintf("listening on port %d", s.Port()))

	return s, nil
}

// Port returns the listening port.
func (s *PermissionHookServer) Port() int {
	return s.listener.Addr().(*net.TCPAddr).Port
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
	data, _ := json.MarshalIndent(settings, "", "  ")
	return data
}

// Close shuts down the hook server.
func (s *PermissionHookServer) Close() {
	s.server.Close()
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
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	// Validate token
	s.mu.Lock()
	validToken := s.tokens[reqToken]
	s.mu.Unlock()

	if !validToken {
		http.Error(w, "unknown token", http.StatusForbidden)
		return
	}

	var req struct {
		ToolName string         `json:"tool_name"`
		Input    map[string]any `json:"tool_input"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
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
		writePermissionResponse(w, result.Decision)
		return
	}

	// Default: allow
	writePermissionResponse(w, "allow")
}

func writePermissionResponse(w http.ResponseWriter, decision string) {
	resp := map[string]interface{}{
		"hookSpecificOutput": map[string]interface{}{
			"permissionDecision": decision,
		},
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}
