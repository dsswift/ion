package server

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/session"
	"github.com/dsswift/ion/engine/internal/titling"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// DefaultSocketPath returns the platform-appropriate default socket/listen address.
// On Unix: ~/.ion/engine.sock (Unix domain socket)
// On Windows: 127.0.0.1:21017 (TCP loopback, since Go doesn't natively support named pipes)
func DefaultSocketPath() string {
	if runtime.GOOS == "windows" {
		return "127.0.0.1:21017"
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".ion", "engine.sock")
}

// broadcastWriteDeadline is how long a single per-client write may take before
// the drainer treats the connection as dead and evicts it. Configurable via
// TimeoutsConfig.BroadcastWrite().
var broadcastWriteDeadline = 5 * time.Second

// Server listens on a Unix domain socket (or TCP on Windows), accepts NDJSON
// commands from clients, and broadcasts session events back to all connected clients.
type Server struct {
	socketPath         string
	listener           net.Listener
	clients            map[net.Conn]*clientWriter
	mu                 sync.RWMutex
	manager            *session.Manager
	config             *types.EngineRuntimeConfig
	broadcastListeners []*listenerHandle
	done               chan struct{}
	stopOnce           sync.Once
	version            string
	startedAt          time.Time
}

// SetConfig stores the engine runtime config for use by sessions.
func (s *Server) SetConfig(cfg *types.EngineRuntimeConfig) {
	s.config = cfg
	s.manager.SetConfig(cfg)
	if cfg != nil && cfg.Timeouts != nil {
		broadcastWriteDeadline = cfg.Timeouts.BroadcastWrite()
	}
}

// SetVersion stores the engine binary version for the health command.
func (s *Server) SetVersion(v string) {
	s.version = v
}

// NewServer creates a Server backed by the given RunBackend.
// The session Manager is created internally and wired to the backend.
func NewServer(socketPath string, b backend.RunBackend) *Server {
	mgr := session.NewManager(b)

	s := &Server{
		socketPath: socketPath,
		clients:    make(map[net.Conn]*clientWriter),
		manager:    mgr,
		done:       make(chan struct{}),
		startedAt:  time.Now(),
	}

	// Wire manager events to broadcast
	mgr.OnEvent(func(key string, event types.EngineEvent) {
		raw, err := json.Marshal(event)
		if err != nil {
			utils.Log("Server", "failed to marshal event: "+err.Error())
			return
		}
		line := protocol.SerializeServerEvent(key, json.RawMessage(raw))
		s.broadcast(line, event.Type)
	})

	return s
}

// looksLikeHostPort returns true when path looks like "host:port" rather
// than a Unix domain socket path. Used to enable TCP listen/dial on any
// platform via ION_SOCKET_PATH=host:port.
func looksLikeHostPort(path string) bool {
	// Must contain a colon and must not start with "/" (absolute path)
	// or "." (relative path).
	if len(path) == 0 || path[0] == '/' || path[0] == '.' {
		return false
	}
	return strings.Contains(path, ":")
}

// Start begins listening on the socket. When the socket path looks like
// "host:port" (set via ION_SOCKET_PATH), uses TCP so the engine can serve
// LAN clients. Otherwise uses a Unix domain socket with stale socket detection.
// TCP always binds to tcp4 to avoid macOS dual-stack quirks where Go's
// default "tcp" might bind only to [::1].
func (s *Server) Start() error {
	var ln net.Listener
	var err error

	if looksLikeHostPort(s.socketPath) {
		// TCP mode — cross-platform (LAN / Windows / remote desktop).
		conn, dialErr := net.Dial("tcp4", s.socketPath)
		if dialErr == nil {
			conn.Close()
			return fmt.Errorf("engine already listening on %s", s.socketPath)
		}
		ln, err = net.Listen("tcp4", s.socketPath)
		if err != nil {
			return fmt.Errorf("failed to listen on %s: %w", s.socketPath, err)
		}
	} else {
		// Unix domain socket mode.
		if _, statErr := os.Stat(s.socketPath); statErr == nil {
			conn, dialErr := net.Dial("unix", s.socketPath)
			if dialErr != nil {
				utils.Log("Server", "removing stale socket: "+s.socketPath)
				os.Remove(s.socketPath)
			} else {
				conn.Close()
				return fmt.Errorf("socket already in use: %s", s.socketPath)
			}
		}
		ln, err = net.Listen("unix", s.socketPath)
		if err != nil {
			return fmt.Errorf("failed to listen on %s: %w", s.socketPath, err)
		}
	}

	s.listener = ln
	utils.Log("Server", "listening on "+s.socketPath)

	go s.acceptLoop()
	return nil
}

