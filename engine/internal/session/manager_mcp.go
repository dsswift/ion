package session

// manager_mcp.go — the Manager's MCP connection surface.
//
// Lives in its own file because manager.go is size-allowlisted and must not
// grow. Two concerns:
//
//   - Reading a session's live connections (used by consumers reporting
//     server state, and by tests asserting what actually connected).
//   - Reconnecting one named server across every live session, which is what
//     makes a completed `mcp_login` take effect immediately instead of at the
//     next daemon restart.

import (
	"fmt"
	"sort"
	"sync"

	ionconfig "github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// mcpConnectErrors holds the most recent connect failure per server name, so a
// client asking for server state learns WHY a configured server is missing
// rather than just that it is absent. Without this the only record of the
// failure is the engine's log file, which no remote consumer can read.
//
// Process-global rather than per-session: the failure is a property of the
// server (a bad URL, an expired token, an unreachable host), not of whichever
// session happened to try first, and a client asks about servers without
// naming a session. Bounded by the number of configured servers.
var (
	mcpConnectErrors   = make(map[string]string)
	mcpConnectErrorsMu sync.RWMutex
)

// recordMcpConnectError stores the reason a server failed to connect.
func (m *Manager) recordMcpConnectError(name string, err error) {
	if err == nil {
		return
	}
	mcpConnectErrorsMu.Lock()
	defer mcpConnectErrorsMu.Unlock()
	mcpConnectErrors[name] = utils.ErrStr(err)
}

// clearMcpConnectError drops a stored failure after a successful connect, so a
// server that recovers stops reporting a stale reason.
func (m *Manager) clearMcpConnectError(name string) {
	mcpConnectErrorsMu.Lock()
	defer mcpConnectErrorsMu.Unlock()
	delete(mcpConnectErrors, name)
}

// mcpConnectError returns the last recorded failure for a server, or "".
func mcpConnectError(name string) string {
	mcpConnectErrorsMu.RLock()
	defer mcpConnectErrorsMu.RUnlock()
	return mcpConnectErrors[name]
}

// ensureMcpConnections lazily establishes the session's MCP connections,
// exactly once per session. Called at prompt dispatch, before the RunConfig is
// built from s.mcpConns.
//
// Lazy rather than eager because session start must not pay for network I/O the
// session may never use: a desktop rehydrating dozens of tabs starts every one
// of them, but only tabs the user actually prompts need a live MCP connection.
// Eager connects made rehydration O(tabs × servers × RTT) — measured at 20 tabs
// × ~1.7s = 32s against one healthy server, and up to two 30-second metadata
// timeouts per tab per unreachable server.
//
// The connect itself is the same loop StartSession used to run, preserving its
// properties: servers resolve FRESH from engine.json (so `ion mcp add` applies
// to the next prompt with no daemon restart), failures record per-server state
// for the snapshot and never fail the dispatch (a broken server costs its
// tools, not the conversation), and the disposal guard closes the connection
// rather than leaking it when the session vanished mid-connect.
//
// Single-flighted by s.mcpConnectOnce: concurrent dispatches (a prompt racing a
// queued prompt drain) must not connect twice. Later dispatches see the result
// through s.mcpConns as before. The "Connecting MCP servers..." working message
// is emitted only when there are servers to connect, so promptless sessions and
// MCP-less configs emit nothing.
func (m *Manager) ensureMcpConnections(s *engineSession, key string) {
	s.mcpConnectOnce.Do(func() {
		defer func() {
			m.mu.Lock()
			s.mcpConnectDone = true
			m.mu.Unlock()
		}()

		// Resolved FRESH from engine.json rather than read from the boot-cached
		// m.config: the engine is a long-lived launchd daemon, so a server
		// added by `ion mcp add` (or a client's mcp_add) after startup must not
		// need a daemon restart. Resolution runs the full layered merge plus
		// enterprise enforcement, so denylisted and non-allowlisted servers are
		// already pruned here.
		mcpServers := ionconfig.ResolveMcpServers(s.config.WorkingDirectory)
		if len(mcpServers) == 0 {
			return
		}

		m.emit(key, types.EngineEvent{
			Type:         "engine_working_message",
			EventMessage: "Connecting MCP servers...",
		})
		defer m.emit(key, types.EngineEvent{
			Type:         "engine_working_message",
			EventMessage: "",
		})

		for name, mcpCfg := range mcpServers {
			conn, err := mcp.Connect(name, mcpCfg)
			if err != nil {
				// A whole server's tools going away is an error, not info, and
				// missed by ERROR-level log sweeps at Info. Key by serverName;
				// stringify the error so it serializes as a message not an object.
				utils.LogWithFields(utils.LevelError, "session", "mcp connect failed", map[string]any{"serverName": name, "error": utils.ErrStr(err)})
				// Recorded so a client can render WHY a configured server is
				// absent. Without this the only account of the failure is the
				// engine's log file, which no remote consumer can read.
				m.recordMcpConnectError(name, err)
				continue
			}
			m.clearMcpConnectError(name)
			m.mu.Lock()
			// Guard against session disposal/replacement while Connect() was
			// blocking. If the session is gone or has been replaced, close the
			// freshly-opened connection immediately to avoid a file-descriptor
			// leak.
			if cur, ok := m.sessions[key]; !ok || cur != s {
				m.mu.Unlock()
				conn.Close() //nolint:errcheck // resource close
				utils.LogWithFields(utils.LevelInfo, "session", "mcp: session disposed during connect — closing leaked conn", map[string]any{"serverName": name, "key": key})
				continue
			}
			s.mcpConns = append(s.mcpConns, conn)
			m.mu.Unlock()
			utils.LogWithFields(utils.LevelInfo, "session", "mcp server connected", map[string]any{"serverName": name, "key": key, "toolCount": len(conn.Tools())})
		}
	})
}

// mcpConnectionsFor returns the live MCP connections for a session key, or nil
// when the session does not exist. The slice is copied so a caller cannot
// mutate the session's own state.
func (m *Manager) mcpConnectionsFor(key string) []*mcp.Connection {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.sessions[key]
	if !ok {
		return nil
	}
	return append([]*mcp.Connection{}, s.mcpConns...)
}

// McpServerToolCountsFor reports, for one session, which of the resolved
// servers are currently connected and how many tools each contributed.
// Consumers render this; the engine holds no opinion about how.
func (m *Manager) McpServerToolCountsFor(key string) map[string]int {
	counts := make(map[string]int)
	for _, conn := range m.mcpConnectionsFor(key) {
		counts[conn.Name()] = len(conn.Tools())
	}
	return counts
}

// McpServerStatuses returns the complete snapshot of configured MCP servers
// with their connection and authorization state, sorted by name so the payload
// is stable across emissions.
//
// Connection state is aggregated across every live session: a server is
// reported connected when at least one session holds a connection to it, with
// that connection's tool count. Servers are resolved fresh (projectDir scopes
// the project config layer), so a server added moments ago appears immediately.
func (m *Manager) McpServerStatuses(projectDir string) []types.McpServerStatus {
	servers := ionconfig.ResolveMcpServers(projectDir)

	// Aggregate live connections by server name across all sessions.
	connected := make(map[string]int)
	for _, key := range m.SessionKeys() {
		for _, conn := range m.mcpConnectionsFor(key) {
			if count := len(conn.Tools()); count >= connected[conn.Name()] {
				connected[conn.Name()] = count
			}
		}
	}

	names := make([]string, 0, len(servers))
	for name := range servers {
		names = append(names, name)
	}
	sort.Strings(names)

	statuses := make([]types.McpServerStatus, 0, len(servers))
	for _, name := range names {
		cfg := servers[name]
		toolCount, isConnected := connected[name]
		status := types.McpServerStatus{
			Name:          name,
			Transport:     cfg.Type,
			URL:           cfg.URL,
			Command:       cfg.Command,
			Connected:     isConnected,
			Authenticated: mcp.IsAuthenticated(name),
			ToolCount:     toolCount,
		}
		if !isConnected {
			status.LastError = mcpConnectError(name)
			// A permanently-failed grant outranks whatever the last connect
			// attempt happened to say: "already used" is the actionable cause,
			// while the 401 it produced is only the symptom. Consumers that
			// render LastError then show the operator the reason they must
			// re-authorize instead of a bare status code.
			if reason := mcp.GrantExpiredReason(name); reason != "" {
				status.LastError = fmt.Sprintf(
					"stored authorization can no longer be renewed (%s) — run `ion mcp login %s` to re-authorize",
					reason, name)
			}
		}
		statuses = append(statuses, status)
	}
	return statuses
}

// SessionKeys returns every live session key.
func (m *Manager) SessionKeys() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	keys := make([]string, 0, len(m.sessions))
	for key := range m.sessions {
		keys = append(keys, key)
	}
	return keys
}

