package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/cliprobe"
	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/session"
	"github.com/dsswift/ion/engine/internal/telemetry"
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
	home, _ := os.UserHomeDir() //nolint:errcheck // empty home handled by caller
	return filepath.Join(home, ".ion", "engine.sock")
}

// broadcastWriteDeadline is how long a single per-client write may take before
// the drainer treats the connection as dead and evicts it. Configurable via
// TimeoutsConfig.BroadcastWrite().
var broadcastWriteDeadline = 5 * time.Second

// Server listens on a Unix domain socket (or TCP on Windows), accepts NDJSON
// commands from clients, and broadcasts session events back to all connected clients.
type Server struct {
	socketPath   string
	listener     net.Listener
	clients      map[net.Conn]*clientWriter
	mu           sync.RWMutex
	manager      *session.Manager
	config       *types.EngineRuntimeConfig
	authResolver *auth.Resolver
	// identity is the engine-owned operator OIDC identity manager (nil when
	// no auth.identityProvider is configured). See dispatch_oidc.go.
	identity           *auth.IdentityManager
	broadcastListeners []*listenerHandle
	done               chan struct{}
	shutdownCtx        context.Context
	shutdownCancel     context.CancelFunc
	stopOnce           sync.Once
	version            string
	startedAt          time.Time
	// cliCapable is true when the engine is running with a backend that can
	// serve Anthropic models via the Claude CLI (i.e. ClaudeCodeBackend or
	// HybridBackend). list_models uses this to mark the anthropic provider
	// as authed via CLI when no API key is configured.
	cliCapable bool

	// computeContextBreakdown performs potentially slow provider token-counting for
	// get_context_breakdown. It is injected for tests; production wires the
	// manager implementation. Dispatch always runs it off the socket read loop.
	computeContextBreakdown func(context.Context, string) error
	contextBreakdownMu      sync.Mutex
	contextBreakdownActive  map[string]struct{}
	contextBreakdownWorkers sync.WaitGroup

	// probes caches the install/auth state of the delegated provider CLIs
	// (claude/codex/grok/cursor). list_models reads it to populate each
	// provider's cli status; it is refreshed asynchronously at startup and on
	// refresh_models. Never nil after NewServer.
	probes *cliprobe.Registry

	// hybrid is the typed view of the backend when it is a *HybridBackend,
	// captured at NewServer so SetConfig can wire the live CLI-auth probe into
	// credential-based routing. Nil for non-hybrid backends.
	hybrid *backend.HybridBackend

	// loginFn/logoutFn drive the interactive provider CLI login/logout. Nil
	// uses the real cliprobe implementations; tests override via SetLoginFuncs.
	loginFn  cliprobe.LoginFunc
	logoutFn cliprobe.LogoutFunc

	// lanes routes incoming commands into bounded per-session serial
	// queues (same key ordered, different keys concurrent), a process-
	// level concurrent pool, and an independent health path. Initialised
	// lazily in Start so construction order is safe.
	lanes *commandLanes

	// ownership binds live session keys to the client connections that
	// claimed them, reaping a session a grace window after its last owning
	// connection disconnects. Prevents the orphaned-session FD leak (a
	// disconnected client's sessions previously lived forever, holding their
	// pooled workspace-watcher descriptors). See session_ownership.go.
	ownership *sessionOwnership

	// telemetry is the process-level collector for server-owned telemetry —
	// currently the client.backpressure event emitted when a client's outbound
	// queue overflows (family 4e). Session-scoped events flow through each
	// session's own collector; this one belongs to the server because
	// backpressure is a transport concern with no session context. Nil when
	// telemetry is disabled; every emit site guards on nil. Guarded by s.mu.
	telemetry *telemetry.Collector
}

// SetTelemetry installs the process-level telemetry collector used for
// server-owned events (client.backpressure). Nil disables server telemetry.
func (s *Server) SetTelemetry(c *telemetry.Collector) {
	s.mu.Lock()
	s.telemetry = c
	s.mu.Unlock()
}