// Stop gracefully shuts down the server: stops all sessions, closes all
// client connections, closes the listener, and removes the socket file.
// Safe to call multiple times (e.g. from both shutdown command and OS signal).
func (s *Server) Stop() error {
	s.stopOnce.Do(func() {
		close(s.done)

		_ = s.manager.StopAll()

		s.mu.Lock()
		for conn, cw := range s.clients {
			close(cw.done)
			conn.Close()
		}
		s.clients = make(map[net.Conn]*clientWriter)
		for _, lh := range s.broadcastListeners {
			close(lh.done)
		}
		s.broadcastListeners = nil
		s.mu.Unlock()

		if s.listener != nil {
			s.listener.Close()
		}

		// Only remove socket file for Unix domain sockets; TCP listeners
		// have no file to clean up.
		if !looksLikeHostPort(s.socketPath) {
			os.Remove(s.socketPath)
		}
		utils.Log("Server", "stopped")
	})
	return nil
}

// Done returns a channel that is closed when the server is stopped.
// Allows callers (e.g. main) to unblock on a shutdown IPC command
// in addition to OS signals.
func (s *Server) Done() <-chan struct{} {
	return s.done
}

// SocketPath returns the path to the Unix domain socket.
func (s *Server) SocketPath() string {
	return s.socketPath
}

// SessionManager returns the underlying session manager.
func (s *Server) SessionManager() *session.Manager {
	return s.manager
}

// DispatchCommand processes a parsed ClientCommand without a socket connection.
// Used by relay transport to inject commands from mobile peers. Results and
// errors are broadcast to all listeners (including the relay itself).
func (s *Server) DispatchCommand(cmd *protocol.ClientCommand) {
	s.dispatch(nil, cmd)
}

func (s *Server) acceptLoop() {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			select {
			case <-s.done:
				return
			default:
				utils.Log("Server", "accept error: "+err.Error())
				continue
			}
		}

		cw := &clientWriter{
			conn:        conn,
			stateQueue:  make(chan []byte, stateQueueSize),
			streamQueue: make(chan []byte, streamQueueSize),
			done:        make(chan struct{}),
		}
		s.mu.Lock()
		s.clients[conn] = cw
		s.mu.Unlock()

		go s.drainClient(cw)
		go s.handleClient(conn)
	}
}

// evictClient removes a client from the broadcast set and closes its conn.
// Safe to call multiple times.
func (s *Server) evictClient(conn net.Conn) {
	s.mu.Lock()
	cw, ok := s.clients[conn]
	if ok {
		delete(s.clients, conn)
	}
	s.mu.Unlock()
	if ok {
		select {
		case <-cw.done:
		default:
			close(cw.done)
		}
		conn.Close()
	}
}

