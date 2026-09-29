// dispatch_resource_transfer.go handles resource_export, resource_import, and
// resource_forget: the commands a client uses to move the resources producers
// hold for a conversation to another machine. Each runs against the broker
// of the session named by Key, whose extensions are the producers.
//
//   resource_export {key, resourceConversationIds} -> {producers: []ProducerExport}
//   resource_import {key, resourceItems}           -> {items: []ItemImport}
//   resource_forget {key, resourceConversationIds} -> {producers: []ProducerForget}

package server

import (
	"fmt"
	"net"

	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/resource"
	"github.com/dsswift/ion/engine/internal/utils"
)

func (s *Server) transferBroker(conn net.Conn, cmd *protocol.ClientCommand) *resource.Broker {
	broker := s.manager.ResourceBroker(cmd.Key)
	if broker == nil {
		utils.LogWithFields(utils.LevelWarn, "server", "resource transfer: no session broker", map[string]any{"status": cmd.Cmd, "session_id": cmd.Key})
		s.sendResult(conn, cmd, fmt.Errorf("%s: no session or broker for key %q", cmd.Cmd, cmd.Key), nil)
		return nil
	}
	return broker
}

func (s *Server) dispatchResourceExport(conn net.Conn, cmd *protocol.ClientCommand) {
	broker := s.transferBroker(conn, cmd)
	if broker == nil {
		return
	}
	producers := broker.ExportConversations(cmd.ResourceConversationIDs)
	items := 0
	for _, p := range producers {
		items += len(p.Items)
	}
	utils.LogWithFields(utils.LevelInfo, "server", "resource export", map[string]any{"session_id": cmd.Key, "count": len(cmd.ResourceConversationIDs), "producers": len(producers), "items": items})
	if producers == nil {
		producers = []resource.ProducerExport{}
	}
	s.sendResult(conn, cmd, nil, map[string]any{"producers": producers})
}

func (s *Server) dispatchResourceImport(conn net.Conn, cmd *protocol.ClientCommand) {
	broker := s.transferBroker(conn, cmd)
	if broker == nil {
		return
	}
	outcomes := broker.ImportItems(cmd.ResourceItems)
	accepted := 0
	for _, o := range outcomes {
		if o.Outcome == "accepted" {
			accepted++
		}
	}
	utils.LogWithFields(utils.LevelInfo, "server", "resource import", map[string]any{"session_id": cmd.Key, "count": len(cmd.ResourceItems), "accepted": accepted})
	if outcomes == nil {
		outcomes = []resource.ItemImport{}
	}
	s.sendResult(conn, cmd, nil, map[string]any{"items": outcomes})
}

func (s *Server) dispatchResourceForget(conn net.Conn, cmd *protocol.ClientCommand) {
	broker := s.transferBroker(conn, cmd)
	if broker == nil {
		return
	}
	producers := broker.ForgetConversations(cmd.ResourceConversationIDs)
	utils.LogWithFields(utils.LevelInfo, "server", "resource forget", map[string]any{"session_id": cmd.Key, "count": len(cmd.ResourceConversationIDs), "producers": len(producers)})
	if producers == nil {
		producers = []resource.ProducerForget{}
	}
	s.sendResult(conn, cmd, nil, map[string]any{"producers": producers})
}
