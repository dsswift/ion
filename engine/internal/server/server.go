package server

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/session"
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
	authResolver       *auth.Resolver
	broadcastListeners []*listenerHandle
	done               chan struct{}
	stopOnce           sync.Once
	version            string
	startedAt          time.Time
	// cliCapable is true when the engine is running with a backend that can
	// serve Anthropic models via the Claude CLI (i.e. CliBackend or
	// HybridBackend). list_models uses this to mark the anthropic provider
	// as authed via CLI when no API key is configured.
	cliCapable bool

	// ownership binds live session keys to the client connections that
	// claimed them, reaping a session a grace window after its last owning
	// connection disconnects. Prevents the orphaned-session FD leak (a
	// disconnected client's sessions previously lived forever, holding their
	// pooled workspace-watcher descriptors). See session_ownership.go.
	ownership *sessionOwnership
}

// SetConfig stores the engine runtime config for use by sessions.
func (s *Server) SetConfig(cfg *types.EngineRuntimeConfig) {
	s.config = cfg
	s.manager.SetConfig(cfg)
	if cfg != nil && cfg.Timeouts != nil {
		broadcastWriteDeadline = cfg.Timeouts.BroadcastWrite()
	}
	// Apply the configurable orphaned-session reap grace window. Nil-safe:
	// SessionReapGrace returns the compiled default for a nil Workspace block.
	if s.ownership != nil {
		s.ownership.setGraceWindow(cfg.GetWorkspace().SessionReapGrace())
	}
}

// SetVersion stores the engine binary version for the health command.
func (s *Server) SetVersion(v string) {
	s.version = v
}

// SetAuthResolver stores the auth resolver for credential operations.
func (s *Server) SetAuthResolver(r *auth.Resolver) {
	s.authResolver = r
}

// NewServer creates a Server backed by the given RunBackend.
// The session Manager is created internally and wired to the backend.
func NewServer(socketPath string, b backend.RunBackend) *Server {
	mgr := session.NewManager(b)

	// Detect whether the backend can serve Anthropic models via Claude CLI.
	var cliCapable bool
	switch b.(type) {
	case *backend.CliBackend, *backend.HybridBackend:
		cliCapable = true
	}
	utils.Log("Server", fmt.Sprintf("backend type=%T cliCapable=%v", b, cliCapable))

	s := &Server{
		socketPath: socketPath,
		clients:    make(map[net.Conn]*clientWriter),
		manager:    mgr,
		done:       make(chan struct{}),
		startedAt:  time.Now(),
		cliCapable: cliCapable,
	}
	// Reap orphaned sessions a grace window after their last owning
	// connection disconnects. Wired to StopSession so the full teardown
	// (watcher release, extension close, MCP/telemetry cleanup) runs.
	s.ownership = newSessionOwnership(func(key string) {
		if err := s.manager.StopSession(key); err != nil {
			utils.Debug("Server", fmt.Sprintf("reap: StopSession key=%s err=%v (already gone?)", key, err))
		}
	})

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

// looksLikeHostPort is defined in socket_addr.go.

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
			if err := conn.Close(); err != nil {
				utils.Log("Server", fmt.Sprintf("Start: probe-conn close failed: %v", err))
			}
			return fmt.Errorf("engine already listening on %s", s.socketPath)
		}
		ln, err = net.Listen("tcp4", s.socketPath)
		if err != nil {
			return fmt.Errorf("failed to listen on %s: %w", s.socketPath, err)
		}
	} else {
		// Unix domain socket mode. The caller holds the PID lock, so no
		// other engine process is alive. Any leftover socket file is stale
		// and safe to remove without dialing.
		if _, statErr := os.Stat(s.socketPath); statErr == nil {
			utils.Log("Server", "removing stale socket: "+s.socketPath)
			if err := os.Remove(s.socketPath); err != nil && !os.IsNotExist(err) {
				utils.Log("Server", fmt.Sprintf("Start: remove stale socket %s failed: %v", s.socketPath, err))
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

		if s.ownership != nil {
			s.ownership.stopAll()
		}

		_ = s.manager.StopAll()

		s.mu.Lock()
		for conn, cw := range s.clients {
			close(cw.done)
			if err := conn.Close(); err != nil {
				utils.Log("Server", fmt.Sprintf("Stop: client conn close failed: %v", err))
			}
		}
		s.clients = make(map[net.Conn]*clientWriter)
		for _, lh := range s.broadcastListeners {
			close(lh.done)
		}
		s.broadcastListeners = nil
		s.mu.Unlock()

		if s.listener != nil {
			if err := s.listener.Close(); err != nil {
				utils.Log("Server", fmt.Sprintf("Stop: listener close failed: %v", err))
			}
		}

		// Only remove socket file for Unix domain sockets; TCP listeners
		// have no file to clean up.
		if !looksLikeHostPort(s.socketPath) {
			if err := os.Remove(s.socketPath); err != nil && !os.IsNotExist(err) {
				utils.Log("Server", fmt.Sprintf("Stop: socket file %s remove failed: %v", s.socketPath, err))
			}
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

// evictClient is defined in session_ownership.go: it removes a client from the
// broadcast set, releases the connection's session ownership (triggering the
// orphaned-session reap path), and closes the conn.

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
	// 64 MB per NDJSON line. Sized for inline document attachments: a
	// 24 MB PDF (maxInlineAttachmentBytes) base64-inflates to ~32 MB, and
	// a prompt may carry more than one. bufio.Scanner grows its buffer
	// lazily, so the higher cap costs nothing until a large line arrives.
	// Old cap of 1 MB caused mid-stream EPIPE on the client write whenever
	// an image attachment landed on the wire; 8 MB dropped the connection
	// for wire-inlined PDFs.
	scanner.Buffer(make([]byte, 0, 64*1024), 64*1024*1024)

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

// dispatch is defined in dispatch.go — the command-routing switch lives in its
// own file because it is the highest-churn surface in the package (every new
// wire command adds a case).

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
	case cw.stateQueue <- payload:
	case <-cw.done:
	}
}
