// dispatch_resource.go handles the resource_subscribe, resource_unsubscribe,
// and resource_publish client commands.
//
// resource_subscribe:
//   - When resourceGlobal is true, uses the Manager's global broker.
//   - Otherwise locates the session's broker via Manager.ResourceBroker.
//   - Calls broker.Subscribe (or SubscribeDirect for global), which delivers
//     a snapshot synchronously and fans out subsequent deltas.
//   - Returns {"subscriptionId": "<id>"}.
//
// resource_unsubscribe:
//   - Calls broker.Unsubscribe by ID on both session and global brokers.
//
// resource_publish:
//   - Lets socket clients (desktop, iOS) publish resources through the broker.
//   - Routes to global broker when resourceItem has no conversationId,
//     or to the session broker when it does.

package server

import (
	"encoding/json"
	"fmt"
	"net"

	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/resource"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

func (s *Server) dispatchResourceSubscribe(conn net.Conn, cmd *protocol.ClientCommand) {
	if cmd.ResourceKind == "" {
		s.sendResult(conn, cmd, fmt.Errorf("resource_subscribe: resourceKind is required"), nil)
		return
	}

	filter := types.ResourceFilter{Kind: cmd.ResourceKind}
	if cmd.ResourceFilter != nil {
		filter = *cmd.ResourceFilter
		filter.Kind = cmd.ResourceKind
	}

	wildcard := resource.IsWildcard(cmd.ResourceKind)

	// Global subscription: use the Manager-level broker.
	if cmd.ResourceGlobal {
		broker := s.manager.GlobalResourceBroker()
		if broker == nil {
			s.sendResult(conn, cmd, fmt.Errorf("resource_subscribe: global broker not available"), nil)
			return
		}
		var sub *resource.Subscription
		if wildcard {
			// Register before querying producer-owned storage. The broker buffers
			// concurrent deltas until these snapshots have been delivered, so a
			// stale query result can never overwrite a newer live update.
			sub = broker.SubscribeDirectWildcard(filter, func(msg resource.ResourceMessage) {
				s.deliverResourceEvent(conn, cmd.Key, msg)
			}, func(subscriptionID string) []resource.ResourceMessage {
				snapshots := s.manager.WorkspaceResourceSnapshots(filter)
				messages := make([]resource.ResourceMessage, 0, len(snapshots))
				for _, snapshot := range snapshots {
					messages = append(messages, resource.ResourceMessage{
						Type: "snapshot", Kind: snapshot.Kind, SubID: subscriptionID,
						Items: snapshot.Items, Producers: snapshot.Producers,
					})
				}
				return messages
			})
			utils.LogWithFields(utils.LevelInfo, "server", "resource subscribe global wildcard", map[string]any{"run_id": sub.ID})
		} else {
			sub = broker.SubscribeDirectWithSnapshot(cmd.ResourceKind, filter, func(msg resource.ResourceMessage) {
				s.deliverResourceEvent(conn, cmd.Key, msg)
			}, func(subscriptionID string) []resource.ResourceMessage {
				snapshots := s.manager.WorkspaceResourceSnapshots(filter)
				if len(snapshots) == 0 {
					return []resource.ResourceMessage{{Type: "snapshot", Kind: cmd.ResourceKind, SubID: subscriptionID}}
				}
				snapshot := snapshots[0]
				return []resource.ResourceMessage{{
					Type: "snapshot", Kind: snapshot.Kind, SubID: subscriptionID,
					Items: snapshot.Items, Producers: snapshot.Producers,
				}}
			})
			utils.LogWithFields(utils.LevelInfo, "server", "resource subscribe global kind", map[string]any{"reason": cmd.ResourceKind, "run_id": sub.ID})
		}
		s.sendResult(conn, cmd, nil, map[string]string{"subscriptionId": sub.ID})
		return
	}

	// Per-session subscription.
	broker := s.manager.ResourceBroker(cmd.Key)
	if broker == nil {
		s.sendResult(conn, cmd, fmt.Errorf("resource_subscribe: no session or broker for key %q", cmd.Key), nil)
		return
	}

	// Per-session wildcard: aggregate a snapshot across every registered
	// producer and stream all future kinds. Never errors on "no producer".
	if wildcard {
		sub := broker.SubscribeWildcard(filter, func(msg resource.ResourceMessage) {
			s.deliverResourceEvent(conn, cmd.Key, msg)
		})
		utils.LogWithFields(utils.LevelInfo, "server", "resource subscribe session wildcard", map[string]any{"session_id": cmd.Key, "run_id": sub.ID})
		s.sendResult(conn, cmd, nil, map[string]string{"subscriptionId": sub.ID})
		return
	}

	sub, err := broker.Subscribe(cmd.ResourceKind, filter, func(msg resource.ResourceMessage) {
		s.deliverResourceEvent(conn, cmd.Key, msg)
	})
	if err != nil {
		s.sendResult(conn, cmd, err, nil)
		return
	}

	s.sendResult(conn, cmd, nil, map[string]string{"subscriptionId": sub.ID})
}

func (s *Server) dispatchResourceUnsubscribe(conn net.Conn, cmd *protocol.ClientCommand) {
	if cmd.ResourceSubID == "" {
		s.sendResult(conn, cmd, fmt.Errorf("resource_unsubscribe: resourceSubId is required"), nil)
		return
	}

	// Try session broker first, then global broker.
	broker := s.manager.ResourceBroker(cmd.Key)
	if broker != nil {
		broker.Unsubscribe(cmd.ResourceSubID)
	}
	if gb := s.manager.GlobalResourceBroker(); gb != nil {
		gb.Unsubscribe(cmd.ResourceSubID)
	}
	s.sendResult(conn, cmd, nil, nil)
}

func (s *Server) dispatchResourcePublish(conn net.Conn, cmd *protocol.ClientCommand) {
	if cmd.ResourceKind == "" {
		s.sendResult(conn, cmd, fmt.Errorf("resource_publish: resourceKind is required"), nil)
		return
	}
	if cmd.ResourceOp == "" {
		s.sendResult(conn, cmd, fmt.Errorf("resource_publish: resourceOp is required"), nil)
		return
	}
	if cmd.ResourceItem == nil {
		s.sendResult(conn, cmd, fmt.Errorf("resource_publish: resourceItem is required"), nil)
		return
	}

	delta := types.ResourceDelta{
		Op:   cmd.ResourceOp,
		Item: *cmd.ResourceItem,
	}
	// Socket clients can target an existing producer, but cannot claim a
	// producer inside the nested item envelope.
	delta.Item.Producer = cmd.ResourceProducer

	// Route: no conversationId → global broker, with conversationId → session broker.
	if cmd.ResourceItem.ConversationID == "" {
		broker := s.manager.GlobalResourceBroker()
		if broker == nil {
			s.sendResult(conn, cmd, fmt.Errorf("resource_publish: global broker not available"), nil)
			return
		}
		broker.PublishDirect(cmd.ResourceKind, delta)
		utils.LogWithFields(utils.LevelDebug, "server", "resource publish global", map[string]any{"reason": cmd.ResourceKind, "status": cmd.ResourceOp, "run_id": cmd.ResourceItem.ID})
		s.sendResult(conn, cmd, nil, nil)
		return
	}

	broker := s.manager.ResourceBroker(cmd.Key)
	if broker == nil {
		s.sendResult(conn, cmd, fmt.Errorf("resource_publish: no session or broker for key %q", cmd.Key), nil)
		return
	}
	broker.PublishDirect(cmd.ResourceKind, delta)
	utils.LogWithFields(utils.LevelDebug, "server", "resource publish session", map[string]any{"reason": cmd.ResourceKind, "status": cmd.ResourceOp, "run_id": cmd.ResourceItem.ID, "session_id": cmd.Key})
	s.sendResult(conn, cmd, nil, nil)
}

// deliverResourceEvent converts a ResourceMessage to an EngineEvent and
// writes it to the client connection. Shared by both session and global
// subscription paths.
func (s *Server) deliverResourceEvent(conn net.Conn, key string, msg resource.ResourceMessage) {
	var ev types.EngineEvent
	if msg.Type == "snapshot" {
		ev = types.EngineEvent{
			Type:              "engine_resource_snapshot",
			ResourceKind:      msg.Kind,
			ResourceSubID:     msg.SubID,
			ResourceItems:     msg.Items,
			ResourceProducers: msg.Producers,
		}
	} else {
		ev = types.EngineEvent{
			Type:          "engine_resource_delta",
			ResourceKind:  msg.Kind,
			ResourceSubID: msg.SubID,
			ResourceDelta: msg.Delta,
		}
	}
	raw, err := json.Marshal(ev)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "server", "resource event marshal error", map[string]any{"error": err.Error()})
		return
	}
	line := protocol.SerializeServerEvent(key, json.RawMessage(raw))
	s.writeToClient(conn, line)
}