func (s *Server) handleClient(conn net.Conn) {
	defer s.evictClient(conn)
	defer func() {
		if r := recover(); r != nil {
			buf := make([]byte, 4096)
			n := runtime.Stack(buf, false)
			utils.Error("Server", fmt.Sprintf("panic in handleClient: %v\n%s", r, buf[:n]))
		}
	}()

	scanner := bufio.NewScanner(conn)
	// 8 MB per NDJSON line. Generous enough for an image-bearing prompt
	// (Anthropic caps inputs at ~5 MB raw per image; base64 inflates by
	// 4/3, so ~7 MB worst case + envelope) without inviting clients to
	// spray multi-megabyte payloads. Old cap of 1 MB caused mid-stream
	// EPIPE on the client write whenever an image attachment landed on
	// the wire.
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		cmd := protocol.ParseClientCommand(line)
		if cmd == nil {
			// Extract requestId from raw JSON so the client can match the error
			reqID := protocol.ExtractRequestID(line)
			result := protocol.SerializeServerResult(protocol.ServerResult{
				RequestID: reqID,
				OK:        false,
				Error:     "invalid command",
			})
			s.writeToClient(conn, result)
			continue
		}

		s.dispatch(conn, cmd)
	}
}

func (s *Server) dispatch(conn net.Conn, cmd *protocol.ClientCommand) {
	defer func() {
		if r := recover(); r != nil {
			buf := make([]byte, 4096)
			n := runtime.Stack(buf, false)
			utils.Error("Server", fmt.Sprintf("panic in dispatch cmd=%s key=%s: %v\n%s", cmd.Cmd, cmd.Key, r, buf[:n]))
			s.sendResult(conn, cmd, fmt.Errorf("internal error"), nil)
		}
	}()

	utils.Debug("Server", fmt.Sprintf("dispatch: cmd=%s key=%s requestID=%s", cmd.Cmd, cmd.Key, cmd.RequestID))
	switch cmd.Cmd {
	case "start_session":
		result, err := s.manager.StartSession(cmd.Key, *cmd.Config)
		s.sendResult(conn, cmd, err, result)

	case "send_prompt":
		var overrides *session.PromptOverrides
		resolvedExts := cmd.ResolveExtensions()
		if cmd.Model != "" || cmd.MaxTurns > 0 || cmd.MaxBudgetUsd > 0 || len(resolvedExts) > 0 || cmd.NoExtensions || cmd.AppendSystemPrompt != "" || len(cmd.Attachments) > 0 {
			overrides = &session.PromptOverrides{
				Model:              cmd.Model,
				MaxTurns:           cmd.MaxTurns,
				MaxBudgetUsd:       cmd.MaxBudgetUsd,
				Extensions:         resolvedExts,
				NoExtensions:       cmd.NoExtensions,
				AppendSystemPrompt: cmd.AppendSystemPrompt,
				Attachments:        cmd.Attachments,
			}
		}
		err := s.manager.SendPrompt(cmd.Key, cmd.Text, overrides)
		s.sendResult(conn, cmd, err, nil)

	case "abort":
		// Fire-and-forget: no response sent (matches TS behavior).
		utils.Info("Server", fmt.Sprintf("abort: key=%s", cmd.Key))
		s.manager.SendAbort(cmd.Key)

	case "abort_agent":
		// Fire-and-forget: no response sent (matches TS behavior).
		subtree := cmd.Subtree != nil && *cmd.Subtree
		utils.Info("Server", fmt.Sprintf("abort_agent: key=%s agent=%s subtree=%v", cmd.Key, cmd.AgentName, subtree))
		s.manager.AbortAgent(cmd.Key, cmd.AgentName, subtree)

	case "steer_agent":
		// Fire-and-forget: no response sent (matches TS behavior).
		s.manager.SteerAgent(cmd.Key, cmd.AgentName, cmd.Message)

	case "dialog_response":
		// Fire-and-forget: no response sent (matches TS behavior).
		s.manager.SendDialogResponse(cmd.Key, cmd.DialogID, cmd.Value)

	case "command":
		// Fire-and-forget: no response sent (matches TS behavior).
		s.manager.SendCommand(cmd.Key, cmd.Command, cmd.Args)

	case "stop_session":
		err := s.manager.StopSession(cmd.Key)
		s.sendResult(conn, cmd, err, nil)

	case "stop_by_prefix":
		s.manager.StopByPrefix(cmd.Prefix)
		s.sendResult(conn, cmd, nil, nil)

	case "list_sessions":
		sessions := s.manager.ListSessions()
		infos := make([]protocol.SessionInfo, len(sessions))
		for i, si := range sessions {
			infos[i] = protocol.SessionInfo{
				Key:            si.Key,
				HasActiveRun:   si.HasActiveRun,
				ToolCount:      si.ToolCount,
				ConversationID: si.ConversationID,
			}
		}
		if cmd.RequestID != "" {
			// Return as result with requestId (TS parity).
			s.sendResult(conn, cmd, nil, infos)
		} else {
			line := protocol.SerializeServerSessionList(infos)
			s.writeToClient(conn, line)
		}

	case "fork_session":
		idx := 0
		if cmd.MessageIndex != nil {
			idx = *cmd.MessageIndex
		}
		newKey, err := s.manager.ForkSession(cmd.Key, idx)
		s.sendForkResult(conn, cmd, err, newKey)

	case "set_plan_mode":
		enabled := cmd.Enabled != nil && *cmd.Enabled
		s.manager.SetPlanMode(cmd.Key, enabled, cmd.AllowedTools, cmd.Source)
		s.sendResult(conn, cmd, nil, nil)

	case "branch":
		err := s.manager.BranchSession(cmd.Key, cmd.EntryID)
		s.sendResult(conn, cmd, err, nil)

	case "navigate_tree":
		err := s.manager.NavigateSession(cmd.Key, cmd.TargetID)
		s.sendResult(conn, cmd, err, nil)

	case "get_tree":
		tree := s.manager.GetSessionTree(cmd.Key)
		s.sendResult(conn, cmd, nil, tree)

	case "permission_response":
		// Fire-and-forget: no response sent (matches dialog_response pattern).
		s.manager.SendPermissionResponse(cmd.Key, cmd.QuestionID, cmd.OptionID)

	case "elicitation_response":
		// Fire-and-forget: no response sent. Resolves a pending elicitation
		// raised by ion.elicit() / ctx.Elicit() so the extension Promise resolves.
		s.manager.HandleElicitationResponse(cmd.Key, cmd.ElicitRequestID, cmd.ElicitResponse, cmd.ElicitCancelled)

	case "list_stored_sessions":
		limit := cmd.Limit
		if limit <= 0 {
			limit = 50
		}
		results, err := conversation.ListStored("", limit)
		s.sendResult(conn, cmd, err, results)

	case "load_session_history":
		var messages []types.SessionMessage
		var err error
		if len(cmd.SessionIDs) > 0 {
			messages, err = conversation.LoadChainMessages(cmd.SessionIDs, "")
		} else {
			messages, err = conversation.LoadMessages(cmd.Key, "")
		}
		s.sendResult(conn, cmd, err, messages)

	case "save_session_label":
		conv, err := conversation.Load(cmd.Key, "")
		if err != nil {
			s.sendResult(conn, cmd, err, nil)
			break
		}
		conversation.AddLabelEntry(conv, cmd.Label)
		err = conversation.Save(conv, "")
		s.sendResult(conn, cmd, err, nil)

	case "get_conversation":
		limit := cmd.Limit
		if limit <= 0 {
			limit = 50
		}
		offset := cmd.Offset
		if offset < 0 {
			offset = 0
		}
		result, err := conversation.LoadMessagesPaginated(cmd.Key, "", offset, limit)
		s.sendResult(conn, cmd, err, result)

	case "generate_title":
		// Run in a goroutine to avoid blocking the client's read loop
		// while the LLM call is in flight.
		go func(c net.Conn, command *protocol.ClientCommand) {
			defer func() {
				if r := recover(); r != nil {
					buf := make([]byte, 4096)
					n := runtime.Stack(buf, false)
					utils.Error("Server", fmt.Sprintf("panic in generate_title: %v\n%s", r, buf[:n]))
					s.sendResult(c, command, fmt.Errorf("internal error"), nil)
				}
			}()
			title, err := titling.GenerateTitle(context.Background(), command.Text)
			if err != nil {
				s.sendResult(c, command, err, nil)
				return
			}
			s.sendResult(c, command, nil, map[string]string{"title": title})
		}(conn, cmd)

	case "reconcile_state":
		s.manager.ReconcileState(cmd.Key)
		s.sendResult(conn, cmd, nil, nil)

	case "shutdown":
		_ = s.Stop()

	case "health":
		type healthResult struct {
			data map[string]interface{}
		}
		ch := make(chan healthResult, 1)
		go func() {
			ch <- healthResult{data: s.healthSnapshot()}
		}()
		select {
		case r := <-ch:
			s.sendResult(conn, cmd, nil, r.data)
		case <-time.After(5 * time.Second):
			s.sendResult(conn, cmd, nil, map[string]interface{}{
				"ok":    false,
				"error": "health snapshot timed out",
			})
		}

	default:
		utils.Warn("Server", "unknown command: "+cmd.Cmd)
		s.sendResult(conn, cmd, fmt.Errorf("unknown command: %s", cmd.Cmd), nil)
	}
}