// Telemetry returns the process-level telemetry collector, or nil when
// telemetry is disabled. Used at serve startup to drain load-time enforcement
// actions (config.DrainEnforcementActions) into the collector.
func (s *Server) Telemetry() *telemetry.Collector {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.telemetry
}

// SetConfig stores the engine runtime config for use by sessions.
func (s *Server) SetConfig(cfg *types.EngineRuntimeConfig) {
	s.manager.SetConfig(cfg)
	if cfg != nil && cfg.Timeouts != nil {
		broadcastWriteDeadline = cfg.Timeouts.BroadcastWrite()
	}
	// Install the process-level telemetry collector for server-owned events
	// (client.backpressure) when telemetry is enabled in config. Nil-safe: a
	// disabled or absent telemetry block leaves server telemetry off.
	if cfg != nil && cfg.Telemetry != nil && cfg.Telemetry.Enabled {
		collector := telemetry.NewCollector(*cfg.Telemetry)
		s.SetTelemetry(collector)
		// Share the process collector with the manager for Manager-level
		// enforcement audit events (the session-limit rejection fires before
		// any per-session collector exists).
		s.manager.SetProcessTelemetry(collector)
	}
	// Store the config after the collector wiring so the field assignment
	// below is not racing the SetTelemetry lock above.
	s.config = cfg
	// Probe the delegated provider CLIs (install/auth/models) now that the
	// backend selection is known. Runs in the background; list_models reads the
	// cache and updates as probes land.
	s.RefreshProviderProbes()
	// Wire credential-based routing: the hybrid consults the live probe
	// registry on every routing decision, so a completed CLI login or an
	// added/removed API key changes routing on the next run — no restart.
	if s.hybrid != nil {
		s.hybrid.SetCliAuthProbe(s.cliAuthedProbe())
		utils.LogWithFields(utils.LevelInfo, "server", "hybrid cli-auth probe wired", nil)
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
	shutdownCtx, shutdownCancel := context.WithCancel(context.Background())

	// Detect whether the backend can serve Anthropic models via Claude CLI,
	// and retain the typed hybrid so SetConfig can wire credential routing.
	var cliCapable bool
	var hybrid *backend.HybridBackend
	switch v := b.(type) {
	case *backend.ClaudeCodeBackend:
		cliCapable = true
	case *backend.HybridBackend:
		cliCapable = true
		hybrid = v
	}
	utils.LogWithFields(utils.LevelInfo, "server", "backend type", map[string]any{"reason": cliCapable, "hybrid": hybrid != nil})

	s := &Server{
		socketPath:              socketPath,
		clients:                 make(map[net.Conn]*clientWriter),
		manager:                 mgr,
		done:                    make(chan struct{}),
		shutdownCtx:             shutdownCtx,
		shutdownCancel:          shutdownCancel,
		startedAt:               time.Now(),
		cliCapable:              cliCapable,
		computeContextBreakdown: mgr.ComputeAndEmitContextBreakdownContext,
		contextBreakdownActive:  make(map[string]struct{}),
		probes:                  cliprobe.NewRegistry(),
		hybrid:                  hybrid,
	}
	// Reap orphaned sessions a grace window after their last owning
	// connection disconnects. Wired to StopSession so the full teardown
	// (watcher release, extension close, MCP/telemetry cleanup) runs.
	s.ownership = newSessionOwnership(func(key string) {
		err := s.manager.StopSession(key)
		s.lanes.evictSession(key)
		if err != nil {
			utils.LogWithFields(utils.LevelDebug, "server", "reap stop session", map[string]any{"session_id": key, "error": err.Error()})
		}
	})

	// Command lanes route incoming commands into bounded per-session
	// serial queues. Initialised before events are wired so the lanes
	// are ready when the first client connects.
	s.lanes = newCommandLanes(s.dispatch, s.rejectStoppedSessionCommand)

	// Wire manager events to broadcast
	mgr.OnEvent(func(key string, event types.EngineEvent) {
		raw, err := json.Marshal(event)
		if err != nil {
			utils.LogWithFields(utils.LevelInfo, "server", "start failed to marshal event", map[string]any{"error": err.Error()})
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
				utils.LogWithFields(utils.LevelInfo, "server", "start probe-conn close failed", map[string]any{"error": err.Error()})
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
			utils.LogWithFields(utils.LevelInfo, "server", "removing stale socket", map[string]any{"path": s.socketPath})
			if err := os.Remove(s.socketPath); err != nil && !os.IsNotExist(err) {
				utils.LogWithFields(utils.LevelInfo, "server", "start remove stale socket failed", map[string]any{"path": s.socketPath, "error": err.Error()})
			}
		}
		ln, err = net.Listen("unix", s.socketPath)
		if err != nil {
			// The caller holds the PID lock, so no other engine is alive. If
			// the bind still fails with "address already in use", the socket
			// file is stale (a previous engine died without cleaning it up and
			// the stat/remove above raced or the file reappeared). Remove it
			// and retry once rather than exiting and forcing the desktop into
			// a respawn storm. Any other error is genuinely fatal.
			if isAddrInUse(err) {
				utils.LogWithFields(utils.LevelInfo, "server", "listen failed address-in-use removing stale socket retrying", map[string]any{"path": s.socketPath})
				if rmErr := os.Remove(s.socketPath); rmErr != nil && !os.IsNotExist(rmErr) {
					utils.LogWithFields(utils.LevelInfo, "server", "start retry remove stale socket failed", map[string]any{"path": s.socketPath, "error": rmErr.Error()})
				}
				ln, err = net.Listen("unix", s.socketPath)
			}
			if err != nil {
				return fmt.Errorf("failed to listen on %s: %w", s.socketPath, err)
			}
		}
	}

	s.listener = ln
	utils.LogWithFields(utils.LevelInfo, "server", "listening", map[string]any{"path": s.socketPath})

	go s.acceptLoop()
	return nil
}

// isAddrInUse reports whether err is (or wraps) an EADDRINUSE syscall error —
// the "address already in use" condition net.Listen returns when a socket file
// still exists and the kernel considers it bound. Used by Start to distinguish
// a stale-socket bind failure (recoverable: remove and retry) from a genuinely
// fatal listen error. Unwraps the *net.OpError → *os.SyscallError chain via
// errors.As down to the concrete syscall.Errno.
func isAddrInUse(err error) bool {
	if err == nil {
		return false
	}
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return errno == syscall.EADDRINUSE
	}
	return false
}

// Stop gracefully shuts down the server: stops all sessions, closes all
// client connections, closes the listener, and removes the socket file.
// Safe to call multiple times (e.g. from both shutdown command and OS signal).
func (s *Server) Stop() error {
	s.stopOnce.Do(func() {
		s.contextBreakdownMu.Lock()
		close(s.done)
		if s.shutdownCancel != nil {
			s.shutdownCancel()
		}
		s.contextBreakdownMu.Unlock()

		if s.lanes != nil {
			s.lanes.stop()
		}

		if s.ownership != nil {
			s.ownership.stopAll()
		}

		s.manager.PrepareForProcessShutdown()
		if err := s.manager.StopAll(); err != nil {
			// Sessions refusing to stop during shutdown are otherwise invisible.
			utils.LogWithFields(utils.LevelInfo, "server", "StopAll during shutdown returned error", map[string]any{"error": err.Error()})
		}
		s.contextBreakdownWorkers.Wait()

		s.mu.Lock()
		for conn, cw := range s.clients {
			close(cw.done)
			if err := conn.Close(); err != nil {
				utils.LogWithFields(utils.LevelInfo, "server", "stop client conn close failed", map[string]any{"error": err.Error()})
			}
		}
		s.clients = make(map[net.Conn]*clientWriter)
		for _, lh := range s.broadcastListeners {
			close(lh.done)
		}
		s.broadcastListeners = nil
		// Close the server-level telemetry collector (client.backpressure events)
		// so its periodic flush goroutine stops and any buffered events reach disk
		// before the process exits. Guarded by the same lock as SetTelemetry.
		serverTelem := s.telemetry
		s.mu.Unlock()

		if serverTelem != nil {
			serverTelem.Close()
		}

		if s.listener != nil {
			if err := s.listener.Close(); err != nil {
				utils.LogWithFields(utils.LevelInfo, "server", "stop listener close failed", map[string]any{"error": err.Error()})
			}
		}

		// Only remove socket file for Unix domain sockets; TCP listeners
		// have no file to clean up.
		if !looksLikeHostPort(s.socketPath) {
			if err := os.Remove(s.socketPath); err != nil && !os.IsNotExist(err) {
				utils.LogWithFields(utils.LevelInfo, "server", "stop socket file remove failed", map[string]any{"path": s.socketPath, "error": err.Error()})
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
	s.lanes.submit(nil, cmd)
}

func (s *Server) acceptLoop() {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			select {
			case <-s.done:
				return
			default:
				utils.LogWithFields(utils.LevelInfo, "server", "accept error", map[string]any{"error": err.Error()})
				continue
			}
		}

		tuneSocketBuffer(conn)

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

// socketBufferSize is the target send/receive buffer for accepted client
// connections. macOS defaults Unix domain sockets to 8 KB; a desktop
// restoring 30+ sessions produces hundreds of state events in seconds,
// filling the 8 KB pipe faster than the client can drain it and causing
// the 5 s write-deadline eviction. 256 KB absorbs the startup burst
// without requiring the client to keep up in real time. The same tuning
// is applied to the Windows TCP loopback listener (see DefaultSocketPath),
// where an identical burst reaches the client over a different transport.
const socketBufferSize = 256 * 1024

// tuneSocketBuffer enlarges the send and receive buffers on an accepted
// connection. Best-effort: a failure is logged but does not reject the
// client.
func tuneSocketBuffer(conn net.Conn) {
	sc, ok := conn.(syscall.Conn)
	if !ok {
		return
	}
	raw, err := sc.SyscallConn()
	if err != nil {
		utils.LogWithFields(utils.LevelDebug, "server", "tune socket buffer: SyscallConn failed", map[string]any{"error": err.Error()})
		return
	}
	var setErr error
	raw.Control(func(fd uintptr) { //nolint:errcheck // best-effort tuning
		setErr = setSocketBuffers(fd, socketBufferSize)
	})
	if setErr != nil {
		utils.LogWithFields(utils.LevelDebug, "server", "tune socket buffer: setsockopt failed", map[string]any{"error": setErr.Error()})
	}
}

// evictClient is defined in session_ownership.go: it removes a client from the
// broadcast set, releases the connection's session ownership (triggering the
// orphaned-session reap path), and closes the conn.

func (s *Server) handleClient(conn net.Conn) {
	defer s.evictClient(conn)
	defer func() {
		if r := recover(); r != nil {
			errStr := r
			utils.LogWithFields(utils.LevelError, "server", "panic in handle client", map[string]any{"error": errStr})
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

		if !s.lanes.submit(conn, cmd) {
			result := protocol.SerializeServerResult(protocol.ServerResult{
				RequestID: cmd.RequestID,
				OK:        false,
				Error:     "command queue full",
			})
			s.writeToClient(conn, result)
		}
	}
}

// dispatch is defined in dispatch.go — the command-routing switch lives in its
// own file because it is the highest-churn surface in the package (every new
// wire command adds a case).

func (s *Server) rejectStoppedSessionCommand(conn net.Conn, cmd *protocol.ClientCommand) {
	utils.LogWithFields(utils.LevelInfo, "server", "queued command rejected: session stopped", map[string]any{
		"session_id": cmd.Key,
		"status":     cmd.Cmd,
		"request_id": cmd.RequestID,
	})
	s.sendResult(conn, cmd, fmt.Errorf("session stopped"), nil)
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
		conn.SetWriteDeadline(time.Now().Add(broadcastWriteDeadline)) //nolint:errcheck // best-effort deadline set
		if _, err := conn.Write([]byte(line)); err != nil {
			utils.LogWithFields(utils.LevelInfo, "server", "write error untracked client", map[string]any{"error": err.Error()})
		}
		return
	}
	payload := []byte(line)
	select {
	case cw.stateQueue <- payload:
	case <-cw.done:
	}
}