// ReconnectMcpServer re-establishes one named MCP server across every live
// session.
//
// This is the step that makes authorization useful. A session that started
// before the operator logged in holds either no connection for the server or a
// connection whose requests 401. Without reconnecting, the freshly-stored token
// would only take effect on a session started later — in practice meaning the
// operator logs in, sees nothing change, and restarts the daemon, killing every
// live conversation. Doing the work here keeps login a live operation.
//
// Swapping the connection into s.mcpConns is sufficient to reach the model: the
// backend RunConfig (and with it the MCP tool defs and the call router) is built
// fresh from s.mcpConns on every dispatch in buildRunConfig, so the next turn
// picks up the new connection with no additional rewiring.
//
// Returns the number of sessions that ended up with a working connection.
// Per-session failures are logged and skipped rather than aborting the sweep:
// one wedged session must not deny every other session its refreshed tools.
func (m *Manager) ReconnectMcpServer(name string) int {
	reconnected := 0

	for _, key := range m.SessionKeys() {
		// Resolve per session: sessions can have different working directories,
		// so the project config layer (and thus this server's definition) can
		// legitimately differ between them.
		m.mu.RLock()
		s, ok := m.sessions[key]
		var workingDir string
		var everConnected bool
		if ok {
			workingDir = s.config.WorkingDirectory
			everConnected = s.mcpConnectDone
		}
		m.mu.RUnlock()
		if !ok {
			continue
		}
		if !everConnected {
			// This session has never run its lazy connect — it is an idle tab.
			// Its first dispatch will connect with the freshly-stored credential
			// anyway, so reconnecting it here would only reintroduce the eager
			// per-tab network cost the lazy connect exists to avoid (dozens of
			// rehydrated tabs × one connect each, on every login).
			utils.LogWithFields(utils.LevelDebug, "session", "mcp reconnect skipped; session has not connected yet", map[string]any{
				"serverName": name, "key": key,
			})
			continue
		}

		servers := ionconfig.ResolveMcpServers(workingDir)
		cfg, configured := servers[name]
		if !configured {
			// Not an error: the server may be absent from this session's
			// layered config, or pruned by enterprise policy.
			utils.LogWithFields(utils.LevelDebug, "session", "mcp reconnect skipped; server not configured for session", map[string]any{
				"serverName": name, "key": key,
			})
			continue
		}

		// Connect BEFORE dropping the old connection: if the new attempt fails,
		// the session keeps the connection it had rather than being left with
		// none, which would silently strip the server's tools mid-conversation.
		conn, err := mcp.Connect(name, cfg)
		if err != nil {
			utils.LogWithFields(utils.LevelError, "session", "mcp reconnect failed; keeping existing connection", map[string]any{
				"serverName": name, "key": key, "error": utils.ErrStr(err),
			})
			continue
		}

		m.mu.Lock()
		cur, stillLive := m.sessions[key]
		if !stillLive || cur != s {
			// The session was disposed or replaced while Connect was blocking.
			m.mu.Unlock()
			conn.Close() //nolint:errcheck // resource close on an orphaned connection
			utils.LogWithFields(utils.LevelInfo, "session", "mcp reconnect: session disposed during connect — closing leaked conn", map[string]any{
				"serverName": name, "key": key,
			})
			continue
		}

		var replaced *mcp.Connection
		swapped := false
		for i, existing := range s.mcpConns {
			if existing.Name() == name {
				replaced = existing
				s.mcpConns[i] = conn
				swapped = true
				break
			}
		}
		if !swapped {
			s.mcpConns = append(s.mcpConns, conn)
		}
		m.mu.Unlock()

		if replaced != nil {
			// Close the superseded connection so its transport and any session
			// the remote server holds are released.
			//
			// Close also unregisters the name from the package-level connection
			// registry that ListMcpResources / ReadMcpResource resolve through,
			// and the new connection registered itself under that same name
			// during Connect. Closing second would therefore evict the LIVE
			// entry and leave those two tools unable to find the server. So the
			// registry entry is restored immediately after.
			if closeErr := replaced.Close(); closeErr != nil {
				utils.LogWithFields(utils.LevelInfo, "session", "mcp reconnect: closing replaced connection failed", map[string]any{
					"serverName": name, "key": key, "error": closeErr.Error(),
				})
			}
			mcp.Register(conn)
		}

		reconnected++
		utils.LogWithFields(utils.LevelInfo, "session", "mcp server reconnected", map[string]any{
			"serverName": name, "key": key, "toolCount": len(conn.Tools()), "replaced": replaced != nil,
		})
	}

	utils.LogWithFields(utils.LevelInfo, "session", "mcp reconnect sweep complete", map[string]any{
		"serverName": name, "sessionsReconnected": reconnected,
	})
	return reconnected
}
