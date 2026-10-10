// server_stop.go — the engine server's shutdown: stop every session, close
// every client once its queued results are written, close the listener, and
// remove the socket file. Split from server.go, which holds start-up and
// client accept.
package server

import (
	"net"
	"os"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Stop gracefully shuts down the server: stops all sessions, closes all
// client connections, closes the listener, and removes the socket file.
// Safe to call multiple times (e.g. from both shutdown command and OS signal).
func (s *Server) Stop() error {
	s.stopOnce.Do(func() {
		s.contextBreakdownMu.Lock()
		s.mcpWorkMu.Lock()
		close(s.done)
		if s.shutdownCancel != nil {
			s.shutdownCancel()
		}
		s.mcpWorkMu.Unlock()
		s.contextBreakdownMu.Unlock()

		if s.lanes != nil {
			s.lanes.stop()
		}

		if s.ownership != nil {
			s.ownership.stopAll()
		}

		s.mu.Lock()
		pprofStop := s.pprofStop
		s.mu.Unlock()
		if pprofStop != nil {
			pprofStop()
		}

		s.manager.PrepareForProcessShutdown()
		if err := s.manager.StopAll(); err != nil {
			// Sessions refusing to stop during shutdown are otherwise invisible.
			utils.LogWithFields(utils.LevelInfo, "server", "StopAll during shutdown returned error", map[string]any{"error": err.Error()})
		}
		s.contextBreakdownWorkers.Wait()
		s.mcpWorkers.Wait()

		// Take the client set out from under the lock first: a drain that
		// fails its last write evicts through the same lock, and the eviction
		// then finds nothing to close twice.
		s.mu.Lock()
		stopping := s.clients
		s.clients = make(map[net.Conn]*clientWriter)
		s.mu.Unlock()
		remainingClients := len(stopping)
		for conn, cw := range stopping {
			remainingClients--
			utils.LogWithFields(utils.LevelInfo, "server", "client disconnected", map[string]any{
				"connection_id": cw.id, "reason": "server_stop", "active_clients": remainingClients,
			})
			close(cw.done)
			// The result a client is waiting on (a shutdown command's own) is
			// still on its state queue; the drain writes it before the conn
			// closes. Bounded by the write deadline so a wedged peer cannot
			// hold the stop.
			select {
			case <-cw.drained:
			case <-time.After(broadcastWriteDeadline):
				utils.LogWithFields(utils.LevelInfo, "server", "stop closing client before its queue drained", map[string]any{
					"connection_id": cw.id, "waited_ms": broadcastWriteDeadline.Milliseconds(),
				})
			}
			if err := conn.Close(); err != nil {
				utils.LogWithFields(utils.LevelInfo, "server", "stop client conn close failed", map[string]any{"error": err.Error()})
			}
		}
		s.mu.Lock()
		for _, lh := range s.broadcastListeners {
			close(lh.done)
		}
		s.broadcastListeners = nil
		// Close the server-level telemetry collectors (client.backpressure and
		// the standalone conversation.* family) so their periodic flush
		// goroutines stop and any buffered events reach their targets before
		// the process exits. Guarded by the same lock as their setters.
		serverTelem := s.telemetry
		convTelem := s.conversationEventsTelemetry
		s.mu.Unlock()

		if serverTelem != nil {
			serverTelem.Close()
		}
		if convTelem != nil {
			convTelem.Close()
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
