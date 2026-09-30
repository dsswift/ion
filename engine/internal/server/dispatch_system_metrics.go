package server

import (
	"encoding/json"
	"fmt"
	"net"

	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/sysmetrics"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// dispatch_system_metrics.go serves System Metrics on the engine wire.
//
// engine_system_metrics is not broadcast. A connection opts in with
// system_metrics_watch and receives samples at the interval it asked for; a
// connection that never asks pays nothing. The watch ends when the connection
// sends intervalMs 0 or disconnects (see evictClient).

// SetSystemMetrics installs the System Metrics sampler and wires its samples
// to watching connections. Nil disables the System Metrics commands.
func (s *Server) SetSystemMetrics(sampler *sysmetrics.Sampler) {
	s.mu.Lock()
	s.sysMetrics = sampler
	s.mu.Unlock()
	if sampler != nil {
		sampler.AddListener(s.deliverSystemMetrics)
	}
}

// SystemMetrics returns the installed sampler, or nil.
func (s *Server) SystemMetrics() *sysmetrics.Sampler {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.sysMetrics
}

// deliverSystemMetrics writes one sample to each due watcher. It runs on the
// sampler goroutine, so it never blocks: a watcher whose stream queue is full
// misses this sample and gets the next one (each sample is a complete
// snapshot, so a missed one loses nothing).
func (s *Server) deliverSystemMetrics(sample types.SystemMetricsSample, due []string) {
	if len(due) == 0 {
		return
	}
	evt := types.EngineEvent{Type: "engine_system_metrics", SystemMetrics: &sample}
	raw, err := json.Marshal(evt)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "server.system_metrics", "sample marshal failed", map[string]any{"error": err.Error()})
		return
	}
	payload := []byte(protocol.SerializeServerEvent("", json.RawMessage(raw)))

	wanted := make(map[string]bool, len(due))
	for _, id := range due {
		wanted[id] = true
	}
	s.mu.RLock()
	targets := make([]*clientWriter, 0, len(due))
	for _, cw := range s.clients {
		if wanted[cw.id] {
			targets = append(targets, cw)
		}
	}
	s.mu.RUnlock()

	for _, cw := range targets {
		select {
		case cw.streamQueue <- payload:
		case <-cw.done:
		default:
			utils.LogWithFields(utils.LevelDebug, "server.system_metrics", "sample skipped: client stream queue full", map[string]any{
				"connection_id": cw.id,
			})
		}
	}
	utils.LogWithFields(utils.LevelDebug, "server.system_metrics", "sample delivered", map[string]any{
		"due": len(due), "delivered_to": len(targets),
	})
}

// connectionID returns the id of the client writer for conn.
func (s *Server) connectionID(conn net.Conn) (string, bool) {
	if conn == nil {
		return "", false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	cw, ok := s.clients[conn]
	if !ok {
		return "", false
	}
	return cw.id, true
}

// dispatchGetSystemMetrics answers get_system_metrics with the latest
// complete sample, taking one now if none exists yet.
func (s *Server) dispatchGetSystemMetrics(conn net.Conn, cmd *protocol.ClientCommand) {
	sampler := s.SystemMetrics()
	if sampler == nil {
		utils.LogWithFields(utils.LevelInfo, "server.system_metrics", "get_system_metrics refused: sampling disabled", map[string]any{"request_id": cmd.RequestID})
		s.sendResult(conn, cmd, fmt.Errorf("system metrics are disabled"), nil)
		return
	}
	sample := sampler.Current()
	utils.LogWithFields(utils.LevelDebug, "server.system_metrics", "get_system_metrics answered", map[string]any{
		"request_id": cmd.RequestID, "sampled_at": sample.SampledAt, "process_count": len(sample.Processes),
	})
	s.sendResult(conn, cmd, nil, sample)
}

// dispatchSystemMetricsWatch starts, changes, or stops this connection's
// watch. The result carries the interval actually in effect (clamped to the
// configured bounds; 0 when stopped).
func (s *Server) dispatchSystemMetricsWatch(conn net.Conn, cmd *protocol.ClientCommand) {
	sampler := s.SystemMetrics()
	if sampler == nil {
		utils.LogWithFields(utils.LevelInfo, "server.system_metrics", "system_metrics_watch refused: sampling disabled", map[string]any{"request_id": cmd.RequestID})
		s.sendResult(conn, cmd, fmt.Errorf("system metrics are disabled"), nil)
		return
	}
	id, ok := s.connectionID(conn)
	if !ok {
		// A relay-dispatched command has no socket to deliver samples to.
		utils.LogWithFields(utils.LevelInfo, "server.system_metrics", "system_metrics_watch refused: no socket connection", map[string]any{"request_id": cmd.RequestID})
		s.sendResult(conn, cmd, fmt.Errorf("system_metrics_watch needs a socket connection"), nil)
		return
	}
	sampler.Watch(id, cmd.IntervalMs, func(eff int64, watchers int) {
		s.sendResult(conn, cmd, nil, map[string]any{"intervalMs": eff, "watchers": watchers})
	})
}

// unwatchSystemMetrics ends a disconnecting connection's watch.
func (s *Server) unwatchSystemMetrics(connectionID string) {
	if sampler := s.SystemMetrics(); sampler != nil {
		sampler.Unwatch(connectionID)
	}
}

// telemetryHealthSnapshot is the current delivery health of every telemetry
// collector, keyed by collector. Only collectors with a network target
// appear.
func (s *Server) telemetryHealthSnapshot() map[string]any {
	out := map[string]any{}
	if h := s.Telemetry().TelemetryHealthSnapshot(); len(h) > 0 {
		out["telemetry"] = h
	}
	if h := s.ConversationEventsTelemetry().TelemetryHealthSnapshot(); len(h) > 0 {
		out["conversationEvents"] = h
	}
	return out
}
