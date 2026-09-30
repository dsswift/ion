// dispatch_provider_subscription.go — Provider Subscription commands.
//
// The engine resolves a provider's key from the subscriptionLookup endpoint
// with the signed-in identity (internal/subscription). These handlers expose
// its state and the two operator actions over the wire. The key itself never
// crosses the wire: the snapshot names subscriptions by id and label only.
package server

import (
	"encoding/json"
	"fmt"
	"net"

	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/subscription"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// SetSubscriptionManager installs the Provider Subscription manager. Nil
// (the default) means no subscriptionLookup is configured.
func (s *Server) SetSubscriptionManager(m *subscription.Manager) {
	s.mu.Lock()
	s.subscription = m
	s.mu.Unlock()
}

func (s *Server) subscriptionManager() *subscription.Manager {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.subscription
}

// providerSubscriptionStatus is the current snapshot, or the disabled state
// when no lookup is configured.
func (s *Server) providerSubscriptionStatus() types.ProviderSubscriptionStatus {
	if m := s.subscriptionManager(); m != nil {
		return m.Status()
	}
	return types.ProviderSubscriptionStatus{State: types.SubscriptionStateDisabled}
}

// dispatchProviderSubscription answers status at once. select and refresh
// may call the lookup endpoint, so they settle on their own goroutine and
// answer when done; the read loop never waits on the network.
func (s *Server) dispatchProviderSubscription(conn net.Conn, cmd *protocol.ClientCommand) {
	if cmd.Cmd == "provider_subscription_status" {
		s.answerProviderSubscription(conn, cmd, s.providerSubscriptionStatus(), nil)
		return
	}
	m := s.subscriptionManager()
	if m == nil {
		utils.LogWithFields(utils.LevelInfo, "server.subscription", "subscription command refused: lookup not configured", map[string]any{"status": cmd.Cmd})
		s.answerProviderSubscription(conn, cmd, s.providerSubscriptionStatus(), fmt.Errorf("no subscription lookup configured (set subscriptionLookup in engine.json)"))
		return
	}
	command, id := cmd.Cmd, cmd.SubscriptionID
	go func() {
		var status types.ProviderSubscriptionStatus
		var err error
		if command == "provider_subscription_select" {
			status, err = m.Select(id)
		} else {
			status, err = m.Refresh()
		}
		fields := map[string]any{"status": command, "state": status.State, "subscription_id": id}
		if err != nil {
			fields["error"] = err.Error()
			utils.LogWithFields(utils.LevelWarn, "server.subscription", "subscription command failed", fields)
		} else {
			utils.LogWithFields(utils.LevelInfo, "server.subscription", "subscription command settled", fields)
		}
		s.answerProviderSubscription(conn, cmd, status, err)
	}()
}

// answerProviderSubscription delivers the snapshot to the requester as an
// event and in the result payload, error or not, so a consumer always holds
// the state the command left.
func (s *Server) answerProviderSubscription(conn net.Conn, cmd *protocol.ClientCommand, status types.ProviderSubscriptionStatus, err error) {
	if line, ok := providerSubscriptionLine(cmd.Key, status); ok {
		s.writeToClient(conn, line)
	}
	s.sendResult(conn, cmd, err, map[string]any{"subscription": status})
}

// BroadcastProviderSubscription sends a snapshot to every client. The
// manager calls it on each state change.
func (s *Server) BroadcastProviderSubscription(status types.ProviderSubscriptionStatus) {
	line, ok := providerSubscriptionLine("", status)
	if !ok {
		return
	}
	s.broadcast(line, types.EventProviderSubscription)
}

func providerSubscriptionLine(key string, status types.ProviderSubscriptionStatus) (string, bool) {
	raw, err := json.Marshal(types.EngineEvent{Type: types.EventProviderSubscription, ProviderSubscription: &status})
	if err != nil {
		utils.LogWithFields(utils.LevelError, "server.subscription", "subscription event marshal failed", map[string]any{"error": err.Error()})
		return "", false
	}
	return protocol.SerializeServerEvent(key, json.RawMessage(raw)), true
}
