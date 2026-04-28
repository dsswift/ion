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

// Server listens on a Unix domain socket (or TCP on Windows), accepts NDJSON
// commands from clients, and broadcasts session events back to all connected clients.
type Server struct {
	socketPath         string
	listener           net.Listener
	clients            map[net.Conn]struct{}
	mu                 sync.RWMutex
	manager            *session.Manager
	config             *types.EngineRuntimeConfig
	broadcastListeners []func(line string)
	done               chan struct{}
	stopOnce           sync.Once
}

// SetConfig stores the engine runtime config for use by sessions.
func (s *Server) SetConfig(cfg *types.EngineRuntimeConfig) {
	s.config = cfg
	s.manager.SetConfig(cfg)
}

// NewServer creates a Server backed by the given RunBackend.
// The session Manager is created internally and wired to the backend.
func NewServer(socketPath string, b backend.RunBackend) *Server {
	mgr := session.NewManager(b)

	s := &Server{
		socketPath: socketPath,
		clients:    make(map[net.Conn]struct{}),
		manager:    mgr,
		done:       make(chan struct{}),
	}

	// Wire manager events to broadcast
	mgr.OnEvent(func(key string, event types.EngineEvent) {
		raw, err := json.Marshal(event)
		if err != nil {
			utils.Log("Server", "failed to marshal event: "+err.Error())
			return
		}
		line := protocol.SerializeServerEvent(key, json.RawMessage(raw))
		s.broadcast(line)
	})

	return s
}

// Start begins listening on the socket. On Unix, uses a Unix domain socket
// with stale socket detection. On Windows, uses TCP loopback on port 21017.
func (s *Server) Start() error {
	var ln net.Listener
	var err error

	if runtime.GOOS == "windows" {
		// Windows: use TCP loopback since Go doesn't natively support named pipes.
		conn, dialErr := net.Dial("tcp", s.socketPath)
		if dialErr == nil {
			conn.Close()
			return fmt.Errorf("engine already listening on %s", s.socketPath)
		}
		ln, err = net.Listen("tcp", s.socketPath)
		if err != nil {
			return fmt.Errorf("failed to listen on %s: %w", s.socketPath, err)
		}
	} else {
		// Unix: stale socket detection, then bind.
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
		for conn := range s.clients {
			conn.Close()
		}
		s.clients = make(map[net.Conn]struct{})
		s.mu.Unlock()

		if s.listener != nil {
			s.listener.Close()
		}

		// Only remove socket file on Unix; TCP listeners have no file to clean up.
		if runtime.GOOS != "windows" {
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

		s.mu.Lock()
		s.clients[conn] = struct{}{}
		s.mu.Unlock()

		go s.handleClient(conn)
	}
}

func (s *Server) handleClient(conn net.Conn) {
	defer func() {
		s.mu.Lock()
		delete(s.clients, conn)
		s.mu.Unlock()
		conn.Close()
	}()

	scanner := bufio.NewScanner(conn)
	// Allow large messages (1MB)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

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
	utils.Debug("Server", fmt.Sprintf("dispatch: cmd=%s key=%s requestID=%s", cmd.Cmd, cmd.Key, cmd.RequestID))
	switch cmd.Cmd {
	case "start_session":
		result, err := s.manager.StartSession(cmd.Key, *cmd.Config)
		s.sendResult(conn, cmd, err, result)

	case "send_prompt":
		var overrides *session.PromptOverrides
		resolvedExts := cmd.ResolveExtensions()
		if cmd.Model != "" || cmd.MaxTurns > 0 || cmd.MaxBudgetUsd > 0 || len(resolvedExts) > 0 || cmd.NoExtensions || cmd.AppendSystemPrompt != "" {
			overrides = &session.PromptOverrides{
				Model:              cmd.Model,
				MaxTurns:           cmd.MaxTurns,
				MaxBudgetUsd:       cmd.MaxBudgetUsd,
				Extensions:         resolvedExts,
				NoExtensions:       cmd.NoExtensions,
				AppendSystemPrompt: cmd.AppendSystemPrompt,
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
			title, err := titling.GenerateTitle(context.Background(), command.Text)
			if err != nil {
				s.sendResult(c, command, err, nil)
				return
			}
			s.sendResult(c, command, nil, map[string]string{"title": title})
		}(conn, cmd)

	case "shutdown":
		_ = s.Stop()

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

// OnBroadcast registers a listener that receives every broadcast line.
// Used by relay transport to forward engine events to mobile peers.
func (s *Server) OnBroadcast(fn func(line string)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.broadcastListeners = append(s.broadcastListeners, fn)
}

func (s *Server) broadcast(line string) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	for conn := range s.clients {
		_, err := conn.Write([]byte(line))
		if err != nil {
			utils.Log("Server", "broadcast write error: "+err.Error())
		}
	}

	for _, fn := range s.broadcastListeners {
		fn(line)
	}
}

func (s *Server) writeToClient(conn net.Conn, line string) {
	if conn == nil {
		return // relay dispatch: results go via broadcast listeners
	}
	_, err := conn.Write([]byte(line))
	if err != nil {
		utils.Log("Server", "write error: "+err.Error())
	}
}