// dispatchResourceGet handles the resource_get command: fetch a single item's
// full content from the registered producer, then emit engine_resource_item
// on the requesting connection.
//
// ResourceKind and ResourceID are required. ResourceGlobal selects workspace
// scope: the Manager resolves the producer through the session brokers that own
// query handlers. Otherwise the command queries the session broker named by Key.
// Returns an error result when no producer is registered or the item is not
// found; the engine_resource_item event is emitted only on success.
func (s *Server) dispatchResourceGet(conn net.Conn, cmd *protocol.ClientCommand) {
	if cmd.ResourceKind == "" {
		s.sendResult(conn, cmd, fmt.Errorf("resource_get: resourceKind is required"), nil)
		return
	}
	if cmd.ResourceID == "" {
		s.sendResult(conn, cmd, fmt.Errorf("resource_get: resourceId is required"), nil)
		return
	}

	var item *types.ResourceItem
	var err error
	if cmd.ResourceGlobal {
		item, err = s.manager.GetWorkspaceResourceItem(cmd.ResourceKind, cmd.ResourceProducer, cmd.ResourceID)
	} else {
		broker := s.manager.ResourceBroker(cmd.Key)
		if broker == nil {
			s.sendResult(conn, cmd, fmt.Errorf("resource_get: no broker for session %q", cmd.Key), nil)
			return
		}
		item, err = broker.GetItemFrom(cmd.ResourceKind, cmd.ResourceProducer, cmd.ResourceID)
	}
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "server", "resource_get: query error", map[string]any{
			"kind": cmd.ResourceKind, "id": cmd.ResourceID, "error": err.Error(),
		})
		s.sendResult(conn, cmd, err, nil)
		return
	}
	if item == nil {
		s.sendResult(conn, cmd, fmt.Errorf("resource_get: item %q not found in kind %q", cmd.ResourceID, cmd.ResourceKind), nil)
		return
	}

	ev := types.EngineEvent{
		Type:         "engine_resource_item",
		ResourceKind: cmd.ResourceKind,
		ResourceItem: item,
	}
	raw, err := json.Marshal(ev)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "server", "resource_get: marshal error", map[string]any{"error": err.Error()})
		s.sendResult(conn, cmd, fmt.Errorf("resource_get: marshal error: %w", err), nil)
		return
	}
	line := protocol.SerializeServerEvent(cmd.Key, json.RawMessage(raw))
	s.writeToClient(conn, line)
	utils.LogWithFields(utils.LevelDebug, "server", "resource_get: delivered", map[string]any{
		"kind": cmd.ResourceKind, "id": cmd.ResourceID,
	})
	s.sendResult(conn, cmd, nil, nil)
}