func (s *Server) sendResult(conn net.Conn, cmd *protocol.ClientCommand, err error, data interface{}) {
	if cmd.RequestID == "" {
		return // G18: suppress noisy empty-requestId responses
	}
	result := protocol.ServerResult{
		RequestID: cmd.RequestID,
		OK:        err == nil,
	}
	if err != nil {
		result.Error = err.Error()
	}
	if data != nil {
		result.Data = data
	}
	line := protocol.SerializeServerResult(result)
	s.writeToClient(conn, line)
}

// sendForkResult sends a fork_session response with newKey at the top level
// of the result JSON (not nested inside data), matching the TS wire contract.
func (s *Server) sendForkResult(conn net.Conn, cmd *protocol.ClientCommand, err error, newKey string) {
	if cmd.RequestID == "" {
		return
	}
	result := protocol.ServerResult{
		RequestID: cmd.RequestID,
		OK:        err == nil,
	}
	if err != nil {
		result.Error = err.Error()
	} else {
		result.NewKey = newKey
	}
	line := protocol.SerializeServerResult(result)
	s.writeToClient(conn, line)
}

// healthSnapshot returns daemon liveness data for the health command.
func (s *Server) healthSnapshot() map[string]interface{} {
	version := s.version
	if version == "" {
		version = "dev"
	}
	return map[string]interface{}{
		"ok":           true,
		"version":      version,
		"startedAt":    s.startedAt.UTC().Format(time.RFC3339),
		"uptimeSec":    int64(time.Since(s.startedAt).Seconds()),
		"sessionCount": len(s.manager.ListSessions()),
		"socketPath":   s.socketPath,
	}
}

// writeToClient routes a single line to the given conn through its state
// queue, so it is serialized with broadcast traffic on the same connection.
// Results are critical control messages and always use the state queue. A nil
// conn is a relay-dispatched command with no socket reply (results go via
// broadcast listeners).
func (s *Server) writeToClient(conn net.Conn, line string) {
	if conn == nil {
		return
	}
	s.mu.RLock()
	cw, ok := s.clients[conn]
	s.mu.RUnlock()
	if !ok {
		// Conn is not (or no longer) registered. Fall back to a direct write
		// with a deadline so a wedged peer cannot stall the caller.
		_ = conn.SetWriteDeadline(time.Now().Add(broadcastWriteDeadline))
		if _, err := conn.Write([]byte(line)); err != nil {
			utils.Log("Server", "write error (untracked client): "+err.Error())
		}
		return
	}
	payload := []byte(line)
	select {
	case cw.stateQueue <- payload: // Results always go to state queue
	default:
		n := atomic.AddInt64(&cw.stateDropped, 1)
		if n == 1 || n%256 == 0 {
			utils.Log("Server", fmt.Sprintf("client state queue full; dropped %d events", n))
		}
	}
}
