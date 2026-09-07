package server

import (
	"encoding/json"
	"net"

	"github.com/dsswift/ion/engine/internal/modelconfig"
	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// dispatchGetDefaultProvider sends the current default-provider snapshot to the
// caller and echoes it in the command result.
func (s *Server) dispatchGetDefaultProvider(conn net.Conn, cmd *protocol.ClientCommand) {
	evt := s.defaultProviderEvent()
	s.emitDefaultProviderTo(conn, cmd.Key, evt)
	s.sendResult(conn, cmd, nil, map[string]any{"defaultProvider": *evt.DefaultProvider})
	utils.LogWithFields(utils.LevelInfo, "server.default_provider", "default provider snapshot delivered", map[string]any{"provider": *evt.DefaultProvider})
}

// dispatchSetDefaultProvider persists the preference. An empty cmd.Text clears
// it, reverting bare-model resolution to the unbiased registry/prefix chain.
func (s *Server) dispatchSetDefaultProvider(conn net.Conn, cmd *protocol.ClientCommand) {
	provider, err := modelconfig.SetDefaultProvider(cmd.Text)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "server.default_provider", "default provider write failed", map[string]any{"provider": cmd.Text, "error": err.Error()})
		s.sendResult(conn, cmd, err, nil)
		return
	}
	s.sendResult(conn, cmd, nil, map[string]any{"defaultProvider": provider})
	s.broadcastDefaultProvider()
	utils.LogWithFields(utils.LevelInfo, "server.default_provider", "default provider persisted", map[string]any{"provider": provider, "cleared": provider == ""})
}

func (s *Server) defaultProviderEvent() types.EngineEvent {
	provider := modelconfig.DefaultProviderID()
	return types.EngineEvent{Type: types.EventDefaultProvider, DefaultProvider: &provider}
}

func (s *Server) emitDefaultProviderTo(conn net.Conn, key string, evt types.EngineEvent) {
	raw, err := json.Marshal(evt)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "server.default_provider", "default provider event marshal failed", map[string]any{"error": err.Error()})
		return
	}
	s.writeToClient(conn, protocol.SerializeServerEvent(key, json.RawMessage(raw)))
}

func (s *Server) broadcastDefaultProvider() {
	evt := s.defaultProviderEvent()
	raw, err := json.Marshal(evt)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "server.default_provider", "default provider snapshot marshal failed", map[string]any{"error": err.Error()})
		return
	}
	s.broadcast(protocol.SerializeServerEvent("", json.RawMessage(raw)), evt.Type)
	utils.LogWithFields(utils.LevelInfo, "server.default_provider", "default provider snapshot broadcast", map[string]any{"provider": *evt.DefaultProvider})
}
