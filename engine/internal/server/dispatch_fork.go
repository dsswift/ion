package server

import (
	"net"

	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/utils"
)

func (s *Server) dispatchForkSession(conn net.Conn, cmd *protocol.ClientCommand) {
	idx := 0
	if cmd.MessageIndex != nil {
		idx = *cmd.MessageIndex
	}
	var newKey, conversationID string
	var err error
	if cmd.EntryID != "" || cmd.UserTurnIndex != nil {
		if cmd.UserTurnIndex != nil {
			idx = *cmd.UserTurnIndex
		}
		newKey, conversationID, err = s.manager.ForkSessionBeforeUserTurn(cmd.Key, cmd.NewKey, cmd.EntryID, idx)
	} else {
		newKey, conversationID, err = s.manager.ForkSessionToKey(cmd.Key, cmd.NewKey, idx)
	}
	s.sendForkResult(conn, cmd, err, newKey, conversationID)
}

// sendForkResult sends a fork response with the new session key and durable
// conversation ID at the top level and in the common data envelope.
func (s *Server) sendForkResult(conn net.Conn, cmd *protocol.ClientCommand, err error, newKey, conversationID string) {
	if cmd.RequestID == "" {
		return
	}
	if s.lifecycle != nil && !s.lifecycle.claimResult(cmd) {
		utils.LogWithFields(utils.LevelDebug, "server", "late command result suppressed", map[string]any{
			"status": cmd.Cmd, "request_id": cmd.RequestID, "session_id": cmd.Key,
		})
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
		result.ConversationID = conversationID
		result.Data = map[string]string{"newKey": newKey, "conversationId": conversationID}
	}
	line := protocol.SerializeServerResult(result)
	s.writeToClient(conn, line)
}
