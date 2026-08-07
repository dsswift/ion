package server

import (
	"encoding/json"
	"fmt"
	"net"

	"github.com/dsswift/ion/engine/internal/modelconfig"
	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// dispatchResolveModelTier retains single-tier lookup for consumers that only
// need to gate one feature. Tier administration uses snapshot commands below.
func (s *Server) dispatchResolveModelTier(conn net.Conn, cmd *protocol.ClientCommand) {
	entry, configured := modelconfig.LookupTier(cmd.Text)
	var model string
	var fallbacks []string
	if configured {
		model, fallbacks = entry.Model, entry.Fallbacks
	} else {
		model, fallbacks = modelconfig.ResolveTierChain(cmd.Text)
		if fallbacks == nil {
			fallbacks = []string{}
		}
	}
	s.sendResult(conn, cmd, nil, map[string]interface{}{
		"tier": cmd.Text, "model": model, "fallbacks": fallbacks, "configured": configured,
	})
	utils.LogWithFields(utils.LevelInfo, "server.model_tiers", "model tier resolved", map[string]any{
		"tier": cmd.Text, "model": model, "configured": configured, "fallbacks": len(fallbacks),
	})
}

// dispatchListModelTiers sends the complete snapshot to caller and result.
func (s *Server) dispatchListModelTiers(conn net.Conn, cmd *protocol.ClientCommand) {
	evt := s.modelTiersEvent()
	s.emitModelTiersTo(conn, cmd.Key, evt)
	s.sendResult(conn, cmd, nil, map[string]any{"tiers": evt.ModelTiers})
	utils.LogWithFields(utils.LevelInfo, "server.model_tiers", "model tier snapshot delivered", map[string]any{"count": len(evt.ModelTiers)})
}

func (s *Server) dispatchSetModelTier(conn net.Conn, cmd *protocol.ClientCommand) {
	entry, err := modelconfig.SetTier(cmd.Text, cmd.Model, cmd.Fallbacks)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "server.model_tiers", "model tier rejected", map[string]any{"tier": cmd.Text, "error": err.Error()})
		s.sendResult(conn, cmd, err, nil)
		return
	}
	s.sendResult(conn, cmd, nil, map[string]any{"modelTier": entry})
	s.broadcastModelTiers()
	utils.LogWithFields(utils.LevelInfo, "server.model_tiers", "model tier persisted", map[string]any{"tier": entry.Name, "model": entry.Model, "fallbacks": len(entry.Fallbacks)})
}

func (s *Server) dispatchRemoveModelTier(conn net.Conn, cmd *protocol.ClientCommand) {
	removed, err := modelconfig.RemoveTier(cmd.Text)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "server.model_tiers", "model tier removal failed", map[string]any{"tier": cmd.Text, "error": err.Error()})
		s.sendResult(conn, cmd, err, nil)
		return
	}
	if !removed {
		err := fmt.Errorf("model tier %q does not exist", cmd.Text)
		utils.LogWithFields(utils.LevelWarn, "server.model_tiers", "model tier removal rejected", map[string]any{"tier": cmd.Text})
		s.sendResult(conn, cmd, err, nil)
		return
	}
	s.sendResult(conn, cmd, nil, map[string]any{"tier": cmd.Text})
	s.broadcastModelTiers()
	utils.LogWithFields(utils.LevelInfo, "server.model_tiers", "model tier removed", map[string]any{"tier": cmd.Text})
}

func (s *Server) modelTiersEvent() types.EngineEvent {
	return types.EngineEvent{Type: types.EventModelTiers, ModelTiers: modelconfig.ListTiers()}
}

func (s *Server) emitModelTiersTo(conn net.Conn, key string, evt types.EngineEvent) {
	raw, err := json.Marshal(evt)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "server.model_tiers", "model tier event marshal failed", map[string]any{"error": err.Error()})
		return
	}
	s.writeToClient(conn, protocol.SerializeServerEvent(key, json.RawMessage(raw)))
}

func (s *Server) broadcastModelTiers() {
	evt := s.modelTiersEvent()
	raw, err := json.Marshal(evt)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "server.model_tiers", "model tier snapshot marshal failed", map[string]any{"error": err.Error()})
		return
	}
	s.broadcast(protocol.SerializeServerEvent("", json.RawMessage(raw)), evt.Type)
	utils.LogWithFields(utils.LevelInfo, "server.model_tiers", "model tier snapshot broadcast", map[string]any{"count": len(evt.ModelTiers)})
}
